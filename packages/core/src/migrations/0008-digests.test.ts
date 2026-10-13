import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { getBookmark } from "../bookmarks.ts";
import { getDigest, listDigestRuns, listWeeks } from "../digests.ts";
import { applyMigrations } from "../migrate.ts";
import { summariseTagging } from "../tagging.ts";
import { openTempStore, tempDatabasePath } from "../testing/temp-database.ts";
import { migrations } from "./index.ts";

const posted = Date.parse("2026-04-08T06:30:15.000Z");
const received = Date.parse("2026-10-05T09:00:00.000Z");
const POST = "1975000000000000001";

/** A database as migration 7 left it, holding one capture, the bookmark parsed from it and its classification. */
function databaseAtMigration7(): string {
  const path = tempDatabasePath();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 7));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES ('x-web-client', 'Bookmarks', '{}', ?)",
  ).run(received);
  db.prepare(
    `INSERT INTO bookmarks (
       post_id, author_id, author_handle, author_name, text, posted_at,
       first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
     ) VALUES (?, '44196397', 'someone', 'Some One', 'kept as it was', ?, ?, 1, ?, 1)`,
  ).run(POST, posted, received, received);
  db.prepare(
    `INSERT INTO bookmark_classifications (
       post_id, category, format, too_little_text, taxonomy_version,
       instructions_version, vocabulary_version, model, classified_at
     ) VALUES (?, 'web-dev', 'guide', 0, 1, 1, 1, 'a-model', ?)`,
  ).run(POST, received);
  db.close();
  return path;
}

/** The database as this migration left it, for what no function of core will do. */
function migrated(): Database.Database {
  const db = new Database(databaseAtMigration7());
  db.pragma("foreign_keys = ON");
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 8));
  return db;
}

test("a library from before the migration is unchanged, and has no digest and no run", () => {
  const store = openTempStore(databaseAtMigration7());

  expect(getBookmark(store, POST)).toMatchObject({
    text: "kept as it was",
    firstSeenAt: new Date(received),
    labels: { category: "web-dev", format: "guide" },
  });
  expect(summariseTagging(store)).toMatchObject({
    bookmarks: 1,
    classified: 1,
  });
  expect(listDigestRuns(store)).toEqual([]);
  expect(
    listWeeks(store).map(({ bookmarks, written }) => [bookmarks, written]),
  ).toEqual([[1, false]]);
  expect(getDigest(store, "2026-10-05")).toBeUndefined();
});

test("the migration adds one table and leaves the others' rows alone", () => {
  const db = migrated();
  const count = (table: string) =>
    db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();

  expect(count("bookmarks")).toBe(1);
  expect(count("raw_captures")).toBe(1);
  expect(count("bookmark_classifications")).toBe(1);
  expect(count("digest_runs")).toBe(0);
});

function insertRun(db: Database.Database, values: Record<string, unknown>) {
  return db
    .prepare(
      `INSERT INTO digest_runs (
         week, period_start_at, period_end_at, started_at, finished_at,
         started_by, model, instructions_version, outcome, failure,
         bookmarks_in_week, post_ids, cap_usd, body
       ) VALUES (
         @week, @start, @end, @at, @finishedAt, @startedBy, 'a-model', 1,
         @outcome, @failure, 1, @postIds, 0.5, @body
       )`,
    )
    .run({
      week: "2026-10-05",
      start: received,
      end: received + 7 * 24 * 3_600_000,
      at: received,
      finishedAt: null,
      startedBy: "owner",
      outcome: null,
      failure: null,
      postIds: JSON.stringify([POST]),
      body: null,
      ...values,
    });
}

test("a run is open until it has an outcome, and holds a text exactly when it wrote one", () => {
  const db = migrated();
  const body = JSON.stringify({
    overview: "o",
    themes: [],
    worthRevisiting: [],
  });
  const closed = { finishedAt: received + 60_000 };

  expect(() => insertRun(db, { outcome: "written", body })).toThrow(/CHECK/);
  expect(() => insertRun(db, { ...closed })).toThrow(/CHECK/);
  expect(() => insertRun(db, { ...closed, outcome: "written" })).toThrow(
    /CHECK/,
  );
  expect(() => insertRun(db, { ...closed, outcome: "failed", body })).toThrow(
    /CHECK/,
  );
  expect(() => insertRun(db, { body })).toThrow(/CHECK/);
  expect(() =>
    insertRun(db, { ...closed, outcome: "written", body }),
  ).not.toThrow();
  expect(() =>
    insertRun(db, { ...closed, outcome: "failed", failure: "refused" }),
  ).not.toThrow();
  expect(() =>
    insertRun(db, { ...closed, outcome: "abandoned" }),
  ).not.toThrow();
});

test("what a run stores is checked: its week, its times, who started it, its lists", () => {
  const db = migrated();

  for (const values of [
    { week: "2026-W41" },
    { week: "" },
    { start: 1_760_000_000 },
    { end: received },
    { at: 1_760_000_000 },
    { startedBy: "app" },
    { postIds: "not json" },
    { postIds: "{}" },
    { finishedAt: received, outcome: "completed" },
    { finishedAt: received, outcome: "failed", failure: "" },
    { finishedAt: received, outcome: "written", body: "[]" },
  ]) {
    expect(() => insertRun(db, values), JSON.stringify(values)).toThrow(
      /CHECK/,
    );
  }
});

test("only one run is open at a time, whichever process asks", () => {
  const db = migrated();

  insertRun(db, {});
  expect(() => insertRun(db, { week: "2026-09-28" })).toThrow(/UNIQUE/);
  db.prepare(
    "UPDATE digest_runs SET outcome = 'failed', failure = 'unreachable', finished_at = ?",
  ).run(received + 1);
  expect(() => insertRun(db, { week: "2026-09-28" })).not.toThrow();
});
