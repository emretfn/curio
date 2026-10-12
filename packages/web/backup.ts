import { join } from "node:path";
import { backupDirectory, snapshotsKept } from "./src/server/backups.ts";
import { backupStore, openStore } from "./src/server/core.ts";
import { dataDirectory } from "./src/server/data-directory.ts";

// Takes a snapshot of the library now, whenever the last one was, verifies
// it and prints where it is. The app takes one a day by itself; run this
// before anything risky, such as a long capture session or a migration. It
// is safe while the app is running.
//
// What it prints is counts and paths. A failure is printed with its reason
// and ends with a non-zero exit code.
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const directory = backupDirectory();
const store = openStore(join(dataDirectory(), "bookmarks.db"));
try {
  const result = backupStore(store, { directory, keep: snapshotsKept() });
  const lines =
    result.status === "written"
      ? [
          `Snapshot written and verified: ${result.snapshot.path}`,
          `  ${result.rawCaptures} raw captures, ${result.bookmarks} bookmarks, ${megabytes(result.snapshot.bytes)}`,
          ...(result.pruned.length > 0
            ? [
                `  Deleted to keep within the limit: ${result.pruned.join(", ")}`,
              ]
            : []),
        ]
      : result.status === "empty"
        ? ["The library holds no captures yet, so there is nothing to back up."]
        : [
            `Nothing has changed since the latest snapshot, which was verified again just now: ${result.snapshot.path}`,
          ];
  console.log(["", ...lines, ""].join("\n"));
} catch (error) {
  console.error(
    `\nThe backup failed: ${error instanceof Error ? error.message : String(error)}\nNothing was written to ${directory}.\n`,
  );
  process.exitCode = 1;
} finally {
  store.close();
}
