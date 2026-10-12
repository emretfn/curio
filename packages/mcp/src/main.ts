/**
 * Starts the server on this process's standard input and output, which is
 * how Claude Code and Claude Desktop run it. Standard output carries the
 * protocol and nothing else; the few lines this writes go to standard error,
 * and none of them quotes a bookmark or a query.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { openStore, type Store } from "@x-bookmarks/core";
import { databasePath } from "./database-path.ts";
import { createServer, LibraryUnavailable } from "./server.ts";

const path = databasePath();
let store: Store | undefined;

/**
 * The library, opened read-only on first use and then kept. When it cannot
 * be opened the next call tries again, so starting the app, which creates
 * and migrates the database, is enough: the client need not be restarted.
 */
function library(): Store {
  if (store === undefined) {
    try {
      store = openStore(path, { readOnly: true });
    } catch (error) {
      throw new LibraryUnavailable(
        `The bookmark library cannot be read. ${error instanceof Error ? error.message : "The database could not be opened."}`,
      );
    }
  }
  return store;
}

serveStdio(() => createServer(library), {
  onerror: (error) => console.error(`x-bookmarks MCP server: ${error.name}`),
});
console.error(`x-bookmarks MCP server reading ${path}`);
