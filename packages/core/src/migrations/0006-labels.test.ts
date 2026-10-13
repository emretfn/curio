import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { getBookmark } from "../bookmarks.ts";
import { listBookmarks, searchBookmarks } from "../library.ts";
import { applyMigrations } from "../migrate.ts";
import { summariseTagging } from "../tagging.ts";
import { openTempStore, tempDatabasePath } from "../testing/temp-database.ts";
import { migrations } from "./index.ts";

const posted = Date.parse("2026-04-08T06:30:15.000Z");
const received = Date.parse("2026-10-05T09:00:00.000Z");
const POST = "1975000000000000001";

/** A database as migration 5 left it, holding one capture and the bookmark parsed from it. */
function databaseAtMigration5(): string {
  const path = tempDatabasePath();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 5));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES ('x-web-client', 'Bookmarks', '{}', ?)",
  ).run(received);
  db.prepare(
    `INSERT INTO bookmarks (
       post_id, author_id, author_handle, author_name, text, posted_at,
       first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
     ) VALUES (?, '44196397', 'someone', 'Some One', 'kept as it was', ?, ?, 1, ?, 1)`,
  ).run(POST, posted, received, received);
  db.close();
  return path;
}

/**
 * The database as this migration left it, for what no function of core
 * will do. Later migrations are not applied: what is tested here is what
 * this one made.
 */
function migrated(): Database.Database {
  const db = new Database(databaseAtMigration5());
  db.pragma("foreign_keys = ON");
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 6));
  return db;
}

test("a bookmark stored before the migration is unchanged, still found, and filed under nothing", () => {
  const store = openTempStore(databaseAtMigration5());

  expect(getBookmark(store, POST)).toMatchObject({
    text: "kept as it was",
    firstSeenAt: new Date(received),
    firstSeenCaptureId: 1,
    labels: {
      category: null,
      format: null,
      tags: [],
      corrected: { category: false, format: false, tags: false },
      classification: null,
    },
  });
  expect(searchBookmarks(store, { query: "kept" }).total).toBe(1);
  expect(listBookmarks(store, { classified: false }).total).toBe(1);
  expect(summariseTagging(store)).toMatchObject({
    bookmarks: 1,
    classified: 0,
    unclassified: 1,
    lastRun: null,
  });
});

test("the migration adds its tables and leaves the others' rows alone", () => {
  const db = migrated();
  const count = (table: string) =>
    db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();

  expect(count("bookmarks")).toBe(1);
  expect(count("raw_captures")).toBe(1);
  expect(count("bookmark_search")).toBe(1);
  for (const table of [
    "bookmark_classifications",
    "bookmark_tags",
    "bookmark_corrections",
    "bookmark_tag_corrections",
    "bookmark_effective_tags",
    "classification_failures",
    "tagging_runs",
  ]) {
    expect(count(table), table).toBe(0);
  }
});

const classify = (db: Database.Database, values: Record<string, unknown>) =>
  db
    .prepare(
      `INSERT INTO bookmark_classifications (
         post_id, category, format, too_little_text, taxonomy_version,
         instructions_version, model, classified_at
       ) VALUES (@postId, @category, @format, @tooLittleText, 1, 1, @model, @at)`,
    )
    .run({
      postId: POST,
      category: "web-dev",
      format: "guide",
      tooLittleText: 0,
      model: "a-model",
      at: received,
      ...values,
    });

test("a classification belongs to a bookmark, and one no model made says the text was too little", () => {
  const db = migrated();

  expect(() => classify(db, { postId: "1975000000000000999" })).toThrow(
    /FOREIGN KEY/,
  );
  expect(() => classify(db, { model: null })).toThrow(/CHECK/);
  expect(() => classify(db, { at: 1_760_000_000 })).toThrow(/CHECK/);
  expect(() =>
    classify(db, { model: null, tooLittleText: 1, category: "other" }),
  ).not.toThrow();
});

test("the tags a bookmark has are the classifier's, less what the owner removed, plus what the owner added", () => {
  const db = migrated();
  classify(db, {});
  const tag = db.prepare(
    "INSERT INTO bookmark_tags (post_id, tag) VALUES (?, ?)",
  );
  const correct = db.prepare(
    "INSERT INTO bookmark_tag_corrections (post_id, tag, action, corrected_at) VALUES (?, ?, ?, ?)",
  );
  for (const name of ["react", "nextjs", "tailwind"]) tag.run(POST, name);
  correct.run(POST, "nextjs", "remove", received);
  correct.run(POST, "tailwind", "add", received);
  correct.run(POST, "auth", "add", received);

  expect(
    db
      .prepare("SELECT tag FROM bookmark_effective_tags ORDER BY tag")
      .pluck()
      .all(),
  ).toEqual(["auth", "react", "tailwind"]);
  expect(() => correct.run(POST, "seo", "maybe", received)).toThrow(/CHECK/);
});

test("a run is open until it has an outcome, and a batch id comes with its bookmarks", () => {
  const db = migrated();
  const run = (values: Record<string, unknown>) =>
    db
      .prepare(
        `INSERT INTO tagging_runs (
           started_at, heartbeat_at, finished_at, started_by, mode, transport,
           model, taxonomy_version, instructions_version, outcome, batch_id,
           batch_post_ids, selected, cap_usd
         ) VALUES (
           @at, @at, @finishedAt, 'owner', 'untagged', 'batch', 'a-model', 1, 1,
           @outcome, @batchId, @batchPostIds, 1, 1.5
         )`,
      )
      .run({
        at: received,
        finishedAt: null,
        outcome: null,
        batchId: null,
        batchPostIds: null,
        ...values,
      });

  expect(() => run({ outcome: "completed" })).toThrow(/CHECK/);
  expect(() => run({ finishedAt: received })).toThrow(/CHECK/);
  expect(() => run({ batchId: "batch-1" })).toThrow(/CHECK/);
  expect(() => run({ outcome: "done", finishedAt: received })).toThrow(/CHECK/);
  expect(() =>
    run({ batchId: "batch-1", batchPostIds: JSON.stringify([POST]) }),
  ).not.toThrow();
  expect(() =>
    run({ outcome: "completed", finishedAt: received }),
  ).not.toThrow();
});

test("the database itself lets one run be open at a time, and any number be closed", () => {
  const db = migrated();
  const run = (outcome: string | null) =>
    db
      .prepare(
        `INSERT INTO tagging_runs (
           started_at, heartbeat_at, finished_at, started_by, mode, transport,
           model, taxonomy_version, instructions_version, outcome, selected, cap_usd
         ) VALUES (@at, @at, @finishedAt, 'app', 'untagged', 'direct', 'a-model', 1, 1, @outcome, 1, 0.1)`,
      )
      .run({
        at: received,
        outcome,
        finishedAt: outcome === null ? null : received,
      });

  run("completed");
  run("failed");
  run(null);

  expect(() => run(null)).toThrow(/UNIQUE/);
  db.prepare(
    "UPDATE tagging_runs SET outcome = 'abandoned', finished_at = ? WHERE finished_at IS NULL",
  ).run(received);
  expect(() => run(null)).not.toThrow();
});
