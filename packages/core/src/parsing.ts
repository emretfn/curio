import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { estimateBookmarkedAt, upsertBookmark } from "./bookmarks.ts";
import { recordMutation } from "./mutations.ts";
import { PARSER_VERSION, parserFor } from "./parsers/index.ts";
import type { CaptureParser, ParsedCapture } from "./parsers/parsed.ts";
import {
  getRawCapture,
  listRawCaptureIds,
  type RawCapture,
} from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";

/**
 * What became of a capture when it was last parsed.
 *
 * - `parsed`: the response was understood. It may hold no bookmarks, and
 *   single entries in it may still have failed: see `failedEntryCount`.
 * - `failed`: the response as a whole was not understood, and nothing was
 *   taken from it.
 * - `no-parser`: nothing parses this operation yet. Not a failure: the
 *   capture is kept for the day a parser exists.
 */
export type ParseOutcome = "parsed" | "failed" | "no-parser";

/** The recorded result of the latest parse of one raw capture. */
export interface CaptureParse {
  captureId: number;
  outcome: ParseOutcome;
  /** The `PARSER_VERSION` that produced this result. */
  parserVersion: number;
  /** Entries that were stored as bookmarks. */
  bookmarkCount: number;
  /** Bookmarks whose post X withheld. */
  unavailableCount: number;
  /** Entries that were not understood, and from which nothing was taken. */
  failedEntryCount: number;
  /** Parts of the response that were left empty. */
  warningCount: number;
  /** When this result was recorded. A re-parse that finds the same result leaves it. */
  parsedAt: Date;
}

/**
 * - `capture-failed`: why a `failed` capture was not understood.
 * - `entry-failed`: one entry that was not understood.
 * - `post-unavailable`: one bookmark whose post X withholds.
 * - `warning`: a part that was left empty while the bookmark was stored.
 */
export type ParseIssueKind =
  | "capture-failed"
  | "entry-failed"
  | "post-unavailable"
  | "warning";

/**
 * One thing the latest parse of a capture could not turn into a bookmark, or
 * could only partly. It describes structure, never content: a path into the
 * payload, field names and type names.
 */
export interface ParseIssue {
  captureId: number;
  kind: ParseIssueKind;
  /** Position of the entry among the capture's entries, or null for the capture as a whole. */
  entryIndex: number | null;
  /** X's id for the timeline entry, when it could be read. */
  entryId: string | null;
  /** The post concerned, when its id could be read. */
  postId: string | null;
  /** A short, stable name for the kind of mismatch, such as `missing-field`. */
  code: string;
  /** Where in the payload understanding stopped, as a JSON path from `$`. */
  path: string;
  /** What was expected there and what was found. */
  detail: string;
}

type NewIssue = Omit<ParseIssue, "captureId">;

interface CaptureParseRow extends Omit<CaptureParse, "parsedAt"> {
  parsedAt: number;
}

const SELECT_CAPTURE_PARSE = `
  SELECT capture_id AS captureId, outcome, parser_version AS parserVersion,
         bookmark_count AS bookmarkCount, unavailable_count AS unavailableCount,
         failed_entry_count AS failedEntryCount, warning_count AS warningCount,
         parsed_at AS parsedAt
  FROM capture_parses`;

const SELECT_PARSE_ISSUE = `
  SELECT capture_id AS captureId, kind, entry_index AS entryIndex,
         entry_id AS entryId, post_id AS postId, code, path, detail
  FROM parse_issues`;

/**
 * Describes something a parser or the database threw, without its message
 * where the message could quote the response.
 */
function describeThrown(error: unknown): string {
  if (error instanceof Database.SqliteError) {
    // SQLite names the constraint, never the offending value.
    return `${error.code}: ${error.message}`;
  }
  if (!(error instanceof Error)) return "something other than an Error";
  const frame = /at (\S+) \(.*?([^/\\]+:\d+):\d+\)/.exec(error.stack ?? "");
  return frame === null
    ? error.name
    : `${error.name} in ${frame[1]} (${frame[2]})`;
}

function runParser(parse: CaptureParser, capture: RawCapture): ParsedCapture {
  try {
    return parse(capture.payload, capture.requestBody);
  } catch (error) {
    // A shape mismatch is returned, not thrown, so this is a bug in the
    // parser. It is recorded like any other failure instead of being lost.
    return {
      outcome: "failed",
      issue: {
        code: "parser-crashed",
        path: "$",
        detail: describeThrown(error),
      },
    };
  }
}

/**
 * Parses one stored raw capture with the parser for its source and operation,
 * upserts the bookmarks it holds, notes the bookmark it says was made or
 * removed, and records what happened: the outcome and every entry or part
 * that was not understood. Nothing is thrown for a
 * response the parser does not understand; that is a recorded outcome.
 *
 * Safe to run again on the same capture, with the same or a newer parser. The
 * raw capture is only read. First-seen times are set by `upsertBookmark` and
 * never moved, and a run that finds what is already recorded changes nothing.
 */
export function parseCapture(store: Store, captureId: number): CaptureParse {
  return recordParse(store, captureId).parse;
}

/**
 * Package-internal: `parseCapture` with the parser handed in instead of
 * looked up. Tests use it to show what happens when a parser misbehaves, and
 * when a later version of a parser reads what an earlier one could not.
 */
export function parseCaptureWith(
  store: Store,
  captureId: number,
  parser: CaptureParser | undefined,
): CaptureParse {
  return recordParse(store, captureId, () => parser).parse;
}

function recordParse(
  store: Store,
  captureId: number,
  parserOf: (capture: RawCapture) => CaptureParser | undefined = (capture) =>
    parserFor(capture.source, capture.operation),
): { parse: CaptureParse; changed: boolean } {
  const capture = getRawCapture(store, captureId);
  if (capture === undefined) {
    throw new Error(`Raw capture ${captureId} does not exist.`);
  }
  const parser = parserOf(capture);
  const parsed = parser === undefined ? undefined : runParser(parser, capture);

  const db = connectionOf(store);
  const record = db.transaction(() => {
    const issues: NewIssue[] = [];
    let bookmarkCount = 0;
    if (parsed?.outcome === "failed") {
      issues.push({
        kind: "capture-failed",
        entryIndex: null,
        entryId: null,
        postId: null,
        ...parsed.issue,
      });
    }
    if (parsed?.outcome === "parsed") {
      if (parsed.mutation !== undefined) {
        recordMutation(store, parsed.mutation, captureId);
      }
      for (const issue of parsed.warnings) {
        issues.push({
          kind: "warning",
          entryIndex: null,
          entryId: null,
          postId: null,
          ...issue,
        });
      }
      for (const entry of parsed.entries) {
        const about = { entryIndex: entry.index, entryId: entry.entryId };
        if (entry.kind === "failed") {
          issues.push({
            kind: "entry-failed",
            ...about,
            postId: entry.postId,
            ...entry.issue,
          });
          continue;
        }
        if (entry.kind === "unavailable") {
          issues.push({
            kind: "post-unavailable",
            ...about,
            postId: entry.postId,
            code: "post-unavailable",
            path: entry.withheldAt,
            detail: entry.detail,
          });
          continue;
        }
        const { postId, postedAt, sortIndex } = entry.bookmark;
        try {
          upsertBookmark(store, { ...entry.bookmark, captureId });
        } catch (error) {
          issues.push({
            kind: "entry-failed",
            ...about,
            postId,
            code: "not-storable",
            path: entry.path,
            detail: describeThrown(error),
          });
          continue;
        }
        bookmarkCount += 1;
        for (const issue of entry.warnings) {
          issues.push({ kind: "warning", ...about, postId, ...issue });
        }
        if (
          sortIndex !== null &&
          estimateBookmarkedAt(sortIndex, postedAt, capture.receivedAt) === null
        ) {
          // The estimate rests on an observation about sortIndex, not on a
          // contract. If X changes what the value means, this is where it shows.
          issues.push({
            kind: "warning",
            ...about,
            postId,
            code: "invalid-value",
            path: `${entry.path}.sortIndex`,
            detail:
              "expected sortIndex >> 20 to be a time between the post's and the capture's; no bookmark time was estimated",
          });
        }
      }
    }

    const result: Omit<CaptureParseRow, "parsedAt"> = {
      captureId,
      outcome: parsed?.outcome ?? "no-parser",
      parserVersion: PARSER_VERSION,
      bookmarkCount,
      unavailableCount: issues.filter(
        (issue) => issue.kind === "post-unavailable",
      ).length,
      failedEntryCount: issues.filter((issue) => issue.kind === "entry-failed")
        .length,
      warningCount: issues.filter((issue) => issue.kind === "warning").length,
    };

    // A result identical to the recorded one is not written again, so that
    // re-parsing everything with an unchanged parser changes nothing.
    const previous = db
      .prepare<[number], CaptureParseRow>(
        `${SELECT_CAPTURE_PARSE} WHERE capture_id = ?`,
      )
      .get(captureId);
    if (previous !== undefined) {
      const { parsedAt, ...recorded } = previous;
      const recordedIssues = listParseIssues(store, captureId).map(
        ({ captureId: _, ...issue }) => issue,
      );
      if (
        isDeepStrictEqual(recorded, result) &&
        isDeepStrictEqual(recordedIssues, issues)
      ) {
        return {
          parse: { ...result, parsedAt: new Date(parsedAt) },
          changed: false,
        };
      }
    }

    const parsedAt = Date.now();
    db.prepare("DELETE FROM parse_issues WHERE capture_id = ?").run(captureId);
    db.prepare(
      `INSERT INTO capture_parses (
         capture_id, outcome, parser_version, bookmark_count,
         unavailable_count, failed_entry_count, warning_count, parsed_at
       )
       VALUES (
         @captureId, @outcome, @parserVersion, @bookmarkCount,
         @unavailableCount, @failedEntryCount, @warningCount, @parsedAt
       )
       ON CONFLICT (capture_id) DO UPDATE SET
         outcome = excluded.outcome,
         parser_version = excluded.parser_version,
         bookmark_count = excluded.bookmark_count,
         unavailable_count = excluded.unavailable_count,
         failed_entry_count = excluded.failed_entry_count,
         warning_count = excluded.warning_count,
         parsed_at = excluded.parsed_at`,
    ).run({ ...result, parsedAt });
    const insertIssue = db.prepare(
      `INSERT INTO parse_issues (
         capture_id, kind, entry_index, entry_id, post_id, code, path, detail
       )
       VALUES (
         @captureId, @kind, @entryIndex, @entryId, @postId, @code, @path, @detail
       )`,
    );
    for (const issue of issues) insertIssue.run({ captureId, ...issue });
    return {
      parse: { ...result, parsedAt: new Date(parsedAt) },
      changed: true,
    };
  });
  return record.immediate();
}

/**
 * Parses every stored capture that has never been parsed, oldest received
 * first, and returns their results. Run after storing a capture: it also
 * picks up any capture stored while no parsing was done, such as one written
 * by an older version of the app or left behind by a crash.
 */
export function parsePendingCaptures(store: Store): CaptureParse[] {
  const pending = connectionOf(store)
    .prepare<[], number>(
      `SELECT id FROM raw_captures
       WHERE id NOT IN (SELECT capture_id FROM capture_parses)
       ORDER BY received_at, id`,
    )
    .pluck()
    .all() as number[];
  return pending.map((captureId) => parseCapture(store, captureId));
}

/** What a full re-parse did. */
export interface ReparseResult {
  /** Captures parsed, which is every stored capture. */
  captures: number;
  /** Captures whose recorded result differs from before the run. */
  changed: number;
}

/**
 * Parses every stored capture again with the current parsers, oldest
 * received first, and brings the bookmarks and the recorded results up to
 * date. Run it after fixing or adding a parser.
 *
 * Raw captures are only read, and no first-seen time moves. Running it twice
 * in a row changes nothing the second time.
 */
export function reparseAllCaptures(store: Store): ReparseResult {
  const ids = listRawCaptureIds(store);
  const changed = ids.filter(
    (captureId) => recordParse(store, captureId).changed,
  ).length;
  return { captures: ids.length, changed };
}

/** Totals over every capture's latest parse, for a status display. */
export interface ParsingSummary {
  /** Bookmarks in the library. */
  bookmarks: number;
  captures: {
    parsed: number;
    failed: number;
    noParser: number;
    /** Stored but never parsed. `parsePendingCaptures` or a re-parse clears these. */
    pending: number;
    /** Last parsed by another `PARSER_VERSION` than this code's. A re-parse clears these. */
    outdated: number;
  };
  /** Entries, in captures that were themselves understood, that were not. */
  failedEntries: number;
  /** Bookmarks whose post X withheld. */
  unavailableEntries: number;
  /** Parts left empty in bookmarks that were stored. */
  warnings: number;
  /** When a parse result was last recorded, or null when none has been. */
  lastParsedAt: Date | null;
}

export function summariseParsing(store: Store): ParsingSummary {
  const row = connectionOf(store)
    .prepare<
      { version: number },
      {
        bookmarks: number;
        parsed: number;
        failed: number;
        noParser: number;
        pending: number;
        outdated: number;
        failedEntries: number;
        unavailableEntries: number;
        warnings: number;
        lastParsedAt: number | null;
      }
    >(
      `SELECT
         (SELECT count(*) FROM bookmarks) AS bookmarks,
         count(*) FILTER (WHERE outcome = 'parsed') AS parsed,
         count(*) FILTER (WHERE outcome = 'failed') AS failed,
         count(*) FILTER (WHERE outcome = 'no-parser') AS noParser,
         (SELECT count(*) FROM raw_captures) - count(*) AS pending,
         count(*) FILTER (WHERE parser_version <> @version) AS outdated,
         coalesce(sum(failed_entry_count), 0) AS failedEntries,
         coalesce(sum(unavailable_count), 0) AS unavailableEntries,
         coalesce(sum(warning_count), 0) AS warnings,
         max(parsed_at) AS lastParsedAt
       FROM capture_parses`,
    )
    .get({ version: PARSER_VERSION });
  if (row === undefined) {
    throw new Error("An aggregate query returned no row.");
  }
  const { parsed, failed, noParser, pending, outdated, lastParsedAt } = row;
  return {
    bookmarks: row.bookmarks,
    captures: { parsed, failed, noParser, pending, outdated },
    failedEntries: row.failedEntries,
    unavailableEntries: row.unavailableEntries,
    warnings: row.warnings,
    lastParsedAt: lastParsedAt === null ? null : new Date(lastParsedAt),
  };
}

export function getCaptureParse(
  store: Store,
  captureId: number,
): CaptureParse | undefined {
  const row = connectionOf(store)
    .prepare<[number], CaptureParseRow>(
      `${SELECT_CAPTURE_PARSE} WHERE capture_id = ?`,
    )
    .get(captureId);
  return row && { ...row, parsedAt: new Date(row.parsedAt) };
}

/**
 * The issues recorded by the latest parse, of one capture or of all, in
 * capture and entry order.
 */
export function listParseIssues(
  store: Store,
  captureId?: number,
): ParseIssue[] {
  return connectionOf(store)
    .prepare<{ captureId: number | null }, ParseIssue>(
      `${SELECT_PARSE_ISSUE}
       WHERE @captureId IS NULL OR capture_id = @captureId
       ORDER BY capture_id, id`,
    )
    .all({ captureId: captureId ?? null });
}
