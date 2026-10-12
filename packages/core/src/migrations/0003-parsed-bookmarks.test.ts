import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { getBookmark } from "../bookmarks.ts";
import { applyMigrations } from "../migrate.ts";
import { openTempStore, tempDatabasePath } from "../testing/temp-database.ts";
import { migrations } from "./index.ts";

const posted = Date.parse("2026-04-08T06:30:15.000Z");
const received = Date.parse("2026-10-05T09:00:00.000Z");

/** A database as migration 2 left it, holding one capture and the bookmark parsed from it. */
function databaseAtMigration2(): string {
  const path = tempDatabasePath();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 2));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES ('x-web-client', 'Bookmarks', '{}', ?)",
  ).run(received);
  db.prepare(
    `INSERT INTO bookmarks (
       post_id, author_id, text, posted_at,
       first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
     ) VALUES ('1975000000000000001', '44196397', 'kept', ?, ?, 1, ?, 1)`,
  ).run(posted, received, received);
  db.close();
  return path;
}

test("a bookmark stored before the migration keeps its content and its first-seen time, and reads with the new parts empty", () => {
  const store = openTempStore(databaseAtMigration2());

  expect(getBookmark(store, "1975000000000000001")).toEqual({
    postId: "1975000000000000001",
    authorId: "44196397",
    authorHandle: "",
    authorName: "",
    authorAvatarUrl: null,
    authorVerified: false,
    text: "kept",
    postedAt: new Date(posted),
    lang: null,
    conversationId: null,
    inReplyToPostId: null,
    inReplyToHandle: null,
    media: [],
    links: [],
    card: null,
    article: null,
    quoted: null,
    likeCount: null,
    repostCount: null,
    replyCount: null,
    quoteCount: null,
    bookmarkCount: null,
    viewCount: null,
    sortIndex: null,
    estimatedBookmarkedAt: null,
    observedBookmarkedAt: null,
    bookmarkedAt: new Date(received),
    removedOnXAt: null,
    withheldOnXAt: null,
    firstSeenAt: new Date(received),
    firstSeenCaptureId: 1,
    lastSeenAt: new Date(received),
    lastSeenCaptureId: 1,
  });
});

test("first-seen is still immutable after the migration, and raw captures still write-once", () => {
  const path = databaseAtMigration2();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());

  expect(() =>
    db.prepare("UPDATE bookmarks SET first_seen_at = ?").run(Date.now()),
  ).toThrow(/set once and never overwritten/);
  expect(() =>
    db.prepare("UPDATE raw_captures SET payload = '[]'").run(),
  ).toThrow(/never updated/);
  expect(() => db.prepare("DELETE FROM raw_captures").run()).toThrow(
    /never deleted/,
  );
});

test("the new columns refuse values of the wrong kind", () => {
  const path = databaseAtMigration2();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  const set = (column: string, value: unknown) => () =>
    db.prepare(`UPDATE bookmarks SET ${column} = ?`).run(value);

  for (const [column, value] of [
    ["media", "not json"],
    ["media", "{}"],
    ["card", "[]"],
    ["quoted", '"text"'],
    ["sort_index", "18618-91"],
    ["conversation_id", "abc"],
    ["author_verified", 2],
    ["like_count", -1],
    ["estimated_bookmarked_at", 1_775_637_740],
  ] as const) {
    expect(set(column, value), `${column} = ${value}`).toThrow(
      /CHECK constraint failed/,
    );
  }
  expect(set("card", null)).not.toThrow();
  expect(set("media", "[]")).not.toThrow();
});

test("a parse result must belong to a stored capture, and an issue to a parse result", () => {
  const path = databaseAtMigration2();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  db.pragma("foreign_keys = ON");
  const record = (captureId: number, outcome: string) => () =>
    db
      .prepare(
        "INSERT INTO capture_parses VALUES (?, ?, 1, 0, 0, 0, 0, 1791825058559)",
      )
      .run(captureId, outcome);
  const issue = (captureId: number, kind: string) => () =>
    db
      .prepare(
        "INSERT INTO parse_issues (capture_id, kind, code, path, detail) VALUES (?, ?, 'missing-field', '$.data', '')",
      )
      .run(captureId, kind);

  expect(record(2, "parsed")).toThrow(/FOREIGN KEY constraint failed/);
  expect(record(1, "guessed")).toThrow(/CHECK constraint failed/);
  expect(issue(1, "warning")).toThrow(/FOREIGN KEY constraint failed/);
  expect(record(1, "no-parser")).not.toThrow();
  expect(issue(1, "ignored")).toThrow(/CHECK constraint failed/);
  expect(issue(1, "warning")).not.toThrow();
});
