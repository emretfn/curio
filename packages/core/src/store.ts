import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

/**
 * An open bookmarks database. Get one from `openStore` and pass it to the
 * other functions of this package. It deliberately exposes no connection.
 */
export interface Store {
  close(): void;
}

const connections = new WeakMap<Store, Database.Database>();

/**
 * Opens the database file at `path`, creating it and its directory when
 * missing, and applies any pending migrations. Several processes may open the
 * same file at once (WAL mode).
 */
export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  const store: Store = Object.freeze({ close: () => void db.close() });
  connections.set(store, db);
  return store;
}

/** Package-internal: the connection behind a store. Never exported from index.ts. */
export function connectionOf(store: Store): Database.Database {
  const db = connections.get(store);
  if (db === undefined) {
    throw new TypeError("Expected a Store returned by openStore().");
  }
  return db;
}
