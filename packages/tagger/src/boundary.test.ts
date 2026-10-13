/**
 * Pins, by reading source, where the library can leave this computer: which
 * one file calls Claude, at which one address, with which key, and who can
 * set it going. The behaviour is tested in `anthropic.test.ts` and
 * `run.test.ts`; this is the guard against a later change that quietly adds
 * a second way out. It is the mechanical half of the AI rules in
 * CODING_STANDARDS.md.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".next-e2e",
  "data",
  "coverage",
  "docs",
  "fixtures",
]);

function sourceFiles(directory: string = repoRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // A directory with a `.git` of its own is another checkout, such as a
      // linked worktree. Its own run of this test reads it.
      return SKIPPED.has(entry.name) || existsSync(join(path, ".git"))
        ? []
        : sourceFiles(path);
    }
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(entry.name) &&
      entry.name !== "pnpm-lock.yaml"
      ? [relative(repoRoot, path)]
      : [];
  });
}

const files = sourceFiles().map((path) => ({
  path,
  source: readFileSync(join(repoRoot, path), "utf8"),
}));
/** Unit tests, the end-to-end test and test helpers. */
const isTest = (path: string) => /\.(?:test|e2e)\.tsx?$|\/testing\//.test(path);

/** The files whose source matches, tests and test helpers left out unless asked for. */
const holding = (pattern: RegExp, withTests = false) =>
  files
    .filter(({ path }) => withTests || !isTest(path))
    .filter(({ source }) => pattern.test(source))
    .map(({ path }) => path)
    .toSorted();

/** The packages whose `package.json` names a dependency that matches. */
const dependingOn = (name: RegExp) =>
  files
    .filter(({ path }) => path.endsWith("package.json"))
    .filter(({ source }) => {
      const manifest = JSON.parse(source) as Record<string, unknown>;
      return [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]
        .flatMap((kind) => Object.keys(manifest[kind] ?? {}))
        .some((dependency) => name.test(dependency));
    })
    .map(({ path }) => path);

test("the check reads the whole repo", () => {
  const paths = files.map(({ path }) => path);

  expect(paths.length).toBeGreaterThan(100);
  for (const expected of [
    "packages/tagger/src/anthropic.ts",
    "packages/core/src/library.ts",
    "packages/mcp/src/server.ts",
    "packages/web/src/server/ingest.ts",
    "packages/extension/src/queue.ts",
  ]) {
    expect(paths).toContain(expected);
  }
});

test("one package depends on Anthropic's SDK and one file imports it", () => {
  expect(dependingOn(/^@anthropic-ai\//)).toEqual([
    "packages/tagger/package.json",
  ]);
  expect(
    holding(/(?:from|import)\s*\(?\s*["']@anthropic-ai\//, true).filter(
      // The check on requests to X holds such an import as a sample line.
      (path) => path !== "packages/core/src/no-requests-to-x.test.ts",
    ),
  ).toEqual(["packages/tagger/src/anthropic.ts"]);
});

test("one file names the Claude API's address, and no other address is in the classifier", () => {
  expect(holding(/api\.anthropic\.com/)).toEqual([
    "packages/tagger/src/anthropic.ts",
  ]);
  const addresses = files
    .filter(
      ({ path }) => path.startsWith("packages/tagger/src/") && !isTest(path),
    )
    .flatMap(({ source }) => source.match(/https?:\/\/[^\s"'`)]+/g) ?? []);

  expect([...new Set(addresses)]).toEqual(["https://api.anthropic.com"]);
});

test("in the classifier, only the client names the platform's sender or the client's base address", () => {
  const inTagger = (pattern: RegExp) =>
    holding(pattern).filter((path) => path.startsWith("packages/tagger/"));

  expect(inTagger(/\bfetch\b/)).toEqual(["packages/tagger/src/anthropic.ts"]);
  expect(inTagger(/baseURL/)).toEqual(["packages/tagger/src/anthropic.ts"]);
  // No second client, and no module that could be one.
  expect(
    inTagger(
      /["'](?:node:)?(?:https?|http2|net|tls|dgram|dns|child_process)["']/,
    ),
  ).toEqual([]);
});

test("the client is built once, with the key it is handed and the address written out", () => {
  const client = readFileSync(
    join(import.meta.dirname, "anthropic.ts"),
    "utf8",
  );

  expect(client.match(/new Anthropic\(/g)).toHaveLength(1);
  expect(client).toMatch(/apiKey: options\.apiKey,/);
  expect(client).toMatch(/authToken: null,/);
  expect(client).toMatch(/baseURL: CLAUDE_API_ORIGIN,/);
  // The platform's sender is named once, inside the gate, and the client
  // is handed what came out of the gate.
  expect(client.match(/globalThis\.fetch/g)).toHaveLength(2);
  expect(client).toMatch(
    /const send = onlyToClaude\(options\.send \?\? globalThis\.fetch\);/,
  );
  expect(client).toMatch(/return await send\(input, init\);/);
  expect(client).toMatch(/fetch: counting,/);
  expect(client).toMatch(/logLevel: "off",/);
  // Of the environment it asks one thing: whether a test runner is at
  // work, in which case it refuses to be built for the real API.
  expect(client.match(/process\.env\.\w+/g)).toEqual([
    "process.env.VITEST",
    "process.env.NODE_TEST_CONTEXT",
  ]);
});

test("the key has a name of this project's own, and both names are written in one file", () => {
  // Every variable of Anthropic's, and this project's one for the key.
  expect(holding(/ANTHROPIC_[A-Z_]+/)).toEqual([
    "packages/tagger/src/api-key.ts",
  ]);
  const keyFile = readFileSync(join(import.meta.dirname, "api-key.ts"), "utf8");
  expect([...new Set(keyFile.match(/[A-Z_]*ANTHROPIC_[A-Z_]+/g))]).toEqual([
    "ANTHROPIC_API_KEY",
    "X_BOOKMARKS_ANTHROPIC_API_KEY",
  ]);
  expect(keyFile).toMatch(
    /export const KEY_VARIABLE = "X_BOOKMARKS_ANTHROPIC_API_KEY";/,
  );
  // The standard name is a constant used to look for a stray key, to warn.
  expect(keyFile).toMatch(/const STANDARD_VARIABLE = "ANTHROPIC_API_KEY";/);
  expect(keyFile.match(/"ANTHROPIC_API_KEY"/g)).toHaveLength(1);
});

test("the key is read from the file, never from an environment, and nothing puts it in one", () => {
  const keyFile = readFileSync(join(import.meta.dirname, "api-key.ts"), "utf8");

  // The only things asked of an environment there: where the data directory
  // is, and whether the standard variable is set.
  expect(keyFile.match(/environment(?:\.\w+|\[\w+\])/g)?.toSorted()).toEqual([
    "environment.X_BOOKMARKS_DATA_DIR",
    "environment.X_BOOKMARKS_DATA_DIR",
    "environment[STANDARD_VARIABLE]",
  ]);
  // Nowhere in the repo is either name read off an environment by name, or
  // the key's variable used to index one.
  expect(holding(/env(?:ironment)?\s*(?:\.|\[\s*["'`])\w*ANTHROPIC/)).toEqual(
    [],
  );
  expect(holding(/\[\s*KEY_VARIABLE\s*\]/)).toEqual([]);

  const writesEnvironment =
    /process\.env(?:\.[A-Za-z_]+|\[[^\]]+\])\s*=[^=]|Object\.assign\(process\.env|delete process\.env/;
  expect(
    holding(writesEnvironment).filter(
      (path) =>
        path.startsWith("packages/tagger/") ||
        path.startsWith("packages/web/src/server/tagging"),
    ),
  ).toEqual([]);
});

test("the key's file is read in one place, and nothing loads a .env file into an environment", () => {
  expect(holding(/["']\.env["']/)).toEqual(["packages/tagger/src/api-key.ts"]);
  expect(
    holding(/\breadApiKey\(/).filter((path) => !path.endsWith("api-key.ts")),
  ).toEqual(["packages/tagger/src/automatic.ts", "packages/tagger/src/cli.ts"]);
  // No library and no flag that would export the file's variables.
  expect(holding(/dotenv|loadEnvConfig|loadEnvFile|--env-file/)).toEqual([]);
});

test("the web app's own directory holds no .env file, which is the only place Next loads one from", () => {
  const inWeb = readdirSync(join(repoRoot, "packages/web")).filter((name) =>
    name.startsWith(".env"),
  );

  // Next reads .env files from its project directory, packages/web, into
  // the server's environment. The key's file is at the repo's root, which
  // Next does not read, so the key reaches the app's process only when a
  // tagging pass opens the file.
  expect(inWeb).toEqual([]);
});

test("the example is committed without a value, and git ignores the real file and its variants", () => {
  const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const settings = example
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  const ignored = readFileSync(join(repoRoot, ".gitignore"), "utf8").split(
    "\n",
  );

  // The switch for the app's own tagging is committed empty, which is off.
  expect(settings).toEqual([
    "X_BOOKMARKS_ANTHROPIC_API_KEY=",
    "X_BOOKMARKS_APP_TAGGING=",
  ]);
  expect(example).not.toMatch(/sk-ant-/);
  expect(ignored).toContain(".env");
  expect(ignored).toContain(".env.*");
  expect(ignored).toContain("!.env.example");
});

test("the classifier is set going by its own command and by the app's tagging module, and by nothing else", () => {
  expect(dependingOn(/^@x-bookmarks\/tagger$/)).toEqual([
    "packages/web/package.json",
  ]);
  const importing = (entry: string) =>
    holding(
      new RegExp(
        `(?:from|import)\\s*\\(?\\s*(?:/\\*[^*]*\\*/\\s*)?["']@x-bookmarks/tagger${entry}["']`,
      ),
    );
  // The app loads the entry that holds the pass and the owner's setting,
  // and not the package's whole face, which holds the client.
  expect(importing("/automatic")).toEqual([
    "packages/web/src/server/tagging.ts",
  ]);
  expect(importing("(?:/[^\"']*)?")).toEqual([
    "packages/web/src/server/tagging.ts",
  ]);
});

test("the app's own tagging is switched by a line of the owner's file, which one function reads and nothing writes", () => {
  // One source file names the setting. No page, route or component does, so
  // none can read it another way, and there is nothing to set.
  expect(holding(/X_BOOKMARKS_APP_TAGGING/)).toEqual([
    "packages/tagger/src/api-key.ts",
  ]);
  const keyFile = readFileSync(join(import.meta.dirname, "api-key.ts"), "utf8");
  expect(keyFile).toMatch(
    /export const APP_TAGGING_VARIABLE = "X_BOOKMARKS_APP_TAGGING";/,
  );
  // It is read out of the file's text, by the function that reads the key's
  // line, and never off an environment (the test above lists everything
  // that file asks of one).
  expect(keyFile.match(/APP_TAGGING_VARIABLE\)/g)).toEqual([
    "APP_TAGGING_VARIABLE)",
  ]);
  expect(keyFile).toMatch(
    /valuesOf\(readFileSync\(path, "utf8"\), APP_TAGGING_VARIABLE\)/,
  );
  expect(holding(/\[\s*APP_TAGGING_VARIABLE\s*\]/)).toEqual([]);
  // Nothing in the classifier writes a file at all, the .env file least of
  // all; and the one file that names it (pinned above) is in the classifier.
  expect(
    holding(
      /writeFile|appendFile|createWriteStream|renameSync|copyFile|\bopenSync\b|\.open\(/,
    ).filter((path) => path.startsWith("packages/tagger/")),
  ).toEqual([]);
  // The pass asks before it does anything but count.
  const pass = readFileSync(join(import.meta.dirname, "automatic.ts"), "utf8");
  const asks = pass.indexOf("appTagging(envFile)");
  expect(asks).toBeGreaterThan(-1);
  for (const later of [
    "getOpenTaggingRun(store)",
    "standardKeyWarning(envFile)",
    "readApiKey(envFile)",
    'import("./run.ts")',
    'import("./anthropic.ts")',
  ]) {
    expect(pass.indexOf(later), later).toBeGreaterThan(asks);
  }
});

test("the entry the app loads holds neither the client nor the run until a pass that may send loads them", () => {
  const source = (name: string) =>
    readFileSync(join(import.meta.dirname, name), "utf8");
  /** The modules a file loads as it is loaded: its imports and re-exports, the type-only ones left out. */
  const loads = (name: string) =>
    [
      ...source(name).matchAll(
        /^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gm,
      ),
    ].map((match) => match[1] ?? "");
  const reached = new Set(["automatic.ts"]);
  const outside = new Set<string>();
  for (const name of reached) {
    for (const specifier of loads(name)) {
      if (specifier.startsWith("./")) reached.add(specifier.slice(2));
      else outside.add(specifier);
    }
  }

  expect([...reached].toSorted()).toEqual([
    "api-key.ts",
    "automatic.ts",
    "instructions.ts",
  ]);
  expect([...outside].toSorted()).toEqual([
    "@x-bookmarks/core",
    "node:crypto",
    "node:fs",
    "node:path",
  ]);
  // And the two it loads later are loaded inside the pass, by name.
  expect(source("automatic.ts").match(/import\("[^"]+"\)/g)).toEqual([
    'import("./run.ts")',
    'import("./anthropic.ts")',
  ]);
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
  ) as { exports: Record<string, string> };
  expect(manifest.exports["./automatic"]).toBe("./src/automatic.ts");
});

test("what is sent is built in one file from one type, and the request holds nothing else of a bookmark", () => {
  const request = readFileSync(join(import.meta.dirname, "request.ts"), "utf8");

  // The message is the input and only the input.
  expect(request).toMatch(
    /messages: \[\{ role: "user", content: messageOf\(input\) \}\],/,
  );
  expect(request).not.toMatch(/\bBookmark\b/);
  // No tools, no files, no metadata: nothing that could carry more.
  expect(request).not.toMatch(/\b(?:tools|metadata|container|mcp_servers)\s*:/);
});
