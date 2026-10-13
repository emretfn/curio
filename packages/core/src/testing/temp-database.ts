import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { type OpenStoreOptions, openStore, type Store } from "../store.ts";

/** A database path in a fresh temporary directory, removed when the test ends. */
export function tempDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "curio-test-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "bookmarks.db");
}

/** A migrated store on a temporary database file, closed when the test ends. */
export function openTempStore(
  path: string = tempDatabasePath(),
  options: OpenStoreOptions = {},
): Store {
  const store = openStore(path, options);
  onTestFinished(() => store.close());
  return store;
}
