/**
 * Builds the redacted fixtures from the real captures, and checks that no
 * fixture holds anything from them.
 *
 *   node cli.ts build [database]   write the fixtures, then check them
 *   node cli.ts check [database]   check the fixtures that are on disk
 *
 * The database defaults to the app's own: `bookmarks.db` in
 * `X_BOOKMARKS_DATA_DIR`, or in `data/` at the repo root. Nothing printed
 * here quotes a capture: only counts, file names and paths.
 */
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getRawCapture, listRawCaptureIds } from "../../raw-captures.ts";
import { openStore } from "../../store.ts";
import { buildFixtures } from "./fixtures.ts";
import { findLeaks } from "./leaks.ts";

const fixturesDirectory = join(import.meta.dirname, "../fixtures");
const repoRoot = join(import.meta.dirname, "../../../../..");

function defaultDatabase(): string {
  const configured = process.env.X_BOOKMARKS_DATA_DIR;
  return join(
    configured === undefined || configured === ""
      ? join(repoRoot, "data")
      : resolve(configured),
    "bookmarks.db",
  );
}

const [command, database = defaultDatabase()] = process.argv.slice(2);
if (command !== "build" && command !== "check") {
  console.error("Usage: node cli.ts build|check [database]");
  process.exit(2);
}

const store = openStore(database);
const captures = listRawCaptureIds(store).flatMap((id) => {
  const capture = getRawCapture(store, id);
  return capture === undefined ? [] : [capture];
});
store.close();
if (captures.length === 0) {
  console.error(
    `${database} holds no captures, so there is nothing to build from or check against.`,
  );
  process.exit(1);
}

if (command === "build") {
  const { fixtures, census, posts } = buildFixtures(captures);
  for (const fixture of fixtures) {
    const path = join(fixturesDirectory, fixture.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fixture.text);
    console.log(`wrote ${fixture.path}`);
  }
  console.log(`\nOf the ${posts} posts in ${captures.length} captures:`);
  for (const { label, count } of census) {
    console.log(`${String(count).padStart(6)}  ${label}`);
  }
  console.log("");
}

const fixtures = globSync("**/*.json", { cwd: fixturesDirectory })
  .sort()
  .map((name) => ({
    name,
    text: readFileSync(join(fixturesDirectory, name), "utf8"),
  }));
const real = captures.flatMap(
  ({ payload, requestUrl, requestBody, captureKey }) =>
    [payload, requestUrl, requestBody, captureKey].filter(
      (text) => text !== null,
    ),
);
const leaks = findLeaks(real, fixtures);
for (const { fixture, path, how } of leaks) {
  console.error(`LEAK  ${fixture}  ${path}  ${how}`);
}
if (leaks.length > 0) {
  console.error(
    `\n${leaks.length} value(s) in the fixtures come from the real captures. Do not commit them: fix the redactor, or add the value to SHARED_STRINGS if it is one of X's constants, and build again.`,
  );
  process.exit(1);
}
console.log(
  `Checked ${fixtures.length} fixtures against ${captures.length} captures: nothing from the captures is in them.`,
);
