/**
 * A run of the classifier: choose the bookmarks, send them, store each
 * answer as it comes, and say what was done and what it cost.
 *
 * - **Resumable.** An answer is stored the moment it arrives, so a run that
 *   stops, for any reason, has lost nothing, and the next one takes up what
 *   is left. A batch's id is stored before the wait for it begins, so a run
 *   interrupted during that wait collects the same batch's results instead
 *   of paying for a second.
 * - **Idempotent.** A bookmark that has an answer is not chosen again, and
 *   storing the same answer twice leaves the library as the first did.
 * - **Capped.** A run is given the most it may spend and cannot exceed it:
 *   see `mostOf` in `pricing.ts` for why that holds whatever the model does.
 *   It holds whatever the network does as well: before a request goes out,
 *   room is set aside for every attempt the client may make at it, since
 *   any attempt can be lost and charged all the same.
 * - **One at a time.** Core lets one run be open, so no bookmark is paid
 *   for twice by two runs working side by side.
 *
 * What it writes to a report, a log or the run's record is counts, ids of
 * the taxonomy, token counts and money. Nothing a post or the model said.
 */
import {
  type Bookmark,
  type ClassificationFailureReason,
  finishTaggingRun,
  finishTaggingRunWith,
  getOpenTaggingRun,
  getTaggingRun,
  getVocabulary,
  listClassificationCandidates,
  listTaggingRuns,
  listTagProposals,
  OTHER_CATEGORY,
  recordClassification,
  recordClassificationFailure,
  recordNewTags,
  recordTaggingProgress,
  resolveTag,
  type Store,
  settleTagProposals,
  startTaggingRun,
  summariseTagging,
  TAXONOMY,
  type TaggingRun,
  TaggingRunInProgress,
  TaggingRunNotOpen,
  type TaggingSummary,
  type TokenUsage,
  UNCLEAR_FORMAT,
} from "@x-bookmarks/core";
import {
  type BatchResult,
  type Claude,
  ClaudeFailure,
  type ClaudeMessage,
} from "./anthropic.ts";
import {
  type ClassifierInput,
  classifierInput,
  substanceOf,
  wasCut,
} from "./input.ts";
import { type Asking, INSTRUCTIONS_VERSION, MODEL } from "./instructions.ts";
import {
  costOf,
  type Estimate,
  estimate,
  mostOf,
  totalsOf,
} from "./pricing.ts";
import { readAnswer, requestFor, sizeOf, usageOf } from "./request.ts";
import { chooseTransport, type Transport } from "./transport.ts";

export type TaggingMode = "sample" | "untagged" | "retag" | "new-tags";

/** Which bookmarks a run takes. */
export interface Selection {
  /**
   * `sample`: a few unclassified bookmarks drawn from across the library,
   * to judge the classifier by. `untagged`: every unclassified bookmark.
   * `retag`: every bookmark classified under an older taxonomy or older
   * instructions than the current ones. `new-tags`: bookmarks classified
   * before a tag joined the vocabulary and whose text mentions it; they are
   * asked again, and of the answer only tags they had never been offered
   * are taken, so nothing else about them can change.
   */
  mode: TaggingMode;
  /**
   * With `new-tags`: every bookmark classified before some tag joined,
   * whether or not its text mentions the tag. The whole library, as a rule.
   */
  everyBookmark?: boolean | undefined;
  /** The most bookmarks to take. A sample takes `DEFAULT_SAMPLE` unless told otherwise. */
  limit?: number | undefined;
  /** Also bookmarks the classifier has already failed on twice. */
  retryFailed?: boolean | undefined;
}

export const DEFAULT_SAMPLE = 50;
/** The most a run the owner starts may spend, in US dollars, unless told otherwise. */
export const DEFAULT_CAP_USD = 2;

interface Prepared {
  bookmark: Bookmark;
  input: ClassifierInput;
  substance: ReturnType<typeof substanceOf>;
  size: ReturnType<typeof sizeOf>;
}

/** How many proposals a run is told of, so that it proposes the same subjects under the same names. */
const PROPOSALS_TOLD = 150;

/** What a run asks with: the vocabulary and the open proposals, as they stand when it begins. */
function askingWith(store: Store): Asking {
  return {
    vocabulary: getVocabulary(store),
    proposals: listTagProposals(store, { limit: PROPOSALS_TOLD }).proposals.map(
      ({ proposal }) => proposal,
    ),
  };
}

const WHICH = {
  sample: "unclassified",
  untagged: "unclassified",
  retag: "outdated",
  "new-tags": "new-tags",
} as const;

function select(
  store: Store,
  selection: Selection,
  asking: Asking,
): { candidates: number; chosen: Prepared[] } {
  const { total, bookmarks } = listClassificationCandidates(store, {
    which:
      selection.mode === "new-tags" && selection.everyBookmark === true
        ? "behind-vocabulary"
        : WHICH[selection.mode],
    instructionsVersion: INSTRUCTIONS_VERSION,
    order: selection.mode === "sample" ? "spread" : "newest",
    limit:
      selection.limit ??
      (selection.mode === "sample" ? DEFAULT_SAMPLE : undefined),
    retryFailed: selection.retryFailed,
  });
  return {
    candidates: total,
    chosen: bookmarks.map((bookmark) => {
      const input = classifierInput(bookmark);
      return {
        bookmark,
        input,
        substance: substanceOf(input),
        size: sizeOf(input, asking),
      };
    }),
  };
}

/** How many of `requests`, taken in order, fit under `capUsd` at the most each can cost. */
function fitting(
  requests: readonly Prepared[],
  transport: Transport,
  capUsd: number,
): { count: number; mostUsd: number } {
  let mostUsd = 0;
  let count = 0;
  for (const { size } of requests) {
    const most = mostOf(size, transport);
    if (mostUsd + most > capUsd) break;
    mostUsd += most;
    count += 1;
  }
  return { count, mostUsd };
}

/** What a run would do, worked out from the library alone. */
export interface TaggingPlan {
  mode: TaggingMode;
  transport: Transport;
  /** The vocabulary the run would ask with: its version, and how many tags it holds. */
  vocabulary: { version: number; tags: number };
  /** How many bookmarks the mode covers, and how many of them this run would take. */
  candidates: number;
  selected: number;
  /** Of the selected: those that would be sent to the API. */
  toSend: number;
  /** Those with nothing worth sending, which are filed as "too little text" without a request. */
  tooLittleToSend: number;
  /** Of those sent: those with so few words that the classifier is likely to say the same. */
  thin: number;
  /** Of those sent: those whose text is longer than is sent, and is cut. */
  cut: number;
  /** What sending them is likely to use and cost, as a range. */
  estimate: Estimate;
  /**
   * What sending them would cost at the rate the latest run by the same
   * route measured, when there has been one: the API's own count, in place
   * of a guess from the length of the text.
   */
  measured: { usdPerBookmark: number; costUsd: number } | null;
  capUsd: number;
  /** The most the requests could cost whatever the model does, and how many of them fit under the cap at that rate. */
  mostUsd: number;
  fitsCap: number;
}

export interface PlanOptions extends Selection {
  transport?: Transport | undefined;
  capUsd?: number | undefined;
}

/**
 * How many bookmarks a run asked the API about: those it has an answer or a
 * failure for, less those it dealt with without a request. What a bookmark
 * cost the run is its cost over these, and the plan multiplies that by the
 * bookmarks it would send, which are bookmarks of this kind.
 */
const askedBy = (run: TaggingRun) =>
  run.classified - run.filedWithoutRequest + run.failed;

/**
 * Works out what a run would do: how many bookmarks it would send, what
 * that is likely to cost, and how many hold too little to classify. It
 * reads the library and writes nothing; it makes no request and needs no
 * key.
 */
export function planTagging(store: Store, options: PlanOptions): TaggingPlan {
  const asking = askingWith(store);
  const { candidates, chosen } = select(store, options, asking);
  const sendable = chosen.filter(({ substance }) => substance !== "none");
  const transport = chooseTransport({ asked: options.transport });
  const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
  const all = fitting(sendable, transport, Number.POSITIVE_INFINITY);
  const measuredBy = listTaggingRuns(store, { limit: 20 }).find(
    (run) =>
      run.transport === transport &&
      run.model === MODEL &&
      run.outcome === "completed" &&
      askedBy(run) >= 10 &&
      run.costUsd > 0,
  );
  const usdPerBookmark =
    measuredBy === undefined ? null : measuredBy.costUsd / askedBy(measuredBy);
  return {
    mode: options.mode,
    transport,
    vocabulary: {
      version: asking.vocabulary.version,
      tags: asking.vocabulary.tags.length,
    },
    candidates,
    selected: chosen.length,
    toSend: sendable.length,
    tooLittleToSend: chosen.length - sendable.length,
    thin: sendable.filter(({ substance }) => substance === "thin").length,
    cut: sendable.filter(({ input }) => wasCut(input)).length,
    estimate: estimate(
      sendable.map(({ size }) => size),
      transport,
    ),
    measured:
      usdPerBookmark === null
        ? null
        : { usdPerBookmark, costUsd: usdPerBookmark * sendable.length },
    capUsd,
    mostUsd: all.mostUsd,
    fitsCap: fitting(sendable, transport, capUsd).count,
  };
}

export interface RunOptions extends Selection {
  claude: Claude;
  startedBy: "owner" | "app";
  /** The most this run may spend, in US dollars. */
  capUsd: number;
  /** The route, when the owner names one. Chosen by `chooseTransport` otherwise. */
  transport?: Transport | undefined;
  /**
   * How long to wait for a batch before leaving it to the next run, in
   * milliseconds. Zero looks once.
   */
  batchWaitMs?: number | undefined;
  /** Told of each change in the totals, for a progress line. */
  onProgress?: ((progress: RunProgress) => void) | undefined;
  /** Waits. Replaced in tests, which do not have a minute to spare. */
  wait?: ((milliseconds: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

export interface RunProgress {
  selected: number;
  classified: number;
  failed: number;
  costUsd: number;
  /** Set while a batch is being waited for: how many of its requests are still processing. */
  batchProcessing?: number;
}

/** What a run did. Counts, ids of the taxonomy, tokens and money. */
export interface TaggingReport {
  /**
   * `completed`: every selected bookmark was dealt with. `stopped-at-cap`:
   * the spend cap ended it first. `failed`: the API ended it; `failure`
   * says how. `waiting-for-batch`: a batch is still being processed and the
   * next run collects it. `nothing-to-do`: no bookmark was waiting.
   * `busy`: another run is open.
   */
  status:
    | "completed"
    | "stopped-at-cap"
    | "failed"
    | "waiting-for-batch"
    | "nothing-to-do"
    | "busy";
  mode: TaggingMode;
  transport: Transport | null;
  /** The run's record in the library, when one was opened. */
  run: TaggingRun | null;
  /** Whether this run took up a batch that an earlier one had submitted. */
  resumed: boolean;
  selected: number;
  /** Bookmarks that now have an answer from this run, those dealt with without a request among them. */
  classified: number;
  /**
   * Of the classified: those with nothing worth sending, dealt with without
   * a request. A run that classifies files them as "too little text"; a
   * `new-tags` run, which may only add tags, leaves them exactly as they
   * are and marks them as asked.
   */
  filedWithoutRequest: number;
  /** Bookmarks the model was asked about and gave nothing usable for, by reason. */
  failed: number;
  failures: Partial<Record<ClassificationFailureReason, number>>;
  /** Selected bookmarks this run did not get to: left for the next. */
  left: number;
  usage: TokenUsage;
  /** What the answers that arrived cost, from the tokens the API reported. */
  costUsd: number;
  capUsd: number;
  /**
   * Attempts that went out and brought no answer back, each of which the
   * API may have charged for all the same. They are in no token count, so
   * not in `costUsd`; the run held each against its cap at the most a
   * request can cost, and `heldUsd` is what that came to.
   */
  unanswered: number;
  heldUsd: number;
  /** What this run's answers were, by id. */
  categories: Record<string, number>;
  formats: Record<string, number>;
  tags: Record<string, number>;
  /** How many of this run's answers said the text was too little. */
  tooLittleText: number;
  /** How many of this run's answers suggested a tag outside the vocabulary. */
  withProposals: number;
  /** Why a failed run failed. */
  failure: { kind: string; message: string } | null;
  /** How the whole library stands after the run. */
  summary: TaggingSummary;
}

interface Tally {
  classified: number;
  filedWithoutRequest: number;
  failed: number;
  failures: Partial<Record<ClassificationFailureReason, number>>;
  usage: TokenUsage;
  costUsd: number;
  unanswered: number;
  heldUsd: number;
  categories: Record<string, number>;
  formats: Record<string, number>;
  tags: Record<string, number>;
  tooLittleText: number;
  withProposals: number;
}

const emptyTally = (): Tally => ({
  classified: 0,
  filedWithoutRequest: 0,
  failed: 0,
  failures: {},
  usage: {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  },
  costUsd: 0,
  unanswered: 0,
  heldUsd: 0,
  categories: {},
  formats: {},
  tags: {},
  tooLittleText: 0,
  withProposals: 0,
});

const count = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

interface Context {
  store: Store;
  options: RunOptions;
  run: TaggingRun;
  tally: Tally;
  now: () => Date;
  /** What this run asks with. For a batch taken up later, only its vocabulary's version is known, and is all that is needed. */
  asking: Asking | null;
  /** Whether the run only adds tags the bookmarks were never asked about, and leaves the rest of each answer. */
  onlyNewTags: boolean;
}

/**
 * The tags of an answer that the vocabulary holds now. The answer was held
 * to the vocabulary it was asked with; by the time it is stored a tag may
 * have been renamed or merged, and then it is stored under the name the
 * vocabulary now has for it, or retired, and then it is dropped.
 */
function tagsOf(store: Store, tags: readonly string[]): string[] {
  const held = new Set<string>();
  for (const tag of tags) {
    const resolved = resolveTag(store, tag);
    if (resolved !== undefined) held.add(resolved);
  }
  return [...held].slice(0, TAXONOMY.maxTagsPerPost);
}

function progressOf({ run, tally }: Context): RunProgress {
  return {
    selected: run.selected,
    classified: tally.classified,
    failed: tally.failed,
    costUsd: tally.costUsd,
  };
}

/** Where the run stands, as its record holds it. */
const standingOf = ({ tally, now }: Context) => ({
  ...tally.usage,
  classified: tally.classified,
  failed: tally.failed,
  costUsd: tally.costUsd,
  unansweredRequests: tally.unanswered,
  heldUsd: tally.heldUsd,
  filedWithoutRequest: tally.filedWithoutRequest,
  now: now(),
});

/** Writes where the run stands to its record, which is also its sign of life. */
function saveProgress(context: Context): void {
  recordTaggingProgress(context.store, context.run.id, standingOf(context));
  context.options.onProgress?.(progressOf(context));
}

/**
 * What a run is told when it finds its record closed under it. Core closes
 * a run as abandoned once it has written nothing for ten minutes, to free
 * the place of a process that died; a process that was only asleep, with
 * its computer, wakes to find another run in that place.
 */
const SET_ASIDE: Ending = {
  status: "failed",
  failure: {
    kind: "set-aside",
    message:
      "This run wrote nothing for ten minutes, was taken for dead, and another run was let start in its place. It has stopped sending, so that no bookmark is paid for twice. Every answer it had stored is kept; run again for what remains.",
  },
};

/** Adds what a message used to the run's totals, whatever came of the message. */
function spend(tally: Tally, message: ClaudeMessage, transport: Transport) {
  const used = usageOf(message);
  const totals = totalsOf(used);
  tally.usage.inputTokens += totals.inputTokens;
  tally.usage.cacheWriteTokens += totals.cacheWriteTokens;
  tally.usage.cacheReadTokens += totals.cacheReadTokens;
  tally.usage.outputTokens += totals.outputTokens;
  tally.costUsd += costOf(used, transport);
}

function fail(
  { store, tally, now }: Context,
  postId: string,
  reason: ClassificationFailureReason,
): void {
  recordClassificationFailure(store, {
    postId,
    reason,
    instructionsVersion: INSTRUCTIONS_VERSION,
    failedAt: now(),
  });
  tally.failed += 1;
  count(tally.failures, reason);
}

/** Stores the model's message for a bookmark as its classification, or as a failure to give one. */
function settle(
  context: Context,
  postId: string,
  message: ClaudeMessage,
): void {
  const { store, tally, now, run } = context;
  const reading = readAnswer(message);
  if (!reading.ok) {
    fail(context, postId, reading.reason);
    return;
  }
  const { answer } = reading;
  const tags = tagsOf(store, answer.tags);
  if (context.onlyNewTags) {
    // Asked again for the sake of tags it was never offered: those are
    // added, and the rest of the answer is let go.
    const gained = recordNewTags(store, {
      postId,
      tags,
      vocabularyVersion: run.vocabularyVersion,
    });
    tally.classified += 1;
    for (const tag of gained) count(tally.tags, tag);
    return;
  }
  recordClassification(store, {
    postId,
    ...answer,
    tags,
    instructionsVersion: INSTRUCTIONS_VERSION,
    vocabularyVersion: run.vocabularyVersion,
    model: MODEL,
    classifiedAt: now(),
  });
  tally.classified += 1;
  count(tally.categories, answer.category);
  count(tally.formats, answer.format);
  for (const tag of tags) count(tally.tags, tag);
  if (answer.tooLittleText) tally.tooLittleText += 1;
  if (answer.proposedTags.length > 0) tally.withProposals += 1;
}

/** Files a bookmark that holds nothing worth sending, without a request. */
function fileWithoutRequest(context: Context, postId: string): void {
  const { store, tally, now } = context;
  recordClassification(store, {
    postId,
    category: OTHER_CATEGORY,
    format: UNCLEAR_FORMAT,
    tags: [],
    tooLittleText: true,
    instructionsVersion: INSTRUCTIONS_VERSION,
    vocabularyVersion: context.run.vocabularyVersion,
    model: null,
    classifiedAt: now(),
  });
  tally.classified += 1;
  tally.filedWithoutRequest += 1;
  tally.tooLittleText += 1;
  count(tally.categories, OTHER_CATEGORY);
  count(tally.formats, UNCLEAR_FORMAT);
}

/**
 * In a run that may only add tags: a bookmark that holds nothing worth
 * sending is not asked, and nothing it is filed under changes. It is marked
 * as asked about the vocabulary, so that it is not taken again.
 */
function leaveAsItIs(context: Context, postId: string): void {
  recordNewTags(context.store, {
    postId,
    tags: [],
    vocabularyVersion: context.run.vocabularyVersion,
  });
  context.tally.classified += 1;
  context.tally.filedWithoutRequest += 1;
}

type Ending =
  | { status: "completed" | "stopped-at-cap" | "waiting-for-batch" }
  | { status: "failed"; failure: { kind: string; message: string } };

/** How many requests are in flight at once on the direct route. */
const CONCURRENCY = 4;
/**
 * A request the API rejects is that bookmark's failure, unless it is the
 * first answer of the run or the third rejection in a row: then the cause
 * is the request's shape or the account, and the run stops.
 */
const REJECTIONS_IN_A_ROW = 3;
/**
 * When the rate limit outlasts the client's own retries, the run waits
 * this long and asks again, this many times running, before it gives up:
 * a long run of single requests is expected to meet the limit, and meeting
 * it is not a failure. The wait is the whole run's: the requests in flight
 * meet the limit together, and that is one wait, not one each.
 */
const RATE_LIMIT_PAUSE_MS = 60_000;
const RATE_LIMIT_PAUSES = 8;

/** What a run that sends must have: the vocabulary and proposals it asks with. */
function askingOf(context: Context): Asking {
  if (context.asking === null) {
    throw new Error(
      "A run that only collects a batch has nothing to ask with.",
    );
  }
  return context.asking;
}

async function sendDirectly(
  context: Context,
  requests: readonly Prepared[],
): Promise<Ending> {
  const { options, tally } = context;
  const asking = askingOf(context);
  const wait = options.wait ?? sleep;
  const queue = [...requests];
  const attempts = options.claude.attemptsPerRequest;
  if (!Number.isInteger(attempts) || attempts < 1) {
    // Without it the sum below is no number, and no cap holds.
    throw new Error(
      "The client does not say how many attempts it makes at a request.",
    );
  }
  // An attempt that went out and brought no answer may have been charged
  // all the same. Each is held against the cap at the most a request of
  // this run can cost, though it is not in the cost the API reported.
  const dearest = Math.max(
    ...requests.map(({ size }) => mostOf(size, "direct")),
  );
  const lostBefore = options.claude.lostRequests();
  const lost = () => {
    tally.unanswered = options.claude.lostRequests() - lostBefore;
    tally.heldUsd = tally.unanswered * dearest;
    return tally.heldUsd;
  };
  let reserved = 0;
  let answered = 0;
  let rejectedInARow = 0;
  let stopped: Ending | undefined;
  // The rate limit. `pauses` counts the waits in a row with no answer
  // between them. `stretch` numbers the stretches of sending between waits,
  // so that requests sent side by side, which meet the limit together,
  // begin one wait between them: the first to come back begins it, and the
  // others, sent in the stretch it ended, only join it.
  let pauses = 0;
  let stretch = 0;
  let pausing: Promise<void> | undefined;

  /**
   * Writes where the run stands. False, and the run is to stop, when its
   * record was closed under it: another run has its place.
   */
  const alive = (): boolean => {
    try {
      saveProgress(context);
      return true;
    } catch (error) {
      if (!(error instanceof TaggingRunNotOpen)) throw error;
      stopped ??= SET_ASIDE;
      return false;
    }
  };

  /** Sends the next request. False when there is none, or the run is to stop. */
  const step = async (): Promise<boolean> => {
    // Nothing is sent while the run waits out the rate limit.
    while (pausing !== undefined) await pausing;
    if (stopped !== undefined) return false;
    const next = queue.shift();
    if (next === undefined) return false;
    // Room for every attempt the client may make at this request: it tries
    // again by itself after an attempt that brought no answer, and that
    // attempt may have been charged.
    const most = mostOf(next.size, "direct") * attempts;
    // What is spent, plus what is held for attempts already lost, plus the
    // most the requests in flight can still cost, plus the most this one
    // can: the cap holds even if every attempt of every one of them is
    // charged all it can be. A request that does not fit goes back, and
    // this worker ends; one whose request is in flight carries on when it
    // returns, so near the cap the run narrows to one request at a time
    // and ends only when not even one fits.
    if (tally.costUsd + lost() + reserved + most > options.capUsd) {
      queue.unshift(next);
      return false;
    }
    reserved += most;
    const sentIn = stretch;
    try {
      const message = await options.claude.classify(
        requestFor(next.input, "direct", asking),
      );
      spend(tally, message, "direct");
      settle(context, next.bookmark.postId, message);
      answered += 1;
      rejectedInARow = 0;
      pauses = 0;
    } catch (error) {
      if (!(error instanceof ClaudeFailure)) throw error;
      if (error.kind === "rate-limited") {
        // Not answered and not charged: it goes back, and is asked again
        // once the limit has had time to pass.
        queue.unshift(next);
        if (sentIn !== stretch) return true;
        if (pauses < RATE_LIMIT_PAUSES) {
          pauses += 1;
          stretch += 1;
          // A sign of life before the wait: a run that is waiting is not dead.
          if (!alive()) return false;
          pausing = wait(RATE_LIMIT_PAUSE_MS).finally(() => {
            pausing = undefined;
          });
          return true;
        }
      } else if (
        error.kind === "rejected" &&
        answered > 0 &&
        rejectedInARow + 1 < REJECTIONS_IN_A_ROW
      ) {
        rejectedInARow += 1;
        fail(context, next.bookmark.postId, "rejected");
        return alive();
      }
      stopped ??= {
        status: "failed",
        failure: { kind: error.kind, message: error.message },
      };
      return false;
    } finally {
      reserved -= most;
    }
    return alive();
  };

  // The first request alone: it writes the system prompt to the cache, and
  // the requests after it read it from there.
  if (await step()) {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (await step());
      }),
    );
  }
  // The last word on what went unanswered, for the run's record.
  lost();
  alive();
  return (
    stopped ?? {
      status: queue.length > 0 ? "stopped-at-cap" : "completed",
    }
  );
}

const customId = (runId: number, index: number) => `r${runId}-${index}`;

function indexOf(runId: number, id: string): number | undefined {
  const match = /^r(\d+)-(\d+)$/.exec(id);
  return match !== null && Number(match[1]) === runId
    ? Number(match[2])
    : undefined;
}

/** How often a batch is asked whether it has ended. */
const BATCH_POLL_MS = 30_000;
/** How long the owner's run waits for a batch before leaving it to the next run. */
export const DEFAULT_BATCH_WAIT_MS = 60 * 60 * 1000;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Makes a tally say what a run's record says: for a process that finds the work done by another. */
function adopt(tally: Tally, run: TaggingRun): void {
  tally.classified = run.classified;
  tally.filedWithoutRequest = run.filedWithoutRequest;
  tally.failed = run.failed;
  tally.costUsd = run.costUsd;
  tally.unanswered = run.unansweredRequests;
  tally.heldUsd = run.heldUsd;
  tally.usage = {
    inputTokens: run.inputTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    cacheReadTokens: run.cacheReadTokens,
    outputTokens: run.outputTokens,
  };
}

/**
 * Waits for the run's batch and stores its results, closing the run as
 * `outcome` with them. The results are read first, all of them, and then
 * stored as one change to the library together with the run's totals and
 * its closing: `finishTaggingRunWith`. So a collection that is interrupted
 * has stored nothing and starts again from the batch, and of two processes
 * that take up the same batch one stores it and the other finds the run
 * closed and stores nothing. Either way each result is counted once, which
 * matters for a failure: that is a count on its bookmark.
 */
async function collectBatch(
  context: Context,
  batch: { id: string; postIds: readonly string[] },
  outcome: "completed" | "stopped-at-cap" = "completed",
): Promise<Ending> {
  const { options, tally, run, store, now } = context;
  const wait = options.wait ?? sleep;
  const deadline =
    now().getTime() + (options.batchWaitMs ?? DEFAULT_BATCH_WAIT_MS);
  for (;;) {
    const status = await options.claude.batchStatus(batch.id);
    if (status.ended) break;
    options.onProgress?.({
      ...progressOf(context),
      batchProcessing: status.processing,
    });
    if (now().getTime() + BATCH_POLL_MS > deadline) {
      return { status: "waiting-for-batch" };
    }
    await wait(BATCH_POLL_MS);
  }

  let rejected = 0;
  const outcomes: { postId: string; result: BatchResult }[] = [];
  for await (const {
    customId: id,
    result,
  } of await options.claude.batchResults(batch.id)) {
    const index = indexOf(run.id, id);
    const postId = index === undefined ? undefined : batch.postIds[index];
    // A result for a request this run did not make is not this run's.
    if (postId === undefined) continue;
    outcomes.push({ postId, result });
    if (
      result.type === "errored" &&
      result.error.error.type === "invalid_request_error"
    ) {
      rejected += 1;
    }
  }
  // Every request rejected is the request's shape at fault, not the posts:
  // none of them is marked as failed, and the other route can be tried.
  if (outcomes.length > 0 && rejected === outcomes.length) {
    return {
      status: "failed",
      failure: {
        kind: "batch-rejected",
        message:
          "The Message Batches API rejected every request of the batch. No bookmark was marked as failed. Run again with --direct, which sends the same requests one at a time.",
      },
    };
  }
  const closed = finishTaggingRunWith(store, run.id, () => {
    for (const { postId, result } of outcomes) {
      if (result.type === "succeeded") {
        spend(tally, result.message, "batch");
        settle(context, postId, result.message);
      } else if (
        result.type === "errored" &&
        result.error.error.type === "invalid_request_error"
      ) {
        fail(context, postId, "rejected");
      }
      // An expired or cancelled request, or one the API failed on, was not
      // answered and is not the bookmark's failure: the next run takes it.
    }
    recordTaggingProgress(store, run.id, standingOf(context));
    return { outcome, now: now() };
  });
  if (closed === undefined) {
    // Another process took up the same batch and stored it first. This one
    // has stored nothing, and reports what that one recorded.
    adopt(tally, getTaggingRun(store, run.id));
  }
  options.onProgress?.(progressOf(context));
  return { status: outcome };
}

async function sendBatch(
  context: Context,
  requests: readonly Prepared[],
): Promise<Ending> {
  const { options, run, store, tally, now } = context;
  // A batch cannot be stopped at the cap once it is on its way, so only as
  // many requests go into it as fit under the cap at the most each can cost.
  const admitted = requests.slice(
    0,
    fitting(requests, "batch", options.capUsd).count,
  );
  if (admitted.length === 0) return { status: "stopped-at-cap" };
  const postIds = admitted.map(({ bookmark }) => bookmark.postId);
  let id: string;
  try {
    id = await options.claude.submitBatch(
      admitted.map(({ input }, index) => ({
        customId: customId(run.id, index),
        request: requestFor(input, "batch", askingOf(context)),
      })),
    );
  } catch (error) {
    if (!(error instanceof ClaudeFailure)) throw error;
    // An API that refused the batch made none. One that did not answer may
    // have made one, which this run then knows nothing of.
    const refused = [
      "rejected",
      "unauthorised",
      "forbidden",
      "not-found",
      "rate-limited",
    ];
    return {
      status: "failed",
      failure: {
        kind: error.kind,
        message: refused.includes(error.kind)
          ? error.message
          : `${error.message} The batch was submitted once and no answer came. If it reached the API all the same, a batch exists that this run cannot collect: it is charged, no more than this run's cap, and the Console lists it under Batches, where it can be cancelled.`,
      },
    };
  }
  // Stored before the wait: from here on the batch is paid for, and a run
  // that dies waiting leaves its id for the next to collect.
  recordTaggingProgress(store, run.id, {
    ...tally.usage,
    classified: tally.classified,
    failed: tally.failed,
    costUsd: tally.costUsd,
    batch: { id, postIds },
    now: now(),
  });
  return collectBatch(
    context,
    { id, postIds },
    admitted.length < requests.length ? "stopped-at-cap" : "completed",
  );
}

function reportOf(
  context: Omit<Context, "run"> & { run: TaggingRun | null },
  status: TaggingReport["status"],
  parts: {
    transport: Transport | null;
    selected: number;
    resumed?: boolean;
    failure?: { kind: string; message: string };
  },
): TaggingReport {
  const { store, options, tally, run, now } = context;
  return {
    status,
    mode: run?.mode ?? options.mode,
    transport: parts.transport,
    run,
    resumed: parts.resumed ?? false,
    selected: parts.selected,
    classified: tally.classified,
    filedWithoutRequest: tally.filedWithoutRequest,
    failed: tally.failed,
    failures: tally.failures,
    left: Math.max(0, parts.selected - tally.classified - tally.failed),
    usage: tally.usage,
    costUsd: tally.costUsd,
    capUsd: run?.capUsd ?? options.capUsd,
    unanswered: tally.unanswered,
    heldUsd: tally.heldUsd,
    categories: tally.categories,
    formats: tally.formats,
    tags: tally.tags,
    tooLittleText: tally.tooLittleText,
    withProposals: tally.withProposals,
    failure: parts.failure ?? null,
    summary: summariseTagging(store, {
      instructionsVersion: INSTRUCTIONS_VERSION,
      now: now(),
    }),
  };
}

/** Closes the run's record as its ending says, and reports. */
function close(
  context: Context,
  ending: Ending,
  parts: { transport: Transport; resumed?: boolean },
): TaggingReport {
  const { store, run, now } = context;
  if (ending.status === "waiting-for-batch") {
    // The run stays open: its batch is paid for, and the next run collects it.
    return reportOf(
      { ...context, run: getOpenTaggingRun(store) ?? run },
      ending.status,
      { ...parts, selected: run.selected },
    );
  }
  let closed: TaggingRun;
  try {
    closed = finishTaggingRun(store, run.id, {
      outcome: ending.status,
      ...(ending.status === "failed" ? { failure: ending.failure.kind } : {}),
      now: now(),
    });
  } catch (error) {
    // Closed already: by the collection of its batch, which closes the run
    // with the last of what it stores, in this process or another; or as
    // abandoned, under a run that was taken for dead.
    if (!(error instanceof TaggingRunNotOpen)) throw error;
    closed = getTaggingRun(store, run.id);
  }
  return reportOf({ ...context, run: closed }, ending.status, {
    ...parts,
    selected: run.selected,
    ...(ending.status === "failed" ? { failure: ending.failure } : {}),
  });
}

/** Runs `work` for an open run, and closes the run as failed if it throws. */
async function guarded(
  context: Context,
  parts: { transport: Transport; resumed?: boolean },
  work: () => Promise<Ending>,
): Promise<TaggingReport> {
  let ending: Ending;
  try {
    ending = await work();
  } catch (error) {
    if (error instanceof TaggingRunNotOpen) {
      // The run's record was closed under it. Nothing more is sent, and
      // this is a report like any other, not an error of the caller's.
      return close(context, SET_ASIDE, parts);
    }
    if (!(error instanceof ClaudeFailure)) {
      try {
        finishTaggingRun(context.store, context.run.id, {
          outcome: "failed",
          failure: "error",
          now: context.now(),
        });
      } catch (closing) {
        // Closed already; what broke the run is the error to hear of.
        if (!(closing instanceof TaggingRunNotOpen)) throw closing;
      }
      throw error;
    }
    ending = {
      status: "failed",
      failure: { kind: error.kind, message: error.message },
    };
  }
  return close(context, ending, parts);
}

/**
 * Takes up the batch an earlier run submitted and left waiting. Its
 * answers were made under that run's taxonomy and instructions; when either
 * has changed since, they are not stored, because they would be stored as
 * answers under the new ones.
 */
function resume(
  store: Store,
  options: RunOptions,
  run: TaggingRun & { batchId: string; batchPostIds: string[] },
  now: () => Date,
): Promise<TaggingReport> {
  const tally = emptyTally();
  // What the run dealt with without a request before it submitted its batch.
  tally.classified = run.classified;
  tally.filedWithoutRequest = run.filedWithoutRequest;
  const context: Context = {
    store,
    options,
    run,
    tally,
    now,
    asking: null,
    onlyNewTags: run.mode === "new-tags",
  };
  const parts = { transport: "batch" as const, resumed: true };
  if (
    run.taxonomyVersion !== TAXONOMY.version ||
    run.instructionsVersion !== INSTRUCTIONS_VERSION
  ) {
    // A vocabulary that has changed since is no reason: the answers are
    // stored against the version they were asked with, under the names the
    // vocabulary has for their tags now.
    return Promise.resolve(
      close(
        context,
        {
          status: "failed",
          failure: {
            kind: "versions-changed",
            message:
              "A batch was waiting whose answers were made under an older taxonomy or older instructions. They were not stored. Run again to classify under the current ones.",
          },
        },
        parts,
      ),
    );
  }
  return guarded(context, parts, () =>
    collectBatch(context, { id: run.batchId, postIds: run.batchPostIds }),
  );
}

/**
 * Runs the classifier over the bookmarks `options` select and returns what
 * it did. A batch left waiting by an earlier run is taken up first, and is
 * then the whole of this run: run again for what remains.
 *
 * It does not throw for anything the API does: a failed run is a report
 * with `status: "failed"`. Every answer that arrived before the failure is
 * kept.
 */
export async function runTagging(
  store: Store,
  options: RunOptions,
): Promise<TaggingReport> {
  const now = options.now ?? (() => new Date());
  // Proposals the vocabulary has come to know some other way than through
  // core's own functions are settled before anything is asked.
  settleTagProposals(store);

  const open = getOpenTaggingRun(store);
  if (open?.batchId != null && open.batchPostIds !== null) {
    return resume(
      store,
      options,
      { ...open, batchId: open.batchId, batchPostIds: open.batchPostIds },
      now,
    );
  }

  const asking = askingWith(store);
  const { chosen } = select(store, options, asking);
  const idle = {
    store,
    options,
    tally: emptyTally(),
    run: null,
    now,
    asking,
    onlyNewTags: options.mode === "new-tags",
  };
  if (chosen.length === 0) {
    return reportOf(idle, "nothing-to-do", { transport: null, selected: 0 });
  }
  const sendable = chosen.filter(({ substance }) => substance !== "none");
  const transport = chooseTransport({ asked: options.transport });
  let run: TaggingRun;
  try {
    run = startTaggingRun(store, {
      startedBy: options.startedBy,
      mode: options.mode,
      transport,
      model: MODEL,
      instructionsVersion: INSTRUCTIONS_VERSION,
      vocabularyVersion: asking.vocabulary.version,
      selected: chosen.length,
      capUsd: options.capUsd,
      now: now(),
    });
  } catch (error) {
    if (!(error instanceof TaggingRunInProgress)) throw error;
    return reportOf({ ...idle, run: error.run }, "busy", {
      transport: error.run.transport,
      selected: 0,
    });
  }
  const context: Context = {
    store,
    options,
    run,
    tally: emptyTally(),
    now,
    asking,
    onlyNewTags: options.mode === "new-tags",
  };
  return guarded(context, { transport }, async () => {
    for (const { bookmark, substance } of chosen) {
      if (substance !== "none") continue;
      // A run that may only add tags files nothing: LAB-9.
      if (context.onlyNewTags) leaveAsItIs(context, bookmark.postId);
      else fileWithoutRequest(context, bookmark.postId);
    }
    saveProgress(context);
    if (sendable.length === 0) return { status: "completed" };
    return transport === "batch"
      ? sendBatch(context, sendable)
      : sendDirectly(context, sendable);
  });
}
