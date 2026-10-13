/**
 * Writing a week's digest: choose the week's bookmarks, send them in one
 * request, store what came back, and say what was done and what it cost.
 *
 * - **The owner's to start.** Nothing calls this but `pnpm digest`, at a
 *   terminal or from the schedule the owner installed. The app never does.
 * - **Idempotent.** A week that has a digest is not written again unless
 *   asked, so a schedule that fires twice, or late, pays once.
 * - **Capped.** The request is sent only if the cap holds at the most it
 *   could cost whatever the model does (`mostOf` in `../pricing.ts`), and an
 *   attempt that brought no answer is held against the cap as if it had
 *   been charged in full.
 * - **One at a time.** Core lets one run be open, so no week is paid for
 *   twice by two runs side by side.
 *
 * What it writes to a report or a log is counts, tokens and money. The
 * digest's own text goes to the library, through `finishDigestRun`, and
 * nowhere else.
 */
import {
  type Bookmark,
  type DigestRun,
  DigestRunInProgress,
  type DigestText,
  finishDigestRun,
  getDigest,
  listBookmarks,
  listDigestRuns,
  MAX_PAGE_SIZE,
  type Store,
  startDigestRun,
  type TokenUsage,
  type Week,
} from "@x-bookmarks/core";
import { type Claude, ClaudeFailure } from "../anthropic.ts";
import type { ClassifierInput } from "../input.ts";
import { CHARACTERS_PER_TOKEN, costOf, mostOf, totalsOf } from "../pricing.ts";
import { usageOf } from "../request.ts";
import {
  digestInput,
  digestPostOf,
  MAX_DIGEST_BOOKMARKS,
  MIN_DIGEST_BOOKMARKS,
  wasCut,
  worthSending,
} from "./input.ts";
import {
  DIGEST_INSTRUCTIONS_VERSION,
  DIGEST_MAX_OUTPUT_TOKENS,
  DIGEST_MODEL,
} from "./instructions.ts";
import { digestRequestFor, digestSizeOf, readDigest } from "./request.ts";

/** The most one digest may spend, in US dollars, unless told otherwise. */
export const DEFAULT_DIGEST_CAP_USD = 0.5;

/** A week's bookmarks, oldest first, removed ones left out: what the page lists, in the order it was saved. */
function bookmarksOf(store: Store, week: Week): Bookmark[] {
  const bookmarks: Bookmark[] = [];
  let after: string | undefined;
  do {
    const page = listBookmarks(store, {
      bookmarkedSince: week.start,
      bookmarkedBefore: week.end,
      order: "oldest",
      limit: MAX_PAGE_SIZE,
      after,
    });
    bookmarks.push(...page.bookmarks);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined);
  return bookmarks;
}

/** The most a request for these posts could cost, or infinity for one too large to price. */
function mostFor(posts: readonly ClassifierInput[]): number {
  try {
    return mostOf(
      digestSizeOf(digestInput(posts)),
      "direct",
      DIGEST_MODEL,
      DIGEST_MAX_OUTPUT_TOKENS,
    );
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

interface Chosen {
  inWeek: number;
  /** Those with something in them for a model to read. */
  sendable: number;
  /** The bookmarks to send, oldest first, with what is sent of each. */
  sent: { postId: string; post: ClassifierInput }[];
  mostUsd: number;
  /** The most it would cost to send every sendable bookmark the limit on their number allows. */
  mostForAllUsd: number;
}

/**
 * The bookmarks of a week that a digest is written from: those worth
 * sending, the most recent `MAX_DIGEST_BOOKMARKS` of them, and of those as
 * many of the most recent as the cap admits.
 */
function choose(store: Store, week: Week, capUsd: number): Chosen {
  const bookmarks = bookmarksOf(store, week);
  const sendable = bookmarks
    .map((bookmark) => ({
      postId: bookmark.postId,
      post: digestPostOf(bookmark),
    }))
    .filter(({ post }) => worthSending(post));
  let sent = sendable.slice(-MAX_DIGEST_BOOKMARKS);
  const mostForAllUsd =
    sent.length === 0 ? 0 : mostFor(sent.map(({ post }) => post));
  let mostUsd = mostForAllUsd;
  while (sent.length > 0 && mostUsd > capUsd) {
    sent = sent.slice(1);
    mostUsd = sent.length === 0 ? 0 : mostFor(sent.map(({ post }) => post));
  }
  return {
    inWeek: bookmarks.length,
    sendable: sendable.length,
    sent,
    mostUsd,
    mostForAllUsd,
  };
}

/** What the answer and the thinking before it come to, as a range that grows a little with the week. */
const outputTokens = (posts: number) => ({
  few: Math.min(DIGEST_MAX_OUTPUT_TOKENS, 700 + 20 * posts),
  many: Math.min(DIGEST_MAX_OUTPUT_TOKENS, 2500 + 80 * posts),
});

/** Tokens the API adds around what is sent. */
const FRAMING_TOKENS = { few: 150, many: 1000 };

export interface DigestEstimate {
  inputTokens: { few: number; many: number };
  outputTokens: { few: number; many: number };
  costUsd: { few: number; many: number };
}

function estimateFor(posts: readonly ClassifierInput[]): DigestEstimate {
  const { characters } = digestSizeOf(digestInput(posts));
  const output = outputTokens(posts.length);
  const side = (which: "few" | "many") => {
    const inputTokens = Math.round(
      characters / CHARACTERS_PER_TOKEN[which] + FRAMING_TOKENS[which],
    );
    return {
      inputTokens,
      costUsd: costOf(
        {
          inputTokens,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
          outputTokens: output[which],
        },
        "direct",
        DIGEST_MODEL,
      ),
    };
  };
  const few = side("few");
  const many = side("many");
  return {
    inputTokens: { few: few.inputTokens, many: many.inputTokens },
    outputTokens: output,
    costUsd: { few: few.costUsd, many: many.costUsd },
  };
}

/** What writing a week's digest would do, worked out from the library alone. */
export interface DigestPlan {
  week: Week;
  /** Bookmarks made in the week that are still bookmarks. */
  bookmarksInWeek: number;
  /** Of those: the ones with nothing in them worth sending. */
  tooLittleToSend: number;
  /** How many would be sent. */
  toSend: number;
  /** Bookmarks worth sending that would be left out, the oldest of the week: over the limit on their number, or over the cap. */
  leftOut: number;
  /** Of those sent: the ones whose text is longer than is sent, and is cut. */
  cut: number;
  /** Whether there are enough to write a digest from: `MIN_DIGEST_BOOKMARKS`. */
  enough: boolean;
  /** What the request is likely to use and cost, as a range. Null when nothing would be sent. */
  estimate: DigestEstimate | null;
  capUsd: number;
  /** The most the request could cost whatever the model does. */
  mostUsd: number;
  /** The most it would cost with none left out: the cap that sends them all. */
  mostForAllUsd: number;
  /** The digest the week already has, if one was written. */
  existing: {
    writtenAt: Date;
    bookmarks: number;
    costUsd: number;
    instructionsVersion: number;
  } | null;
  /** What the latest digest written by this model cost, for any week: the API's own count in place of a guess. */
  measured: { week: string; bookmarks: number; costUsd: number } | null;
}

export interface PlanDigestOptions {
  week: Week;
  capUsd?: number | undefined;
}

/**
 * Works out what writing a week's digest would send and cost. It reads the
 * library and writes nothing; it makes no request and needs no key.
 */
export function planDigest(
  store: Store,
  options: PlanDigestOptions,
): DigestPlan {
  const capUsd = options.capUsd ?? DEFAULT_DIGEST_CAP_USD;
  const chosen = choose(store, options.week, capUsd);
  const posts = chosen.sent.map(({ post }) => post);
  const existing = getDigest(store, options.week.key);
  const measured = listDigestRuns(store, { limit: 100 }).find(
    (run) => run.outcome === "written" && run.model === DIGEST_MODEL,
  );
  return {
    week: options.week,
    bookmarksInWeek: chosen.inWeek,
    tooLittleToSend: chosen.inWeek - chosen.sendable,
    toSend: posts.length,
    leftOut: chosen.sendable - posts.length,
    cut: posts.filter(wasCut).length,
    enough: posts.length >= MIN_DIGEST_BOOKMARKS,
    estimate: posts.length === 0 ? null : estimateFor(posts),
    capUsd,
    mostUsd: chosen.mostUsd,
    mostForAllUsd: chosen.mostForAllUsd,
    existing:
      existing === undefined
        ? null
        : {
            writtenAt: existing.finishedAt,
            bookmarks: existing.postIds.length,
            costUsd: existing.costUsd,
            instructionsVersion: existing.instructionsVersion,
          },
    measured:
      measured === undefined
        ? null
        : {
            week: measured.week,
            bookmarks: measured.postIds.length,
            costUsd: measured.costUsd,
          },
  };
}

export interface WriteDigestOptions {
  week: Week;
  /**
   * The client, asked for only once it is certain a request will be made:
   * a week that has its digest, or too few bookmarks for one, needs no
   * client and so no key.
   */
  claude: () => Claude;
  /** `owner` at a terminal; `schedule` for the launchd job the owner installed. */
  startedBy: "owner" | "schedule";
  /** The most this run may spend, in US dollars. */
  capUsd: number;
  /** Write the week's digest again though it has one. */
  again?: boolean | undefined;
  /** Waits. Replaced in tests, which do not have seconds to spare. */
  wait?: ((milliseconds: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

/** What a run did. Counts, tokens and money: nothing a post or the model said. */
export interface DigestReport {
  /**
   * `written`: the week has a new digest. `already-written`: it had one,
   * and was not asked to write it again. `too-few`: the week holds fewer
   * bookmarks worth sending than a digest is written from. `over-cap`: not
   * even that few fit under the cap. `failed`: the request came to
   * nothing; `failure` says how. `busy`: another run is open.
   *
   * Only `written` and `failed` sent anything.
   */
  status:
    | "written"
    | "already-written"
    | "too-few"
    | "over-cap"
    | "failed"
    | "busy";
  week: Week;
  /** The run's record in the library, when one was opened; for `already-written`, the run that wrote the digest there is. */
  run: DigestRun | null;
  bookmarksInWeek: number;
  /** How many were sent, or would have been. */
  sent: number;
  /** Bookmarks worth sending that were left out: over the limit on their number, or over the cap. */
  leftOut: number;
  usage: TokenUsage;
  /** What the answer cost, from the tokens the API reported. */
  costUsd: number;
  capUsd: number;
  /** The most the request could have cost. */
  mostUsd: number;
  /** Attempts that brought no answer back, each of which the API may have charged for. Not in `costUsd`. */
  unanswered: number;
  /** Why a failed run failed: a code, and a sentence fit to show. */
  failure: { kind: string; message: string } | null;
}

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** The request is tried this many times when the API is away or busy, with these waits between. */
const ATTEMPTS = 3;
const PAUSES_MS = [5_000, 30_000];
/** Failures that may pass: the API could not be reached, was overloaded, or was pacing this key. */
const MAY_PASS = new Set<ClaudeFailure["kind"]>([
  "unreachable",
  "unavailable",
  "rate-limited",
]);

/**
 * What the owner is told when the API was away. The client's own words for
 * these are about classifying; a digest has nothing half done to speak of.
 */
const AWAY: Partial<Record<ClaudeFailure["kind"], string>> = {
  unreachable:
    "The Claude API could not be reached. Run the command again later.",
  "rate-limited":
    "The Claude API's rate limit was reached and stayed reached through the retries (429). Run the command again later.",
};

const ANSWER_FAILURES = {
  refused:
    "The model declined to write this week's digest. Nothing was stored; the tokens it used are in the cost.",
  "cut-short":
    "The digest ran out of room before it was complete. Nothing was stored; the tokens it used are in the cost.",
  "invalid-output":
    "The model's answer was not a digest in the shape asked for. Nothing was stored; the tokens it used are in the cost.",
};

/**
 * Writes a week's digest and stores it. Never throws for something the API
 * did: a failure is a report, and a record of what it cost.
 */
export async function writeDigest(
  store: Store,
  options: WriteDigestOptions,
): Promise<DigestReport> {
  const { week, capUsd } = options;
  const now = options.now ?? (() => new Date());
  const wait = options.wait ?? sleep;
  const chosen = choose(store, week, capUsd);
  const report = (
    status: DigestReport["status"],
    parts: Partial<DigestReport> = {},
  ): DigestReport => ({
    status,
    week,
    run: null,
    bookmarksInWeek: chosen.inWeek,
    sent: chosen.sent.length,
    leftOut: chosen.sendable - chosen.sent.length,
    usage: NO_USAGE,
    costUsd: 0,
    capUsd,
    mostUsd: chosen.mostUsd,
    unanswered: 0,
    failure: null,
    ...parts,
  });

  const existing = getDigest(store, week.key);
  if (existing !== undefined && options.again !== true) {
    return report("already-written", { run: existing });
  }
  if (chosen.sendable < MIN_DIGEST_BOOKMARKS) return report("too-few");
  if (chosen.sent.length < MIN_DIGEST_BOOKMARKS) return report("over-cap");

  const claude = options.claude();
  const postIds = chosen.sent.map(({ postId }) => postId);
  const request = digestRequestFor(
    digestInput(chosen.sent.map(({ post }) => post)),
  );
  let run: DigestRun;
  try {
    run = startDigestRun(store, {
      week,
      startedBy: options.startedBy,
      model: DIGEST_MODEL,
      instructionsVersion: DIGEST_INSTRUCTIONS_VERSION,
      bookmarksInWeek: chosen.inWeek,
      postIds,
      capUsd,
      now: now(),
    });
  } catch (error) {
    if (error instanceof DigestRunInProgress) {
      return report("busy", { run: error.run });
    }
    throw error;
  }

  const lostBefore = claude.lostRequests();
  const unanswered = () => claude.lostRequests() - lostBefore;
  let usage = NO_USAGE;
  let costUsd = 0;
  /** Closes the run and reports it. */
  const end = (
    outcome:
      | { text: DigestText }
      | { failure: { kind: string; message: string } },
  ): DigestReport => {
    const closed = finishDigestRun(store, run.id, {
      ...usage,
      costUsd,
      unansweredRequests: unanswered(),
      now: now(),
      ...("text" in outcome
        ? { outcome: "written", text: outcome.text }
        : { outcome: "failed", failure: outcome.failure.kind }),
    });
    return report("text" in outcome ? "written" : "failed", {
      run: closed,
      usage,
      costUsd,
      unanswered: unanswered(),
      failure: "text" in outcome ? null : outcome.failure,
    });
  };

  try {
    for (let attempt = 1; ; attempt += 1) {
      // An attempt that went out and brought nothing back may have been
      // charged in full. The next goes only if the cap holds even so.
      if ((unanswered() + 1) * chosen.mostUsd > capUsd) {
        return end({
          failure: {
            kind: "cap",
            message:
              "An attempt went out and brought no answer back, and it may have been charged. Another would not fit under the cap, so none was made.",
          },
        });
      }
      try {
        const message = await claude.write(request);
        const used = usageOf(message);
        usage = totalsOf(used);
        costUsd = costOf(used, "direct", DIGEST_MODEL);
        const reading = readDigest(message, postIds);
        if (!reading.ok) {
          return end({
            failure: {
              kind: reading.reason,
              message: ANSWER_FAILURES[reading.reason],
            },
          });
        }
        try {
          return end({ text: reading.text });
        } catch (error) {
          // Core refused what the digest holds: a part with nothing left
          // in it once it was cleaned, say.
          if (!(error instanceof RangeError)) throw error;
          return end({
            failure: {
              kind: "invalid-output",
              message: ANSWER_FAILURES["invalid-output"],
            },
          });
        }
      } catch (error) {
        if (!(error instanceof ClaudeFailure)) throw error;
        if (!MAY_PASS.has(error.kind) || attempt >= ATTEMPTS) {
          return end({
            failure: {
              kind: error.kind,
              message: AWAY[error.kind] ?? error.message,
            },
          });
        }
        await wait(PAUSES_MS[attempt - 1] ?? 30_000);
      }
    }
  } catch (error) {
    // Something that is not the API's doing. The run is closed, so that it
    // does not stand in the way of the next, and the error is the caller's.
    try {
      end({ failure: { kind: "error", message: "The run broke off." } });
    } catch {
      // Already closed.
    }
    throw error;
  }
}
