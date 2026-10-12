import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { applyMigrations } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { getRawCapture, insertRawCapture } from "./raw-captures.ts";
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

test("a read-only store reads what is there and cannot change it", () => {
  const path = tempDatabasePath();
  const writer = openTempStore(path);
  const { id } = insertRawCapture(writer, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
  });

  const reader = openTempStore(path, { readOnly: true });

  expect(getRawCapture(reader, id)).toMatchObject({ payload: "{}" });
  expect(() =>
    insertRawCapture(reader, {
      source: "x-web-client",
      operation: "Bookmarks",
      payload: "{}",
    }),
  ).toThrow(/readonly database/);
  expect(() => connectionOf(reader).exec("CREATE TABLE planted (x)")).toThrow(
    /readonly database/,
  );
});

test("a read-only store sees what a writer adds while it is open", () => {
  const path = tempDatabasePath();
  const writer = openTempStore(path);
  const reader = openTempStore(path, { readOnly: true });

  const { id } = insertRawCapture(writer, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
  });

  expect(getRawCapture(reader, id)).toBeDefined();
});

test("a read-only open creates nothing where there is no database", () => {
  const path = tempDatabasePath();

  expect(() => openStore(path, { readOnly: true })).toThrow(
    /There is no database at/,
  );
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dirname(path))).toEqual([]);
});

test("a read-only open refuses a database it would have to migrate, and leaves it as it is", () => {
  const path = tempDatabasePath();
  const db = new Database(path);
  applyMigrations(db, migrations.slice(0, migrations.length - 1));
  db.close();

  expect(() => openStore(path, { readOnly: true })).toThrow(
    /a read-only open does not migrate it/,
  );
  const after = new Database(path);
  expect(
    after.prepare("SELECT count(*) FROM schema_migrations").pluck().get(),
  ).toBe(migrations.length - 1);
  after.close();
});

test("a read-only open refuses a file that is not a library at all", () => {
  const path = tempDatabasePath();
  new Database(path).exec("CREATE TABLE other (x)").close();

  expect(() => openStore(path, { readOnly: true })).toThrow(
    /at migration 0 of/,
  );
});
