/**
 * Run as a process of its own by `automatic.test.ts`: makes one pass over
 * the library at the path it is given, loading the tagger as the app does,
 * and prints the pass's status with every module the process loaded on the
 * way. The environment says where the `.env` file is; this reads none.
 */
import { registerHooks } from "node:module";

const loaded: string[] = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("Which library?");
const { openStore } = await import("@x-bookmarks/core");
const { tagNewBookmarks } = await import("@x-bookmarks/tagger/automatic");
const store = openStore(path);
const { status } = await tagNewBookmarks(store);
store.close();
console.log(JSON.stringify({ status, loaded }));
