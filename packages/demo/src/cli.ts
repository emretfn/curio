/**
 * `pnpm demo`: builds the demo library and starts the app on it.
 *
 * The library goes into `demo-data/` at the repo's root, never into `data/`,
 * and is made again from nothing each time, so whatever was tried in the
 * demo the last time is gone. The app listens on a port of its own, so it
 * can run beside the real one.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openStore } from "@x-bookmarks/core";
import {
  buildApp,
  DEMO_HOST,
  DEMO_PORT,
  demoPortOf,
  portIsOpen,
  repoRoot,
  startApp,
} from "./app.ts";
import { buildDemoLibrary } from "./library.ts";

/** Where the demo library is kept. Git ignores it. */
export const DEMO_DIRECTORY = join(repoRoot, "demo-data");
/** The file that says a directory is the demo's, and so may be emptied by it. */
const MARKER = "THIS-IS-THE-DEMO-LIBRARY.txt";

const USAGE = `pnpm demo [--port <number>]

Builds a library of invented posts in demo-data/ and starts the app on it,
at http://${DEMO_HOST}:${DEMO_PORT} unless --port names another port.
It calls no API, makes no request and reads no library of your own.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function portFrom(args: string[]): number {
  if (args.length === 0) return DEMO_PORT;
  const [flag, value, ...rest] = args;
  const port = flag === "--port" ? demoPortOf(value ?? "") : undefined;
  if (port === undefined || rest.length > 0) fail(USAGE);
  return port;
}

/**
 * Empties the demo's directory, or makes it. A directory that exists and
 * does not hold the demo's marker is somebody's, and is left alone.
 */
function prepareDirectory(): void {
  if (existsSync(DEMO_DIRECTORY)) {
    const held = readdirSync(DEMO_DIRECTORY);
    if (held.length > 0 && !held.includes(MARKER)) {
      fail(
        `${DEMO_DIRECTORY} exists and is not a demo library, so it is left as it is. Move it away and run the demo again.`,
      );
    }
    rmSync(DEMO_DIRECTORY, { recursive: true });
  }
  mkdirSync(DEMO_DIRECTORY, { mode: 0o700 });
  writeFileSync(
    join(DEMO_DIRECTORY, MARKER),
    "This directory is the demo library that `pnpm demo` builds: invented posts by invented authors. It is deleted and made again each time the demo starts. Nothing of yours is in it.\n",
  );
}

const port = portFrom(process.argv.slice(2));
if (await portIsOpen(port)) {
  fail(
    `Something is already listening on ${DEMO_HOST}:${port}. If it is an earlier demo, stop it; otherwise name another port with --port.`,
  );
}

prepareDirectory();
const store = openStore(join(DEMO_DIRECTORY, "bookmarks.db"));
const demo = buildDemoLibrary(store);
store.close();
console.log(
  `Built the demo library in ${DEMO_DIRECTORY}: ${demo.bookmarks} invented bookmarks from ${demo.captures} captures, all filed, with a sample digest for the week of ${demo.digestWeek.key}.`,
);

console.log("Building the app. This takes about a minute the first time.");
buildApp();
const app = await startApp(DEMO_DIRECTORY, port);
console.log(
  [
    "",
    `The demo is running at http://${DEMO_HOST}:${port}`,
    "",
    "Every post in it is invented. Media is described and not shown: the posts",
    "do not exist on X, so there is nothing to load. Press Ctrl+C to stop.",
    "",
  ].join("\n"),
);

const stop = () => app.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
app.once("exit", (code) => process.exit(code ?? 0));
