import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations, assertMigrated } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

/**
 * An open bookmarks database. Get one from `openStore` and pass it to the
 * other functions of this package. It deliberately exposes no connection.
 */
export interface Store {
  close(): void;
}

const connections = new WeakMap<Store, Database.Database>();

export interface OpenStoreOptions {
  /**
   * Open the file for reading only. Nothing is created, migrated or changed:
   * the file must exist and already be at this code's last migration, and
   * every function that writes throws. For a process that must never be able
   * to change the library, such as the MCP server.
   */
  readOnly?: boolean;
}

/**
 * Opens the database file at `path`, creating it and its directory when
 * missing, and applies any pending migrations. Several processes may open the
 * same file at once (WAL mode).
 *
 * With `readOnly`, see `OpenStoreOptions`.
 */
export function openStore(path: string, options: OpenStoreOptions = {}): Store {
  if (options.readOnly === true) return openReadOnly(path);
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
  return storeOf(db);
}

function openReadOnly(path: string): Store {
  if (!existsSync(path)) {
    throw new Error(
      `There is no database at ${path}. A read-only open does not create one: start the app (pnpm app) first.`,
    );
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assertMigrated(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return storeOf(db);
}

function storeOf(db: Database.Database): Store {
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
