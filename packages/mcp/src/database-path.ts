import { join, resolve } from "node:path";

/**
 * The library's database file: `bookmarks.db` in `X_BOOKMARKS_DATA_DIR` when
 * that is set, as for the app, and otherwise in `data/` at the root of this
 * repo. The root is found from this file and not from the working directory,
 * because a client starts the server from wherever it happens to be.
 */
export function databasePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.X_BOOKMARKS_DATA_DIR;
  return join(
    configured === undefined || configured === ""
      ? join(import.meta.dirname, "../../../data")
      : resolve(configured),
    "bookmarks.db",
  );
}
