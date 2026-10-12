import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrations } from "./migrations/index.ts";
import { getRawCapture } from "./raw-captures.ts";
import { connectionOf, openStore } from "./store.ts";
import { openTempStore, tempDatabasePath } from "./testing/temp-database.ts";

test("opening a new database file applies every migration", () => {
  const path = tempDatabasePath();
  const db = connectionOf(openTempStore(path));

  expect(existsSync(path)).toBe(true);
  const applied = db
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all();
  expect(applied).toEqual(
    migrations.map(({ version, name }) => ({ version, name })),
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .pluck()
    .all();
  expect(tables).toEqual(expect.arrayContaining(["raw_captures", "bookmarks"]));
});

test("the database runs in WAL mode with foreign keys enforced", () => {
  const db = connectionOf(openTempStore());

  expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});

test("reopening an existing database keeps its data and applies nothing twice", () => {
  const path = tempDatabasePath();
  const first = openStore(path);
  connectionOf(first)
    .prepare(
      "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES (?, ?, ?, ?)",
    )
    .run("x-web-client", "Bookmarks", "{}", Date.now());
  first.close();

  const db = connectionOf(openTempStore(path));

  expect(db.prepare("SELECT count(*) FROM raw_captures").pluck().get()).toBe(1);
  expect(
    db.prepare("SELECT count(*) FROM schema_migrations").pluck().get(),
  ).toBe(migrations.length);
});

test("two stores can have the same file open at once", () => {
  const path = tempDatabasePath();
  const writer = connectionOf(openTempStore(path));
  const reader = connectionOf(openTempStore(path));

  writer
    .prepare(
      "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES (?, ?, ?, ?)",
    )
    .run("x-web-client", "Bookmarks", "{}", Date.now());

  expect(
    reader.prepare("SELECT count(*) FROM raw_captures").pluck().get(),
  ).toBe(1);
});

test("a missing parent directory is created", () => {
  const path = join(tempDatabasePath(), "..", "nested", "dir", "bookmarks.db");

  openTempStore(path);

  expect(existsSync(path)).toBe(true);
});

test("an object that is not a store from openStore is rejected", () => {
  expect(() => connectionOf({ close() {} })).toThrow(TypeError);
});

test("a closed store refuses further use", () => {
  const store = openStore(tempDatabasePath());
  store.close();

  expect(() => getRawCapture(store, 1)).toThrow(/not open/);
});
