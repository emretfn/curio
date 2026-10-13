/**
 * The weekly digest, as far as the library is concerned.
 *
 * A digest has two parts. The free part is read from the bookmarks each
 * time and stored nowhere: what was saved in a week, counted by category,
 * format and tag (`summariseWeek`), and which weeks hold anything
 * (`listWeeks`). The posts themselves come from `listBookmarks` with the
 * week's two moments, and the suggestions for the taxonomy from
 * `listBookmarks` and `listTagProposals`, like everything else that reads
 * the library (READ-1).
 *
 * The written part is Claude's summary of a week. It is written by
 * `packages/tagger`, on the owner's command, and stored here as a run: what
 * was sent, what it cost and, where it succeeded, the text. Nothing here
 * calls a model or makes a request: core never does (X-5).
 */
import { BOOKMARKED_AT, FROM_BOOKMARKS, REMOVED_ON_X_AT } from "./bookmarks.ts";
import { visibleText } from "./hidden-text.ts";
import { summariseMatches } from "./library.ts";
import { connectionOf, type Store } from "./store.ts";
import type { TokenUsage } from "./tagging.ts";
import { OTHER_CATEGORY } from "./taxonomy.ts";
import { type Week, weekFromKey, weekOf } from "./weeks.ts";
import { isXOwnedHost } from "./x-hosts.ts";

type Connection = ReturnType<typeof connectionOf>;

/** What was saved in one week, counted. Bookmarks removed on X are left out, and counted apart. */
export interface WeekSummary {
  week: Week;
  /** Bookmarks made in the week that are still bookmarks. */
  bookmarks: number;
  /** Bookmarks made in the week and since removed on X. They are in no other count here. */
  removedOnX: number;
  /** Of `bookmarks`: those filed under a category, by the classifier or the owner. */
  filed: number;
  /** Of `bookmarks`: those not filed yet, which no count below holds. */
  unfiled: number;
  /** By category id, most bookmarks first. Only categories with a bookmark that week. */
  categories: { category: string; bookmarks: number }[];
  /** By format id, likewise. */
  formats: { format: string; bookmarks: number }[];
  /** By tag, likewise. A bookmark with two tags is counted under both. */
  tags: { tag: string; bookmarks: number }[];
  /**
   * The week's bookmarks under "other", and why (LAB-10). `noneOfTheAbove`
   * said enough and fitted no category: the sign that one is missing.
   */
  other: { bookmarks: number; tooLittleText: number; noneOfTheAbove: number };
}

/** Counts what was bookmarked in a week. See `WeekSummary`. */
export function summariseWeek(store: Store, week: Week): WeekSummary {
  const matches = summariseMatches(store, {
    bookmarkedSince: week.start,
    bookmarkedBefore: week.end,
  });
  const categories = matches.categories.flatMap(({ category, bookmarks }) =>
    category === null ? [] : [{ category, bookmarks }],
  );
  const filed = categories.reduce((sum, { bookmarks }) => sum + bookmarks, 0);
  const other =
    categories.find(({ category }) => category === OTHER_CATEGORY)?.bookmarks ??
    0;
  return {
    week,
    bookmarks: matches.total,
    removedOnX: matches.removedOnX,
    filed,
    unfiled: matches.total - filed,
    categories,
    formats: matches.formats.flatMap(({ format, bookmarks }) =>
      format === null ? [] : [{ format, bookmarks }],
    ),
    tags: matches.tags,
    other: {
      bookmarks: other,
      tooLittleText: matches.tooLittleText,
      noneOfTheAbove: other - matches.tooLittleText,
    },
  };
}

/**
 * A week with fewer bookmarks than this gets no written summary: there is
 * nothing to find a theme in, and the page shows the posts as they are. The
 * writer refuses such a week, and a screen says so in place of offering it.
 */
export const MIN_DIGEST_BOOKMARKS = 3;

/** One week that holds bookmarks, a written digest, or both. */
export interface WeekEntry {
  week: Week;
  /** Bookmarks made in it that are still bookmarks. */
  bookmarks: number;
  /** Whether a digest has been written for it. */
  written: boolean;
}

/**
 * Every week that holds a bookmark or has a written digest, latest first:
 * what a screen offers to open. A library of three years is some hundred
 * and fifty of them.
 */
export function listWeeks(store: Store): WeekEntry[] {
  const db = connectionOf(store);
  // Grouped here and not in SQL, so that a week is worked out by the one
  // function that defines it, clock changes included.
  const times = db
    .prepare<[], number>(
      `SELECT ${BOOKMARKED_AT} ${FROM_BOOKMARKS}
       WHERE ${REMOVED_ON_X_AT} IS NULL`,
    )
    .pluck()
    .all();
  const entries = new Map<string, WeekEntry>();
  for (const time of times) {
    const week = weekOf(new Date(time));
    const entry = entries.get(week.key);
    if (entry === undefined) {
      entries.set(week.key, { week, bookmarks: 1, written: false });
    } else {
      entry.bookmarks += 1;
    }
  }
  const written = db
    .prepare<[], string>(
      "SELECT DISTINCT week FROM digest_runs WHERE outcome = 'written'",
    )
    .pluck()
    .all();
  for (const key of written) {
    const week = weekFromKey(key);
    if (week === undefined) continue;
    const entry = entries.get(key);
    if (entry === undefined) {
      entries.set(key, { week, bookmarks: 0, written: true });
    } else {
      entry.written = true;
    }
  }
  return [...entries.values()].toSorted((a, b) =>
    a.week.key < b.week.key ? 1 : -1,
  );
}

/** One subject the week's bookmarks share, as the digest names it. */
export interface DigestTheme {
  title: string;
  summary: string;
  /** The bookmarks it is about, by post id: each one of the run's `postIds`. */
  postIds: string[];
}

/**
 * A digest as written. Every string in it is a model's words about posts
 * written by strangers: text to show as text, never markup, a link or an
 * instruction. A bookmark is named by its post id and by nothing else.
 */
export interface DigestText {
  /** A few sentences on the week as a whole. */
  overview: string;
  themes: DigestTheme[];
  /** Bookmarks worth going back to, each with a sentence on why. */
  worthRevisiting: { postId: string; why: string }[];
}

export type DigestRunOutcome = "written" | "failed" | "abandoned";

/** One attempt at writing a week's digest. */
export interface DigestRun extends TokenUsage {
  id: number;
  /** The week's key: the date of its Monday. */
  week: string;
  /** The moments that bounded the week where and when the run was made. */
  periodStart: Date;
  periodEnd: Date;
  startedAt: Date;
  /** Null while the run is open. */
  finishedAt: Date | null;
  /** `owner` for a run at a terminal; `schedule` for the launchd job the owner installed. */
  startedBy: "owner" | "schedule";
  model: string;
  /** The version of the digest's own instructions it was written under. */
  instructionsVersion: number;
  /** Null while the run is open. */
  outcome: DigestRunOutcome | null;
  /** Why a failed run failed: a code, never anything from a post or the model. */
  failure: string | null;
  /** How many bookmarks the week held when the run began. */
  bookmarksInWeek: number;
  /** The bookmarks that were sent, in the order the request numbered them. */
  postIds: string[];
  /** In US dollars, from the tokens the API reported. The invoice is the authority. */
  costUsd: number;
  /** Attempts that brought no answer back and may have been charged all the same. Not in `costUsd`. */
  unansweredRequests: number;
  /** The most the run was allowed to spend. */
  capUsd: number;
  /** The digest, for a run that wrote one. */
  text: DigestText | null;
}

/** A week's digest: the run that wrote it, which holds its text. */
export type WrittenDigest = DigestRun & {
  outcome: "written";
  finishedAt: Date;
  text: DigestText;
};

interface RunRow {
  id: number;
  week: string;
  periodStart: number;
  periodEnd: number;
  startedAt: number;
  finishedAt: number | null;
  startedBy: DigestRun["startedBy"];
  model: string;
  instructionsVersion: number;
  outcome: DigestRunOutcome | null;
  failure: string | null;
  bookmarksInWeek: number;
  postIds: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  unansweredRequests: number;
  capUsd: number;
  body: string | null;
}

const SELECT_RUN = `
  SELECT id, week, period_start_at AS periodStart, period_end_at AS periodEnd,
         started_at AS startedAt, finished_at AS finishedAt,
         started_by AS startedBy, model,
         instructions_version AS instructionsVersion, outcome, failure,
         bookmarks_in_week AS bookmarksInWeek, post_ids AS postIds,
         input_tokens AS inputTokens, cache_write_tokens AS cacheWriteTokens,
         cache_read_tokens AS cacheReadTokens, output_tokens AS outputTokens,
         cost_usd AS costUsd, unanswered_requests AS unansweredRequests,
         cap_usd AS capUsd, body
  FROM digest_runs`;

function runFromRow({ body, ...row }: RunRow): DigestRun {
  return {
    ...row,
    periodStart: new Date(row.periodStart),
    periodEnd: new Date(row.periodEnd),
    startedAt: new Date(row.startedAt),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt),
    postIds: JSON.parse(row.postIds) as string[],
    text: body === null ? null : readText(body),
  };
}

function runById(db: Connection, id: number): DigestRun {
  const row = db
    .prepare<[number], RunRow>(`${SELECT_RUN} WHERE id = ?`)
    .get(id);
  if (row === undefined) throw new Error(`There is no digest run ${id}.`);
  return runFromRow(row);
}

/**
 * A run that has been open this long is taken to have died with its
 * process, and no longer stands in the way of the next. A digest is one
 * request, which the writer gives up on long before this.
 */
export const DIGEST_RUN_STALE_MS = 20 * 60 * 1000;

/** Thrown by `startDigestRun` while another run is open. `run` is that run. */
export class DigestRunInProgress extends Error {
  readonly run: DigestRun;
  constructor(run: DigestRun) {
    super(
      `Digest run ${run.id}, for the week of ${run.week}, is in progress. Only one runs at a time, so that no week is paid for twice.`,
    );
    this.name = "DigestRunInProgress";
    this.run = run;
  }
}

/** Thrown when an ending is written for a run that is no longer open. */
export class DigestRunNotOpen extends Error {
  constructor(id: number) {
    super(`Digest run ${id} is not open.`);
    this.name = "DigestRunNotOpen";
  }
}

const POST_ID = /^[0-9]{1,20}$/;

function wholeAbove(value: number, least: number, name: string): number {
  if (!Number.isInteger(value) || value < least) {
    throw new RangeError(
      `${name} must be a whole number of at least ${least}.`,
    );
  }
  return value;
}

export interface NewDigestRun {
  week: Week;
  startedBy: DigestRun["startedBy"];
  model: string;
  instructionsVersion: number;
  bookmarksInWeek: number;
  /** The bookmarks about to be sent, in the order the request numbers them. Each is in the library. */
  postIds: readonly string[];
  capUsd: number;
  now?: Date;
}

/**
 * Opens a run, and with it the one place at the writer's table: while it is
 * open no other starts. A run left open by a process that died is closed as
 * abandoned once it is `DIGEST_RUN_STALE_MS` old.
 */
export function startDigestRun(store: Store, run: NewDigestRun): DigestRun {
  const db = connectionOf(store);
  const now = (run.now ?? new Date()).getTime();
  if (weekFromKey(run.week.key) === undefined) {
    throw new RangeError(`"${run.week.key}" is not the name of a week.`);
  }
  if (new Set(run.postIds).size !== run.postIds.length) {
    throw new RangeError("A digest run names each bookmark once.");
  }
  const known = db.prepare<[string], number>(
    "SELECT 1 FROM bookmarks WHERE post_id = ?",
  );
  for (const postId of run.postIds) {
    if (!POST_ID.test(postId) || known.pluck().get(postId) === undefined) {
      throw new RangeError(
        "A digest run names a bookmark the library does not hold.",
      );
    }
  }
  const start = db.transaction(() => {
    const open = db
      .prepare<[], RunRow>(`${SELECT_RUN} WHERE finished_at IS NULL`)
      .get();
    if (open !== undefined) {
      if (now - open.startedAt < DIGEST_RUN_STALE_MS) {
        throw new DigestRunInProgress(runFromRow(open));
      }
      db.prepare(
        "UPDATE digest_runs SET outcome = 'abandoned', finished_at = ? WHERE id = ?",
      ).run(now, open.id);
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO digest_runs (
           week, period_start_at, period_end_at, started_at, started_by,
           model, instructions_version, bookmarks_in_week, post_ids, cap_usd
         )
         VALUES (
           @week, @periodStart, @periodEnd, @now, @startedBy,
           @model, @instructionsVersion, @bookmarksInWeek, @postIds, @capUsd
         )`,
      )
      .run({
        week: run.week.key,
        periodStart: run.week.start.getTime(),
        periodEnd: run.week.end.getTime(),
        now,
        startedBy: run.startedBy,
        model: run.model,
        instructionsVersion: wholeAbove(
          run.instructionsVersion,
          1,
          "instructionsVersion",
        ),
        bookmarksInWeek: wholeAbove(run.bookmarksInWeek, 0, "bookmarksInWeek"),
        postIds: JSON.stringify(run.postIds),
        capUsd: run.capUsd,
      });
    return runById(db, Number(lastInsertRowid));
  });
  return start.immediate();
}

/** The most characters of each part of a digest that are stored. A digest is a page, not a document. */
export const DIGEST_LIMITS = {
  overview: 2000,
  themes: 12,
  themeTitle: 120,
  themeSummary: 1500,
  worthRevisiting: 12,
  why: 600,
} as const;

/**
 * What a digest's prose may not hold, and why.
 *
 * A digest is a model's words about posts written by strangers, and it is
 * read twice over: by the owner on a page, and by whatever model asks the
 * MCP server for it. It points at a bookmark by its id and at nothing else.
 * An address in it could only have come out of a post, and a post's links
 * are data, never somewhere to send a reader or a model (X-2, MCP-4): for a
 * host X owns that is the rule the whole project is built on, and for any
 * other host it is how a post that gives orders would get a reader to
 * carry something out of the library.
 *
 * So an address is taken out, in whatever form a browser or a model that can
 * request things would follow it. What makes text an address, as against a
 * name with a dot in it, is drawn narrowly enough that prose survives:
 *
 * - anything with a scheme, `name://`; the schemes that take no slashes;
 *   `//host`, which a browser completes; and a name that opens with `www.`;
 * - a host X owns, in any form: alone, with a path, in capitals. This one
 *   is exact (`isXOwnedHost`), so it needs no path to be sure;
 * - any other host only where something follows that makes it a place to
 *   go: a path, a query, a fragment or a port, or a mailbox before it. A
 *   host alone, "the tool is on example.com", is a name and stays; so does
 *   a sentence that lost the space after its full stop.
 *
 * A dotted name with a path is not a host when it ends as files and
 * libraries do and no domain does, so "Next.js/React" is prose, or in a
 * number, as a version does. A name that is both a library and a domain
 * loses its path here; that is the side to err on.
 *
 * Characters that show as nothing, or that turn round the order of what is
 * shown, go first: they are how an address would be split to pass as two
 * words, and how a reader would be shown something other than what a model
 * is given. What no pattern sees: an address spelt out in words.
 */

/** Unicode's format characters: zero-width spaces and joiners, direction marks and overrides, soft hyphens, byte-order marks. */
const FORMAT = /\p{Cf}/gu;
/** Full stops other scripts write, which a browser reads as the dot of a host name. */
const OTHER_DOTS = /[\u3002\uFF0E\uFF61]/g;
const LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
/** A run of labels with dots between them, where it does not continue one. */
const HOST = new RegExp(
  `(?<![\\p{L}\\p{N}.-])${LABEL}(?:\\.${LABEL})+(?![\\p{L}\\p{N}-])`,
  "gu",
);
const SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
/** Schemes written without slashes, each with what must follow for it to be one. */
const BARE_SCHEME =
  /(?<![\p{L}\p{N}])(?:mailto:\S|javascript:\S|vbscript:\S|data:[a-z]+\/|(?:tel|sms):\+?\d|magnet:\?)/iu;
const PROTOCOL_RELATIVE =
  /(?<![\p{L}\p{N}:/])\/\/[\p{L}\p{N}-]+\.[\p{L}\p{N}]/u;
const WWW = /(?<![\p{L}\p{N}.-])www\.[\p{L}\p{N}]/iu;
const LOCAL = /(?<![p{L}p{N}.-])localhost(?::\d|\/)/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
/** What follows a host when it is somewhere to go: a path, a query, a fragment, a port. */
const LEADS_ON = /^(?:\/|[?#].|:\d)/u;
/**
 * How files and libraries end, and no top-level domain does. A dotted name
 * that ends this way is not a host, whatever follows it. Endings that are
 * also a country's domain (`md`, `py`, `rs`, `sh`) are left out on purpose.
 */
const NOT_A_DOMAIN = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "css",
  "scss",
  "html",
  "htm",
  "json",
  "yaml",
  "yml",
  "toml",
  "lock",
  "txt",
  "csv",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "wasm",
  "sql",
  "go",
  "rb",
  "php",
  "java",
]);

/** Whether a dotted name could be a host: its last label is letters, and not an ending of the list above. */
function couldBeHost(name: string): boolean {
  const ending = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (
    /^(?:\p{L}{2,}|xn--[a-z0-9-]+)$/u.test(ending) && !NOT_A_DOMAIN.has(ending)
  );
}

/** Whether a word, without the punctuation around it, holds an address. */
function holdsAddress(word: string): boolean {
  // As a browser would read it: full-width letters, slashes and colons as
  // the plain ones, and the other scripts' full stops as dots.
  const text = word.normalize("NFKC").replace(OTHER_DOTS, ".");
  if (
    SCHEME.test(text) ||
    BARE_SCHEME.test(text) ||
    PROTOCOL_RELATIVE.test(text) ||
    WWW.test(text) ||
    LOCAL.test(text)
  ) {
    return true;
  }
  for (const match of text.matchAll(HOST)) {
    const name = match[0];
    if (isXOwnedHost(name)) return true;
    const mailbox = text[match.index - 1] === "@";
    const leadsOn = LEADS_ON.test(text.slice(match.index + name.length));
    if (mailbox && couldBeHost(name)) return true;
    if (leadsOn && (couldBeHost(name) || IPV4.test(name))) return true;
  }
  return false;
}

const OPENING = /^[([{<"'\u201C\u2018\u00AB]+/u;
const CLOSING = /[)\]}>"'\u201D\u2019\u00BB.,;:!?]+$/u;
const OPENS = /[([{<"'“‘«]/u;
const SENTENCE_MARKS = /[^.,;:!?]/g;

/**
 * Prose with every address taken out, word by word. The punctuation that
 * closed a removed word stays with the word before it, so that a sentence
 * that ended in an address still ends.
 */
function withoutAddresses(text: string): string {
  // Words and the white space between them, alternately.
  const parts = text.split(/(\s+)/u);
  const out: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) {
      out.push(part);
      continue;
    }
    const opening = OPENING.exec(part)?.[0] ?? "";
    const closing = CLOSING.exec(part.slice(opening.length))?.[0] ?? "";
    const word = part.slice(opening.length, part.length - closing.length);
    if (!holdsAddress(word)) {
      out.push(part);
      continue;
    }
    // What closed it: all of it where a bracket or a quote in it closes
    // one opened in an earlier word, and otherwise the sentence's own
    // marks, the brackets and quotes having gone with the word they were
    // opened in.
    const closesEarlier = opening === "" && !OPENS.test(word);
    const kept = closesEarlier ? closing : closing.replace(SENTENCE_MARKS, "");
    const before = out.findLastIndex((piece) => piece.trim() !== "");
    if (before === -1) {
      // Nothing stands before it for a mark to close.
      out.length = 0;
    } else if (kept !== "") {
      out.length = before + 1;
      out.push(kept);
    }
  }
  return out.join("");
}

/**
 * A model's prose as plain text: without the characters that hide text
 * from a reader (`visibleText`) or that show as nothing or reorder what is
 * shown, without control characters, without any address, and with its
 * runs of spaces closed up. It is what is stored, and what is read back:
 * cleaning what is already clean changes nothing.
 */
function plain(text: string): string {
  const shown = [
    ...visibleText(text)
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      .replace(/[\t\v\f]/g, " ")
      .replace(FORMAT, ""),
  ]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x0a || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
  return withoutAddresses(shown)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * A part of a digest as it is stored: plain, as above, not empty, and no
 * longer than its limit.
 */
function stored(text: unknown, limit: number, name: string): string {
  if (typeof text !== "string") {
    throw new RangeError(`A digest's ${name} is text.`);
  }
  const clean = plain(text);
  if (clean === "") throw new RangeError(`A digest's ${name} is not empty.`);
  return [...clean].slice(0, limit).join("").trimEnd();
}

/**
 * A stored digest as it is handed to a reader. Its prose is cleaned again
 * on the way out, so that what a page or a model is given does not depend
 * on which version of this code stored the row.
 */
function readText(body: string): DigestText {
  const text = JSON.parse(body) as DigestText;
  return {
    overview: plain(String(text.overview ?? "")),
    themes: (text.themes ?? []).map((theme) => ({
      title: plain(String(theme.title ?? "")),
      summary: plain(String(theme.summary ?? "")),
      postIds: theme.postIds ?? [],
    })),
    worthRevisiting: (text.worthRevisiting ?? []).map(({ postId, why }) => ({
      postId,
      why: plain(String(why ?? "")),
    })),
  };
}

/**
 * A digest checked for storing. A bookmark it names must be one the run
 * sent: this is the one place a model's pointer at a bookmark is believed,
 * and it is believed only against the run's own list (AI-13). The same
 * bookmark is kept once within a theme and once among those worth going
 * back to.
 */
function checked(text: DigestText, sent: ReadonlySet<string>): DigestText {
  const known = (postId: unknown): string => {
    if (typeof postId !== "string" || !sent.has(postId)) {
      throw new RangeError(
        "A digest names a bookmark that was not among those sent for it.",
      );
    }
    return postId;
  };
  if (
    !Array.isArray(text.themes) ||
    !Array.isArray(text.worthRevisiting) ||
    text.themes.length > DIGEST_LIMITS.themes ||
    text.worthRevisiting.length > DIGEST_LIMITS.worthRevisiting
  ) {
    throw new RangeError(
      `A digest holds at most ${DIGEST_LIMITS.themes} themes and ${DIGEST_LIMITS.worthRevisiting} bookmarks worth going back to.`,
    );
  }
  const revisited = new Set<string>();
  return {
    overview: stored(text.overview, DIGEST_LIMITS.overview, "overview"),
    themes: text.themes.map((theme) => ({
      title: stored(theme.title, DIGEST_LIMITS.themeTitle, "theme title"),
      summary: stored(
        theme.summary,
        DIGEST_LIMITS.themeSummary,
        "theme summary",
      ),
      postIds: [...new Set((theme.postIds ?? []).map(known))],
    })),
    worthRevisiting: text.worthRevisiting.flatMap(({ postId, why }) => {
      const id = known(postId);
      if (revisited.has(id)) return [];
      revisited.add(id);
      return [{ postId: id, why: stored(why, DIGEST_LIMITS.why, "reason") }];
    }),
  };
}

/** How a run ended, and what it used. */
export interface DigestRunResult extends TokenUsage {
  /** `written` comes with `text`; `failed` with `failure`. */
  outcome: Exclude<DigestRunOutcome, "abandoned">;
  /** Why a failed run failed: a code, never content. */
  failure?: string | undefined;
  /** The digest, for a run that wrote one. Checked against the run's bookmarks before it is stored. */
  text?: DigestText | undefined;
  costUsd: number;
  unansweredRequests: number;
  now?: Date | undefined;
}

/**
 * Closes a run with what it used and, when it wrote a digest, the digest.
 * Throws a `RangeError`, and leaves the run open, for a digest that names a
 * bookmark the run did not send or holds a part that is not text.
 */
export function finishDigestRun(
  store: Store,
  id: number,
  result: DigestRunResult,
): DigestRun {
  const db = connectionOf(store);
  const run = runById(db, id);
  if ((result.outcome === "written") !== (result.text !== undefined)) {
    throw new RangeError(
      "A digest run ends as written with its text, or otherwise without one.",
    );
  }
  const text =
    result.text === undefined
      ? null
      : checked(result.text, new Set(run.postIds));
  const { changes } = db
    .prepare(
      `UPDATE digest_runs SET
         outcome = @outcome, failure = @failure, finished_at = @now,
         input_tokens = @inputTokens, cache_write_tokens = @cacheWriteTokens,
         cache_read_tokens = @cacheReadTokens, output_tokens = @outputTokens,
         cost_usd = @costUsd, unanswered_requests = @unansweredRequests,
         body = @body
       WHERE id = @id AND finished_at IS NULL`,
    )
    .run({
      id,
      outcome: result.outcome,
      failure: result.failure ?? null,
      now: (result.now ?? new Date()).getTime(),
      inputTokens: result.inputTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      cacheReadTokens: result.cacheReadTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      unansweredRequests: result.unansweredRequests,
      body: text === null ? null : JSON.stringify(text),
    });
  if (changes === 0) throw new DigestRunNotOpen(id);
  return runById(db, id);
}

/**
 * The digest written for a week, by the week's key: the latest run that
 * wrote one. Undefined when none has been written, and for a key that
 * names no week.
 */
export function getDigest(
  store: Store,
  week: string,
): WrittenDigest | undefined {
  if (weekFromKey(week) === undefined) return undefined;
  const row = connectionOf(store)
    .prepare<[string], RunRow>(
      `${SELECT_RUN} WHERE week = ? AND outcome = 'written'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(week);
  return row === undefined ? undefined : (runFromRow(row) as WrittenDigest);
}

/** The latest runs, newest first, of one week or of all: 20 unless `limit` says otherwise, 100 at most. */
export function listDigestRuns(
  store: Store,
  options: { week?: string | undefined; limit?: number | undefined } = {},
): DigestRun[] {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(
      `limit must be a whole number from 1 to 100; got ${limit}.`,
    );
  }
  const db = connectionOf(store);
  const rows =
    options.week === undefined
      ? db
          .prepare<[number], RunRow>(`${SELECT_RUN} ORDER BY id DESC LIMIT ?`)
          .all(limit)
      : db
          .prepare<[string, number], RunRow>(
            `${SELECT_RUN} WHERE week = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(options.week, limit);
  return rows.map(runFromRow);
}
