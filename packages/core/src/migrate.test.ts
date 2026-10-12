import { readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { applyMigrations, type Migration } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { tempDatabasePath } from "./testing/temp-database.ts";

function openRawDatabase(path: string = tempDatabasePath()): Database.Database {
  const db = new Database(path);
  onTestFinished(() => void db.close());
  return db;
}

const createNotes: Migration = {
  version: 1,
  name: "create-notes",
  sql: "CREATE TABLE notes (body TEXT NOT NULL) STRICT;",
};
const addTitle: Migration = {
  version: 2,
  name: "add-title",
  sql: "ALTER TABLE notes ADD COLUMN title TEXT;",
};

function columnsOf(db: Database.Database, table: string): unknown[] {
  return db.prepare("SELECT name FROM pragma_table_info(?)").pluck().all(table);
}

test("pending migrations are applied in order, and only once", () => {
  const db = openRawDatabase();

  applyMigrations(db, [createNotes]);
  db.prepare("INSERT INTO notes (body) VALUES ('kept')").run();
  applyMigrations(db, [createNotes, addTitle]);
  applyMigrations(db, [createNotes, addTitle]);

  expect(columnsOf(db, "notes")).toEqual(["body", "title"]);
  expect(db.prepare("SELECT body FROM notes").pluck().all()).toEqual(["kept"]);
  expect(
    db.prepare("SELECT version FROM schema_migrations").pluck().all(),
  ).toEqual([1, 2]);
});

test("a failing migration leaves the database as it was", () => {
  const db = openRawDatabase();
  applyMigrations(db, [createNotes]);
  const broken: Migration = {
    version: 2,
    name: "broken",
    sql: "ALTER TABLE notes ADD COLUMN title TEXT; SELECT * FROM missing_table;",
  };

  expect(() => applyMigrations(db, [createNotes, broken])).toThrow(
    /missing_table/,
  );

  expect(columnsOf(db, "notes")).toEqual(["body"]);
  expect(
    db.prepare("SELECT version FROM schema_migrations").pluck().all(),
  ).toEqual([1]);
});

test("editing a migration that was already applied is refused", () => {
  const db = openRawDatabase();
  applyMigrations(db, [createNotes]);
  const edited: Migration = {
    ...createNotes,
    sql: "CREATE TABLE notes (body TEXT) STRICT;",
  };

  expect(() => applyMigrations(db, [edited])).toThrow(
    /changed after it was applied/,
  );
});

test("a database written by newer code is refused", () => {
  const db = openRawDatabase();
  applyMigrations(db, [createNotes, addTitle]);

  expect(() => applyMigrations(db, [createNotes])).toThrow(/newer version/);
});

test("a gap or reordering in the migration list is refused", () => {
  const db = openRawDatabase();

  expect(() => applyMigrations(db, [addTitle])).toThrow(/position 1/);
});

test("every migration file is registered under its own number", () => {
  const files = readdirSync(new URL("./migrations/", import.meta.url))
    // A migration's own test sits beside it, as NNNN-name.test.ts.
    .filter((file) => /^\d{4}-/.test(file) && !file.endsWith(".test.ts"))
    .sort();

  expect(
    migrations.map(
      ({ version, name }) => `${String(version).padStart(4, "0")}-${name}.ts`,
    ),
  ).toEqual(files);
});
