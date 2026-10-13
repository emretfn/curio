/**
 * Run as a process of its own by `automatic.test.ts`: makes one pass over
 * the library at the path it is given, loading the tagger as the app does,
 * and prints the pass's status with every module the process loaded on the
 * way.
 *
 * It is for a pass that stops before anything is sent, and it cannot be
 * made to do more, by a test or by a person who runs it by hand. It works
 * only where a test runner started it, on a library inside the data
 * directory the test moved (`CURIO_DATA_DIR`), reading the `.env`
 * file of that directory and never the repo's own; and the pass is handed a
 * maker of clients that makes none, so that no key it might find is ever
 * signed in with.
 */
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";

const refuse = (why: string): never => {
  console.error(
    `${why} This script is run by automatic.test.ts and by nothing else.`,
  );
  process.exit(1);
};

if (
  process.env.VITEST === undefined &&
  process.env.NODE_TEST_CONTEXT === undefined
) {
  refuse("No test runner started this process.");
}
const moved = process.env.CURIO_DATA_DIR;
if (moved === undefined || moved === "") {
  refuse(
    "CURIO_DATA_DIR is not set, so a pass would read the repo's own .env and could be the owner's.",
  );
}
const directory = resolve(moved as string);
const [path] = process.argv.slice(2);
if (path === undefined || dirname(resolve(path)) !== directory) {
  refuse("The library to pass over must be the one in CURIO_DATA_DIR.");
}

const loaded: string[] = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});

const { openStore } = await import("@curio/core");
const { tagNewBookmarks } = await import("@curio/tagger/automatic");
const store = openStore(path as string);
const { status } = await tagNewBookmarks(store, {
  envFile: join(directory, ".env"),
  connect: () => {
    throw new Error("This script makes no client.");
  },
});
store.close();
console.log(JSON.stringify({ status, loaded }));
