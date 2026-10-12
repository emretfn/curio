import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { getBookmark } from "../bookmarks.ts";
import { applyMigrations } from "../migrate.ts";
import { openTempStore, tempDatabasePath } from "../testing/temp-database.ts";
import { migrations } from "./index.ts";

const posted = Date.parse("2026-04-08T06:30:15.000Z");
const bookmarked = Date.parse("2026-06-01T12:00:00.000Z");
const received = Date.parse("2026-10-05T09:00:00.000Z");
const POST = "1975000000000000001";

/** A database as migration 3 left it, holding one capture and the bookmark parsed from it. */
function databaseAtMigration3(): string {
  const path = tempDatabasePath();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 3));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES ('x-web-client', 'Bookmarks', '{}', ?)",
  ).run(received);
  db.prepare(
    `INSERT INTO bookmarks (
       post_id, author_id, author_handle, author_name, text, posted_at,
       sort_index, estimated_bookmarked_at,
       first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
     ) VALUES (?, '44196397', 'someone', 'Some One', 'kept', ?, ?, ?, ?, 1, ?, 1)`,
  ).run(
    POST,
    posted,
    String(BigInt(bookmarked) << 20n),
    bookmarked,
    received,
    received,
  );
  db.close();
  return path;
}

test("a bookmark stored before the migration is unchanged, is not marked removed, and takes its bookmark time from the estimate", () => {
  const store = openTempStore(databaseAtMigration3());

  expect(getBookmark(store, POST)).toMatchObject({
    text: "kept",
    estimatedBookmarkedAt: new Date(bookmarked),
    observedBookmarkedAt: null,
    bookmarkedAt: new Date(bookmarked),
    removedOnXAt: null,
    firstSeenAt: new Date(received),
    firstSeenCaptureId: 1,
    lastSeenAt: new Date(received),
  });
});

test("first-seen is still immutable after the migration", () => {
  const path = databaseAtMigration3();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());

  expect(() =>
    db.prepare("UPDATE bookmarks SET first_seen_at = ?").run(Date.now()),
  ).toThrow(/set once and never overwritten/);
});

test("the mutations table starts empty: nothing is marked until a capture says so", () => {
  const path = databaseAtMigration3();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());

  expect(
    db.prepare("SELECT count(*) FROM bookmark_mutations").pluck().get(),
  ).toBe(0);
});
