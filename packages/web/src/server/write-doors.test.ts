/**
 * The app's two doors, as far as its source can show them: which routes
 * accept data, which door each is behind, and that nothing else in the app
 * can write to the library. `CODING_STANDARDS.md` has the rules (ING-1,
 * PAGE-1 to PAGE-5); the end-to-end test knocks on the doors from a real
 * browser.
 *
 * A new route that accepts data fails the first test until it is listed
 * here with its door, which is a decision someone wrote down and someone
 * reviewed.
 */
import { globSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const srcRoot = new URL("../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, srcRoot), "utf8");
const sources = globSync("**/*.{ts,tsx}", { cwd: srcRoot })
  .filter((file) => !/\.test\.tsx?$/.test(file))
  .map((file) => ({ file, source: read(file) }))
  .sort((a, b) => a.file.localeCompare(b.file));

/** The methods that change something. `GET`, `HEAD` and `OPTIONS` only read, here as anywhere. */
const WRITING_METHOD =
  /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/g;

/**
 * Every route that accepts data: the function it hands the request to, and
 * the door that function opens with, before anything else.
 */
const DOORS: Record<
  string,
  { handler: string; in: string; door: RegExp; methods: string[] }
> = {
  "app/api/ingest/route.ts": {
    handler: "handleIngest",
    in: "server/ingest.ts",
    door: /const proved = await refuseUnlessExtension\(request, token\);\s*if \(proved instanceof Response\) return proved;/,
    methods: ["POST"],
  },
  "app/api/pairing/route.ts": {
    handler: "handlePairingCheck",
    in: "server/ingest.ts",
    door: /const proved = await refuseUnlessExtension\(request, token\);\s*if \(proved instanceof Response\) return proved;/,
    methods: ["POST"],
  },
  "app/api/owner/[action]/route.ts": {
    handler: "handleOwnerWrite",
    in: "server/owner-writes.ts",
    door: /const refused = refuseUnlessOwnPage\(request\);\s*if \(refused !== null\) return refused;/,
    methods: ["POST"],
  },
};

/** The body of an exported function, from its opening brace to the brace that closes it. */
function bodyOf(source: string, name: string): string {
  const start = source.search(
    new RegExp(`export (?:async )?function ${name}\\(`),
  );
  if (start === -1) throw new Error(`${name} is not exported.`);
  // Past the parameters and the return type, to the body's own brace.
  const open = source.indexOf("{\n", source.indexOf("): ", start));
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    if (source[at] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, at);
  }
  throw new Error(`${name} does not end.`);
}

test("the routes that accept data are the three listed, each behind one door", () => {
  const writing = Object.fromEntries(
    sources
      .filter(({ file }) => /(^|\/)route\.tsx?$/.test(file))
      .map(({ file, source }) => [
        file,
        [...source.matchAll(WRITING_METHOD)].map(([, method]) => method),
      ])
      .filter(([, methods]) => (methods as string[]).length > 0),
  );

  expect(writing).toEqual(
    Object.fromEntries(
      Object.entries(DOORS).map(([file, { methods }]) => [file, methods]),
    ),
  );
});

test.each(Object.entries(DOORS))(
  "%s hands its request to a function that opens with the door, before it reads anything of the request",
  (file, { handler, in: handlerFile, door }) => {
    const route = read(file);
    // The route does nothing with the request but pass it on.
    expect(route).toMatch(new RegExp(`return ${handler}\\(request, `));
    expect(route).not.toMatch(
      /request\.(?:json|text|formData|arrayBuffer|blob|body)\b/,
    );

    const body = bodyOf(read(handlerFile), handler);
    const opened = door.exec(body);
    expect(opened, `${handler} calls its door`).not.toBeNull();
    // Nothing of the request is read above the door.
    expect(body.slice(0, opened?.index ?? 0)).not.toMatch(/request\b/);
  },
);

test("one function is each door, and each is called by the routes' handlers alone", () => {
  const calling = (name: string) =>
    sources
      .filter(({ source }) => new RegExp(`\\b${name}\\(`).test(source))
      .map(({ file }) => file);

  expect(calling("refuseUnlessOwnPage")).toEqual([
    "server/owner-writes.ts",
    "server/page-door.ts",
  ]);
  expect(calling("refuseUnlessExtension")).toEqual([
    "server/guard.ts",
    "server/ingest.ts",
  ]);
});

test("no route accepts a preflight, and none sends a CORS header", () => {
  for (const file of Object.keys(DOORS)) {
    expect(read(file), file).toMatch(
      /export function OPTIONS\(\): Response \{\s*return refusePreflight\(\);/,
    );
  }
  expect(
    sources
      .filter(({ source }) => /["'`]access-control-allow/i.test(source))
      .map(({ file }) => file),
  ).toEqual([]);
});

test("the app has no Server Actions: a change is a request to a route, behind a door", () => {
  // A Server Action is a POST that Next routes by itself, to a function no
  // route file names, with a check of its own in place of this app's door.
  expect(
    sources
      .filter(({ source }) => /["']use server["']/.test(source))
      .map(({ file }) => file),
  ).toEqual([]);
});

test("core's writing functions are named in the modules behind the doors, and in the backups, and nowhere else", () => {
  const WRITERS = [
    "insertRawCapture",
    "insertRawCaptureOnce",
    "upsertBookmark",
    "parseCapture",
    "parsePendingCaptures",
    "reparseAllCaptures",
    "backupStore",
    "recordClassification",
    "recordNewTags",
    "recordClassificationFailure",
    "correctBookmark",
    "addTag",
    "acceptTagProposal",
    "addTagAlias",
    "removeTagAlias",
    "dismissTagProposal",
    "retireTag",
    "renameTag",
    "mergeTags",
    "settleTagProposals",
    "startTaggingRun",
    "finishTaggingRun",
    "recordTaggingProgress",
    "startDigestRun",
    "finishDigestRun",
  ];
  const names = new RegExp(`\\b(?:${WRITERS.join("|")})\\b`);

  expect(
    sources.filter(({ source }) => names.test(source)).map(({ file }) => file),
  ).toEqual([
    // Takes the snapshots, which write beside the library and not into it.
    "server/backups.ts",
    // Where core is loaded, and each function handed on by name.
    "server/core.ts",
    // Behind the extension's door.
    "server/ingest.ts",
    // A library for tests, in a temporary directory.
    "server/library-testing.ts",
    // Behind the page door.
    "server/owner-writes.ts",
  ]);
});
