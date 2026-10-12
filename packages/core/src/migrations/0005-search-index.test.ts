import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { getBookmark } from "../bookmarks.ts";
import { searchBookmarks } from "../library.ts";
import { applyMigrations } from "../migrate.ts";
import { openTempStore, tempDatabasePath } from "../testing/temp-database.ts";
import { migrations } from "./index.ts";

const received = Date.parse("2026-10-05T09:00:00.000Z");
const posted = Date.parse("2026-04-08T06:30:15.000Z");

/** A database as migration 4 left it, holding bookmarks that no index knows of. */
function databaseAtMigration4(): string {
  const path = tempDatabasePath();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 4));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES ('x-web-client', 'Bookmarks', '{}', ?)",
  ).run(received);
  const insert = db.prepare(
    `INSERT INTO bookmarks (
       post_id, author_id, author_handle, author_name, text, posted_at, card, media,
       first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
     ) VALUES (?, '44196397', ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
  );
  insert.run(
    "1975000000000000001",
    "someone",
    "Some One",
    "ışık hızında",
    posted,
    JSON.stringify({ name: "summary", title: "A headline", description: "d" }),
    "[]",
    received,
    received,
  );
  insert.run(
    "1975000000000000002",
    "other",
    "Kıymetli Yazar",
    "",
    posted,
    null,
    JSON.stringify([
      { type: "photo", altText: "a lighthouse" },
      { type: "photo" },
    ]),
    received,
    received,
  );
  db.close();
  return path;
}

const found = (path: string, query: string) =>
  searchBookmarks(openTempStore(path), { query }).hits.map(
    ({ bookmark }) => bookmark.postId,
  );

test("bookmarks stored before the migration are searchable after it, by every part", () => {
  const path = databaseAtMigration4();

  expect(found(path, "isik")).toEqual(["1975000000000000001"]);
  expect(found(path, "headline")).toEqual(["1975000000000000001"]);
  expect(found(path, "someone")).toEqual(["1975000000000000001"]);
  expect(found(path, "kiymetli")).toEqual(["1975000000000000002"]);
  expect(found(path, "lighthouse")).toEqual(["1975000000000000002"]);
});

test("the migration leaves the bookmarks themselves as they were", () => {
  const store = openTempStore(databaseAtMigration4());

  expect(getBookmark(store, "1975000000000000001")).toMatchObject({
    text: "ışık hızında",
    firstSeenAt: new Date(received),
    firstSeenCaptureId: 1,
  });
});

test("the index stores the dotless i as a plain i, and nothing else is changed", () => {
  const path = databaseAtMigration4();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());

  expect(
    db
      .prepare(
        "SELECT text, author, title, quoted, detail FROM bookmark_search ORDER BY rowid",
      )
      .all(),
  ).toEqual([
    {
      text: "işik hizinda",
      author: "someone Some One",
      title: "A headline",
      quoted: "",
      detail: "d",
    },
    {
      text: "",
      author: "other Kiymetli Yazar",
      title: "",
      quoted: "",
      detail: "a lighthouse",
    },
  ]);
});

test("a bookmark that is deleted leaves the index too", () => {
  const path = databaseAtMigration4();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());

  db.prepare(
    "DELETE FROM bookmarks WHERE post_id = '1975000000000000001'",
  ).run();

  expect(db.prepare("SELECT count(*) FROM bookmark_search").pluck().get()).toBe(
    1,
  );
  expect(() =>
    db.exec(
      "INSERT INTO bookmark_search (bookmark_search) VALUES ('integrity-check')",
    ),
  ).not.toThrow();
});
