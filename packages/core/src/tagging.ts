/**
 * What the classifier needs of the library beyond the labels themselves:
 * which bookmarks to classify, which it failed on, a record of each run and
 * what it spent, and the totals that say how the tagging stands.
 *
 * The classifier is `packages/tagger`. Nothing here calls a model or makes
 * a request: core never does (X-5).
 */
import {
  type Bookmark,
  type BookmarkRow,
  bookmarkFromRow,
  CATEGORY,
  FORMAT,
  FROM_BOOKMARKS,
  SELECT_BOOKMARK_COLUMNS,
  TOO_LITTLE_TEXT,
} from "./bookmarks.ts";
import { parseSearchQuery } from "./search-text.ts";
import { connectionOf, type Store } from "./store.ts";
import { OTHER_CATEGORY, TAXONOMY, UNCLEAR_FORMAT } from "./taxonomy.ts";
import { vocabularyVersion } from "./vocabulary.ts";

type Connection = ReturnType<typeof connectionOf>;

/**
 * The current version of the classifier's instructions: of everything
 * `packages/tagger` tells the model and asks it with. The instructions are
 * the tagger's, and its tests hold their fingerprint; the number is kept
 * here, beside the taxonomy's version, because whether a classification is
 * outdated is a question every reader of the library asks, and they must
 * all get the same answer without each having to be told the version.
 * Raise it when the tagger's instructions change.
 */
export const INSTRUCTIONS_VERSION = 2;

/** The most bookmarks one call to `listClassificationCandidates` returns, and so the most one run classifies. */
export const MAX_CLASSIFICATION_CANDIDATES = 5000;

/**
 * After this many failures under the same taxonomy and instructions a
 * bookmark is left alone, so that a post the model keeps declining is not
 * paid for on every pass. `retryFailed` asks again all the same.
 */
export const MAX_CLASSIFICATION_ATTEMPTS = 2;

export interface CandidateOptions {
  /**
   * `unclassified`: bookmarks the classifier has no answer for. `outdated`:
   * bookmarks whose answer was made under an older taxonomy or older
   * instructions than the current ones. `new-tags`: bookmarks classified
   * before a tag joined the vocabulary, whose text mentions that tag or
   * another way of writing it, and that do not have it: the few worth asking
   * about a new tag. `behind-vocabulary`: every bookmark classified before
   * some tag joined, mention or none.
   */
  which: "unclassified" | "outdated" | "new-tags" | "behind-vocabulary";
  /** The version of the classifier's instructions to count against: `INSTRUCTIONS_VERSION` unless said. */
  instructionsVersion?: number | undefined;
  /** 1 to `MAX_CLASSIFICATION_CANDIDATES`, which is the default. */
  limit?: number | undefined;
  /**
   * `newest`, the default: most recently bookmarked first. `spread`: an
   * order that has nothing to do with time or author, the same on every
   * call, so that a small sample is drawn from across the whole library.
   */
  order?: "newest" | "spread" | undefined;
  /** Also the bookmarks that failed `MAX_CLASSIFICATION_ATTEMPTS` times, which are passed over otherwise. */
  retryFailed?: boolean | undefined;
}

export interface CandidateList {
  /** How many bookmarks there are to classify, of which `bookmarks` holds up to `limit`. */
  total: number;
  bookmarks: Bookmark[];
}

/**
 * A row of `FROM_BOOKMARKS` was classified before some tag the vocabulary
 * now holds joined it, and so was never asked about that tag.
 */
const BEHIND_VOCABULARY = `EXISTS (
    SELECT 1 FROM tags v
    WHERE v.retired_at IS NULL AND v.added_version > cl.vocabulary_version)`;

/** A tag's name shorter than this is looked for as a whole word only. */
const SHORTEST_WORD_FOUND_AS_A_START = 5;

/**
 * The bookmarks worth asking about a tag they were never offered: for each
 * such tag, the bookmarks classified before it joined that do not have it
 * and whose text mentions it, under its name or another way of writing it.
 * Found by the search index, so a mention counts as search counts one.
 */
function mentioningNewTags(db: Connection): string[] {
  const added = db
    .prepare<[], { tag: string; version: number }>(
      `SELECT tag, added_version AS version FROM tags
       WHERE retired_at IS NULL AND added_version > (
         SELECT min(vocabulary_version) FROM bookmark_classifications)`,
    )
    .all();
  const aliases = db.prepare<[string], string>(
    "SELECT alias FROM tag_aliases WHERE tag = ?",
  );
  const mentions = db.prepare<
    { expression: string; tag: string; version: number },
    string
  >(
    `SELECT b.post_id
     FROM bookmarks b
     JOIN bookmark_classifications cl ON cl.post_id = b.post_id
     JOIN bookmark_search ON bookmark_search.rowid = b.id
     WHERE bookmark_search MATCH @expression
       AND cl.vocabulary_version < @version
       AND NOT EXISTS (
         SELECT 1 FROM bookmark_effective_tags e
         WHERE e.post_id = b.post_id AND e.tag = @tag)
       AND NOT EXISTS (
         SELECT 1 FROM bookmark_tag_corrections x
         WHERE x.post_id = b.post_id AND x.tag = @tag)`,
  );
  const found = new Set<string>();
  for (const { tag, version } of added) {
    // A name of several words is looked for as those words in a row, and as
    // one word. A long word is also found as the start of a longer one, as
    // in a search; a short one only whole, or every tag of three letters
    // would be "mentioned" by half the library.
    const names = [tag, ...aliases.pluck().all(tag)].flatMap((name) => {
      const words = name.split(/[-.\s]+/).filter((word) => word !== "");
      const whole = (word: string) =>
        word.length < SHORTEST_WORD_FOUND_AS_A_START ? `"${word}"` : word;
      return words.length > 1
        ? [`"${words.join(" ")}"`, whole(words.join(""))]
        : words.map(whole);
    });
    const { expression } = parseSearchQuery(names.join(" "), "any");
    if (expression === null) continue;
    for (const postId of mentions.pluck().all({ expression, tag, version })) {
      found.add(postId);
    }
  }
  return [...found];
}

function versionOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("instructionsVersion must be a whole number above 0.");
  }
  return value;
}

/**
 * The bookmarks for the classifier to work on. Bookmarks removed on X are
 * among them: they stay in the library and are filed like any other. A
 * bookmark the owner has corrected is among them too; classifying it again
 * changes the classifier's answer and leaves the correction standing.
 */
export function listClassificationCandidates(
  store: Store,
  options: CandidateOptions,
): CandidateList {
  const limit = options.limit ?? MAX_CLASSIFICATION_CANDIDATES;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_CLASSIFICATION_CANDIDATES
  ) {
    throw new RangeError(
      `limit must be a whole number from 1 to ${MAX_CLASSIFICATION_CANDIDATES}; got ${limit}.`,
    );
  }
  const parameters: Record<string, string | number> = {
    taxonomyVersion: TAXONOMY.version,
    instructionsVersion: versionOf(
      options.instructionsVersion ?? INSTRUCTIONS_VERSION,
    ),
    attempts: MAX_CLASSIFICATION_ATTEMPTS,
  };
  const db = connectionOf(store);
  const which = {
    unclassified: "cl.post_id IS NULL",
    outdated: `(cl.taxonomy_version < @taxonomyVersion
          OR cl.instructions_version < @instructionsVersion)`,
    "new-tags": `b.post_id IN (SELECT value FROM json_each(@mentioning))`,
    "behind-vocabulary": BEHIND_VOCABULARY,
  }[options.which];
  const conditions = [which];
  if (options.which === "new-tags") {
    Object.assign(parameters, {
      mentioning: JSON.stringify(mentioningNewTags(db)),
    });
  }
  if (options.retryFailed !== true) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM classification_failures f
      WHERE f.post_id = b.post_id
        AND f.taxonomy_version = @taxonomyVersion
        AND f.instructions_version = @instructionsVersion
        AND f.attempts >= @attempts)`);
  }
  const from = `${FROM_BOOKMARKS} WHERE ${conditions.join(" AND ")}`;
  // The last digits of a post id are a counter inside X's servers, so
  // ordering by them reversed scatters the bookmarks over time and authors.
  const order =
    options.order === "spread"
      ? "substr(b.post_id, -1), substr(b.post_id, -2, 1), substr(b.post_id, -3, 1), b.post_id"
      : "bookmarkedAt DESC, b.id DESC";
  return {
    total:
      db
        .prepare<typeof parameters, number>(`SELECT count(*) ${from}`)
        .pluck()
        .get(parameters) ?? 0,
    bookmarks: db
      .prepare<typeof parameters, BookmarkRow>(
        `${SELECT_BOOKMARK_COLUMNS} ${from} ORDER BY ${order} LIMIT @limit`,
      )
      .all({ ...parameters, limit })
      .map(bookmarkFromRow),
  };
}

/** Why the classifier has no answer for a bookmark it was asked about. */
export type ClassificationFailureReason =
  | "refused"
  | "cut-short"
  | "invalid-output"
  | "rejected";

/**
 * Records that the classifier was asked about a bookmark and gave nothing
 * usable. A code and a count: nothing the post or the model said. The
 * record goes when the bookmark is classified.
 */
export function recordClassificationFailure(
  store: Store,
  failure: {
    postId: string;
    reason: ClassificationFailureReason;
    instructionsVersion: number;
    failedAt?: Date;
  },
): void {
  connectionOf(store)
    .prepare(
      `INSERT INTO classification_failures (
         post_id, reason, attempts, taxonomy_version, instructions_version, failed_at
       )
       VALUES (@postId, @reason, 1, @taxonomyVersion, @instructionsVersion, @failedAt)
       ON CONFLICT (post_id) DO UPDATE SET
         reason = excluded.reason,
         attempts = CASE
           WHEN taxonomy_version = excluded.taxonomy_version
            AND instructions_version = excluded.instructions_version
           THEN attempts + 1 ELSE 1 END,
         taxonomy_version = excluded.taxonomy_version,
         instructions_version = excluded.instructions_version,
         failed_at = excluded.failed_at`,
    )
    .run({
      postId: failure.postId,
      reason: failure.reason,
      taxonomyVersion: TAXONOMY.version,
      instructionsVersion: versionOf(failure.instructionsVersion),
      failedAt: (failure.failedAt ?? new Date()).getTime(),
    });
}

/** Tokens as the API reports them for a request, summed over a run. */
export interface TokenUsage {
  /** Input tokens at the full price. */
  inputTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens: number;
  /** Input tokens read from the prompt cache. */
  cacheReadTokens: number;
  /** Output tokens, the model's thinking included. */
  outputTokens: number;
}

export type TaggingRunOutcome =
  | "completed"
  | "stopped-at-cap"
  | "failed"
  | "abandoned";

/** One run of the classifier. */
export interface TaggingRun extends TokenUsage {
  id: number;
  startedAt: Date;
  /** When it last made progress. */
  heartbeatAt: Date;
  /** Null while the run is open. */
  finishedAt: Date | null;
  /** `owner` for a run the owner started; `app` for one of the app's own passes. */
  startedBy: "owner" | "app";
  /**
   * `new-tags` asks again about bookmarks classified before a tag joined
   * the vocabulary, and only ever adds such tags to them.
   */
  mode: "sample" | "untagged" | "retag" | "new-tags";
  transport: "direct" | "batch";
  model: string;
  taxonomyVersion: number;
  instructionsVersion: number;
  /** The version of the tag vocabulary the run asked with. */
  vocabularyVersion: number;
  /** Null while the run is open. */
  outcome: TaggingRunOutcome | null;
  /** Why a failed run failed: a code, never anything from a post. */
  failure: string | null;
  /** The API's id for the batch, for a run that has submitted one. */
  batchId: string | null;
  /** The bookmarks of that batch, in the order of its requests. */
  batchPostIds: string[] | null;
  /** How many bookmarks the run set out to classify. */
  selected: number;
  classified: number;
  failed: number;
  /** In US dollars, worked out from the tokens and the prices of the day. The invoice is the authority. */
  costUsd: number;
  /**
   * Attempts that went out and brought no answer back: a timeout, a dropped
   * connection. The API may have charged for each. They are in no token
   * count, and so not in `costUsd`.
   */
  unansweredRequests: number;
  /**
   * What the run held against its cap for those attempts: each at the most
   * a request of the run could cost. Not in `costUsd`. What a run may have
   * cost at the most is the two together.
   */
  heldUsd: number;
  /** Of `classified`: bookmarks with nothing worth sending, dealt with without a request. */
  filedWithoutRequest: number;
  /** The most the run was allowed to spend. */
  capUsd: number;
}

interface RunRow {
  id: number;
  startedAt: number;
  heartbeatAt: number;
  finishedAt: number | null;
  startedBy: TaggingRun["startedBy"];
  mode: TaggingRun["mode"];
  transport: TaggingRun["transport"];
  model: string;
  taxonomyVersion: number;
  instructionsVersion: number;
  vocabularyVersion: number;
  outcome: TaggingRunOutcome | null;
  failure: string | null;
  batchId: string | null;
  batchPostIds: string | null;
  selected: number;
  classified: number;
  failed: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  unansweredRequests: number;
  heldUsd: number;
  filedWithoutRequest: number;
  capUsd: number;
}

const SELECT_RUN = `
  SELECT id, started_at AS startedAt, heartbeat_at AS heartbeatAt,
         finished_at AS finishedAt, started_by AS startedBy, mode, transport,
         model, taxonomy_version AS taxonomyVersion,
         instructions_version AS instructionsVersion,
         vocabulary_version AS vocabularyVersion, outcome, failure,
         batch_id AS batchId, batch_post_ids AS batchPostIds, selected,
         classified, failed, input_tokens AS inputTokens,
         cache_write_tokens AS cacheWriteTokens,
         cache_read_tokens AS cacheReadTokens, output_tokens AS outputTokens,
         cost_usd AS costUsd, unanswered_requests AS unansweredRequests,
         held_usd AS heldUsd, filed_without_request AS filedWithoutRequest,
         cap_usd AS capUsd
  FROM tagging_runs`;

function runFromRow(row: RunRow): TaggingRun {
  return {
    ...row,
    startedAt: new Date(row.startedAt),
    heartbeatAt: new Date(row.heartbeatAt),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt),
    batchPostIds:
      row.batchPostIds === null
        ? null
        : (JSON.parse(row.batchPostIds) as string[]),
  };
}

function runById(db: Connection, id: number): TaggingRun {
  const row = db
    .prepare<[number], RunRow>(`${SELECT_RUN} WHERE id = ?`)
    .get(id);
  if (row === undefined) throw new Error(`There is no tagging run ${id}.`);
  return runFromRow(row);
}

/**
 * A run that has made no progress for this long, and waits on no batch, is
 * taken to have died with its process, and no longer stands in the way of
 * the next.
 */
export const TAGGING_RUN_STALE_MS = 10 * 60 * 1000;

/** Thrown by `startTaggingRun` while another run is open. `run` is that run. */
export class TaggingRunInProgress extends Error {
  readonly run: TaggingRun;
  constructor(run: TaggingRun) {
    super(
      run.batchId === null
        ? `Tagging run ${run.id} is in progress. Only one runs at a time, so that no bookmark is paid for twice.`
        : `Tagging run ${run.id} is waiting for the results of a batch. They are taken up before another run starts.`,
    );
    this.name = "TaggingRunInProgress";
    this.run = run;
  }
}

/**
 * Thrown when progress or an ending is written for a run that is no longer
 * open. Two processes can both take up the same waiting batch, and the one
 * that finishes second finds the run already closed by the first.
 */
export class TaggingRunNotOpen extends Error {
  constructor(id: number) {
    super(`Tagging run ${id} is not open.`);
    this.name = "TaggingRunNotOpen";
  }
}

function openRun(db: Connection): TaggingRun | undefined {
  const row = db
    .prepare<[], RunRow>(
      `${SELECT_RUN} WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get();
  return row && runFromRow(row);
}

/**
 * The run that is open, if one is: at work in some process, or waiting for
 * a batch whose results are still to be taken up.
 */
export function getOpenTaggingRun(store: Store): TaggingRun | undefined {
  return openRun(connectionOf(store));
}

export interface NewTaggingRun {
  startedBy: TaggingRun["startedBy"];
  mode: TaggingRun["mode"];
  transport: TaggingRun["transport"];
  model: string;
  instructionsVersion: number;
  /** The version of the vocabulary the run asks with: the current one unless said. */
  vocabularyVersion?: number;
  selected: number;
  capUsd: number;
  now?: Date;
}

/**
 * Opens a run, and with it the one place at the classifier's table: while
 * it is open no other run starts. A run left open by a process that died
 * is closed as abandoned once it has been silent for
 * `TAGGING_RUN_STALE_MS`; a run that waits for a batch is never abandoned
 * this way, because its results are paid for.
 */
export function startTaggingRun(store: Store, run: NewTaggingRun): TaggingRun {
  const db = connectionOf(store);
  const now = (run.now ?? new Date()).getTime();
  const start = db.transaction(() => {
    const open = openRun(db);
    if (open !== undefined) {
      if (
        open.batchId !== null ||
        now - open.heartbeatAt.getTime() < TAGGING_RUN_STALE_MS
      ) {
        throw new TaggingRunInProgress(open);
      }
      db.prepare(
        "UPDATE tagging_runs SET outcome = 'abandoned', finished_at = ? WHERE id = ?",
      ).run(now, open.id);
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO tagging_runs (
           started_at, heartbeat_at, started_by, mode, transport, model,
           taxonomy_version, instructions_version, vocabulary_version,
           selected, cap_usd
         )
         VALUES (
           @now, @now, @startedBy, @mode, @transport, @model,
           @taxonomyVersion, @instructionsVersion, @vocabularyVersion,
           @selected, @capUsd
         )`,
      )
      .run({
        now,
        startedBy: run.startedBy,
        mode: run.mode,
        transport: run.transport,
        model: run.model,
        taxonomyVersion: TAXONOMY.version,
        instructionsVersion: versionOf(run.instructionsVersion),
        vocabularyVersion: run.vocabularyVersion ?? vocabularyVersion(db),
        selected: run.selected,
        capUsd: run.capUsd,
      });
    return runById(db, Number(lastInsertRowid));
  });
  return start.immediate();
}

/** Where a run stands: totals so far, not additions to them. */
export interface TaggingProgress extends TokenUsage {
  classified: number;
  failed: number;
  costUsd: number;
  /** Attempts that brought no answer back. Left as it was when not given. */
  unansweredRequests?: number | undefined;
  /** What the run holds against its cap for them. Left as it was when not given. */
  heldUsd?: number | undefined;
  /** Of `classified`, those dealt with without a request. Left as it was when not given. */
  filedWithoutRequest?: number | undefined;
  /** Set once, when a batch has been submitted. */
  batch?: { id: string; postIds: readonly string[] } | undefined;
  now?: Date | undefined;
}

/** Writes where an open run stands, and that it is alive. */
export function recordTaggingProgress(
  store: Store,
  id: number,
  progress: TaggingProgress,
): void {
  const { changes } = connectionOf(store)
    .prepare(
      `UPDATE tagging_runs SET
         heartbeat_at = @now,
         classified = @classified,
         failed = @failed,
         input_tokens = @inputTokens,
         cache_write_tokens = @cacheWriteTokens,
         cache_read_tokens = @cacheReadTokens,
         output_tokens = @outputTokens,
         cost_usd = @costUsd,
         unanswered_requests = coalesce(@unansweredRequests, unanswered_requests),
         held_usd = coalesce(@heldUsd, held_usd),
         filed_without_request = coalesce(@filedWithoutRequest, filed_without_request),
         batch_id = coalesce(@batchId, batch_id),
         batch_post_ids = coalesce(@batchPostIds, batch_post_ids)
       WHERE id = @id AND finished_at IS NULL`,
    )
    .run({
      id,
      now: (progress.now ?? new Date()).getTime(),
      classified: progress.classified,
      failed: progress.failed,
      inputTokens: progress.inputTokens,
      cacheWriteTokens: progress.cacheWriteTokens,
      cacheReadTokens: progress.cacheReadTokens,
      outputTokens: progress.outputTokens,
      costUsd: progress.costUsd,
      unansweredRequests: progress.unansweredRequests ?? null,
      heldUsd: progress.heldUsd ?? null,
      filedWithoutRequest: progress.filedWithoutRequest ?? null,
      batchId: progress.batch?.id ?? null,
      batchPostIds:
        progress.batch === undefined
          ? null
          : JSON.stringify(progress.batch.postIds),
    });
  if (changes === 0) throw new TaggingRunNotOpen(id);
}

/** Closes a run. `failure` is a code for why a failed run failed, never content. */
export function finishTaggingRun(
  store: Store,
  id: number,
  result: { outcome: TaggingRunOutcome; failure?: string; now?: Date },
): TaggingRun {
  const db = connectionOf(store);
  const { changes } = db
    .prepare(
      `UPDATE tagging_runs SET outcome = @outcome, failure = @failure, finished_at = @now
       WHERE id = @id AND finished_at IS NULL`,
    )
    .run({
      id,
      outcome: result.outcome,
      failure: result.failure ?? null,
      now: (result.now ?? new Date()).getTime(),
    });
  if (changes === 0) throw new TaggingRunNotOpen(id);
  return runById(db, id);
}

/**
 * Closes a run together with the last of its work. `work` is called only if
 * the run is still open, and what it writes and the closing are one change
 * to the library: all of it, or, if `work` throws or another process closed
 * the run first, none of it. Returns the closed run, or undefined when the
 * run was no longer open and `work` was not called.
 *
 * This is how a batch's results are stored. Two processes can take up the
 * same waiting batch, and one can die halfway through storing it; a failure
 * is a count on a bookmark, so results stored twice, or stored in part and
 * then again, would count each failure twice.
 */
export function finishTaggingRunWith(
  store: Store,
  id: number,
  work: () => { outcome: TaggingRunOutcome; failure?: string; now?: Date },
): TaggingRun | undefined {
  const db = connectionOf(store);
  const finish = db.transaction(() => {
    const open = db
      .prepare<[number], number>(
        "SELECT 1 FROM tagging_runs WHERE id = ? AND finished_at IS NULL",
      )
      .pluck()
      .get(id);
    if (open === undefined) return undefined;
    return finishTaggingRun(store, id, work());
  });
  return finish.immediate();
}

/** What the runs of one starter have spent, and may have spent, since a moment. */
export interface TaggingSpend {
  runs: number;
  /** From the tokens the API reported. */
  costUsd: number;
  /** Held for attempts that brought no answer, which the API may have charged for. */
  heldUsd: number;
}

/**
 * What every run `startedBy` began at or after `since` has cost, open runs
 * included, however many there were. An allowance for a period is taken
 * over `costUsd` and `heldUsd` together.
 */
export function summariseTaggingSpend(
  store: Store,
  options: { startedBy: TaggingRun["startedBy"]; since: Date },
): TaggingSpend {
  const spend = connectionOf(store)
    .prepare<[string, number], TaggingSpend>(
      `SELECT count(*) AS runs, coalesce(sum(cost_usd), 0) AS costUsd,
              coalesce(sum(held_usd), 0) AS heldUsd
       FROM tagging_runs WHERE started_by = ? AND started_at >= ?`,
    )
    .get(options.startedBy, options.since.getTime());
  if (spend === undefined) {
    throw new Error("An aggregate query returned no row.");
  }
  return spend;
}

/** One run by its id, open or closed. */
export function getTaggingRun(store: Store, id: number): TaggingRun {
  return runById(connectionOf(store), id);
}

/** The latest runs, newest first: 20 unless `limit` says otherwise, 100 at most. */
export function listTaggingRuns(
  store: Store,
  options: { limit?: number } = {},
): TaggingRun[] {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(
      `limit must be a whole number from 1 to 100; got ${limit}.`,
    );
  }
  return connectionOf(store)
    .prepare<[number], RunRow>(`${SELECT_RUN} ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map(runFromRow);
}

/** How the tagging of the library stands. Bookmarks removed on X are counted like any other. */
export interface TaggingSummary {
  bookmarks: number;
  /** Bookmarks the classifier has an answer for. */
  classified: number;
  /** Bookmarks it has none for, those it failed on among them. */
  unclassified: number;
  /** Of the unclassified, those it was asked about and gave nothing usable for. */
  failed: number;
  /** Classified under an older taxonomy or under older instructions than the current ones. */
  outdated: number;
  /**
   * Classified before some tag joined the vocabulary, and so never asked
   * about it. `mentioningNewTags` are those of them whose text mentions such
   * a tag and that do not have it: what a `new-tags` pass would take. The
   * rest say nothing that suggests the new tag.
   */
  behindVocabulary: number;
  mentioningNewTags: number;
  /** Bookmarks with a category, format or tag the owner set. */
  corrected: number;
  /**
   * Bookmarks filed under "other", by the owner's word or the classifier's.
   * `noneOfTheAbove` is the number to watch: a growing share of bookmarks
   * that had text enough and still fitted no category means the taxonomy is
   * wrong. `tooLittleText` is a fact about the bookmarks, not the taxonomy.
   */
  other: {
    bookmarks: number;
    tooLittleText: number;
    noneOfTheAbove: number;
    /** `bookmarks` as a share of the filed bookmarks, from 0 to 1. Zero when none is filed. */
    share: number;
    /** `noneOfTheAbove` as a share of the filed bookmarks. */
    noneOfTheAboveShare: number;
  };
  /** Bookmarks whose format is "unclear". */
  unclearFormat: number;
  /** How many different tags the classifier has suggested beyond the vocabulary. */
  proposals: number;
  /** What every run so far has spent, in US dollars, and what those since a day ago have. */
  spentUsd: number;
  spentLastDayUsd: number;
  /** The run that is open, or else the latest one. Null before the first. */
  lastRun: TaggingRun | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Totals for the classifier's report and for a status screen. A bookmark is
 * outdated when it was classified under an older taxonomy or under older
 * instructions than the current ones, `TAXONOMY.version` and
 * `INSTRUCTIONS_VERSION`; `instructionsVersion` is for a caller that has to
 * count against another version.
 */
export function summariseTagging(
  store: Store,
  options: { instructionsVersion?: number; now?: Date } = {},
): TaggingSummary {
  const db = connectionOf(store);
  const now = (options.now ?? new Date()).getTime();
  const counts = db
    .prepare<
      { taxonomyVersion: number; instructionsVersion: number },
      {
        bookmarks: number;
        classified: number;
        failed: number;
        outdated: number;
        behindVocabulary: number;
        corrected: number;
        filed: number;
        other: number;
        tooLittleText: number;
        unclearFormat: number;
      }
    >(
      `SELECT count(*) AS bookmarks,
              count(cl.post_id) AS classified,
              count(*) FILTER (WHERE cl.post_id IS NULL AND EXISTS (
                SELECT 1 FROM classification_failures f
                WHERE f.post_id = b.post_id)) AS failed,
              count(*) FILTER (
                WHERE cl.taxonomy_version < @taxonomyVersion
                   OR cl.instructions_version < @instructionsVersion) AS outdated,
              count(*) FILTER (WHERE ${BEHIND_VOCABULARY}) AS behindVocabulary,
              count(*) FILTER (WHERE co.post_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM bookmark_tag_corrections x
                WHERE x.post_id = b.post_id)) AS corrected,
              count(${CATEGORY}) AS filed,
              count(*) FILTER (WHERE ${CATEGORY} = '${OTHER_CATEGORY}') AS other,
              count(*) FILTER (WHERE ${TOO_LITTLE_TEXT}) AS tooLittleText,
              count(*) FILTER (WHERE ${FORMAT} = '${UNCLEAR_FORMAT}') AS unclearFormat
       ${FROM_BOOKMARKS}`,
    )
    .get({
      taxonomyVersion: TAXONOMY.version,
      instructionsVersion: versionOf(
        options.instructionsVersion ?? INSTRUCTIONS_VERSION,
      ),
    });
  if (counts === undefined) {
    throw new Error("An aggregate query returned no row.");
  }
  const spent = db
    .prepare<[number], { all: number; lastDay: number }>(
      `SELECT coalesce(sum(cost_usd), 0) AS "all",
              coalesce(sum(cost_usd) FILTER (WHERE started_at >= ?), 0) AS lastDay
       FROM tagging_runs`,
    )
    .get(now - DAY_MS) ?? { all: 0, lastDay: 0 };
  const lastRun = db
    .prepare<[], RunRow>(`${SELECT_RUN} ORDER BY id DESC LIMIT 1`)
    .get();
  const noneOfTheAbove = counts.other - counts.tooLittleText;
  const share = (part: number) =>
    counts.filed === 0 ? 0 : part / counts.filed;
  return {
    bookmarks: counts.bookmarks,
    classified: counts.classified,
    unclassified: counts.bookmarks - counts.classified,
    failed: counts.failed,
    outdated: counts.outdated,
    behindVocabulary: counts.behindVocabulary,
    mentioningNewTags:
      counts.behindVocabulary === 0 ? 0 : mentioningNewTags(db).length,
    corrected: counts.corrected,
    other: {
      bookmarks: counts.other,
      tooLittleText: counts.tooLittleText,
      noneOfTheAbove,
      share: share(counts.other),
      noneOfTheAboveShare: share(noneOfTheAbove),
    },
    unclearFormat: counts.unclearFormat,
    proposals:
      db
        .prepare<[], number>(
          `SELECT count(DISTINCT p.value)
           FROM bookmark_classifications c, json_each(c.proposed_tags) AS p`,
        )
        .pluck()
        .get() ?? 0,
    spentUsd: spent.all,
    spentLastDayUsd: spent.lastDay,
    lastRun: lastRun === undefined ? null : runFromRow(lastRun),
  };
}
