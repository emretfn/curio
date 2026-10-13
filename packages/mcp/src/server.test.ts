/**
 * Pins what the server is made of, by reading its source: which modules it
 * loads and which of core's functions it can call. The behaviour is tested
 * through a client in `main.test.ts`; this is the guard against a later
 * change that quietly gives the server a way to write or to reach a network.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const sources = readdirSync(import.meta.dirname)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({
    name,
    text: readFileSync(join(import.meta.dirname, name), "utf8"),
  }));

/** Every `import … from "<module>"` of a source, with the names it takes. */
function imports(text: string): { module: string; names: string[] }[] {
  return [
    ...text.matchAll(
      /import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\{([^}]*)\}|\w+)\s+from\s+"([^"]+)"/g,
    ),
  ].map(([, names = "", module = ""]) => ({
    module,
    names: names
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter((name) => name !== ""),
  }));
}

test("the server is made of four files", () => {
  expect(sources.map(({ name }) => name).toSorted()).toEqual([
    "database-path.ts",
    "format.ts",
    "main.ts",
    "server.ts",
  ]);
});

test("it loads the MCP library, core, the schema library and a path helper, and nothing that could reach a network", () => {
  const modules = new Set(
    sources.flatMap(({ text }) =>
      imports(text)
        .map(({ module }) => module)
        .filter((module) => !module.startsWith("./")),
    ),
  );

  expect([...modules].toSorted()).toEqual([
    "@modelcontextprotocol/server",
    // Standard input and output: the one transport this server is given.
    "@modelcontextprotocol/server/stdio",
    "@x-bookmarks/core",
    "node:path",
    "zod/v4",
  ]);
  for (const { name, text } of sources) {
    expect(text, name).not.toMatch(/\bimport\s*\(|\brequire\b/);
  }
});

test("of core it takes the functions that read, and no function that writes", () => {
  const taken = new Set(
    sources.flatMap(({ text }) =>
      imports(text)
        .filter(({ module }) => module === "@x-bookmarks/core")
        .flatMap(({ names }) => names),
    ),
  );

  expect([...taken].toSorted()).toEqual([
    "Bookmark",
    "BookmarkFilter",
    "PostContent",
    "QuotedPost",
    "Store",
    // The taxonomy is data: the ids, labels and definitions of the
    // categories and formats, to describe the filters with and to set out
    // in the overview.
    "TAXONOMY",
    "excerpt",
    "getBookmark",
    // Reads the tag vocabulary, which the user changes and the library holds.
    "getVocabulary",
    "listBookmarks",
    "openStore",
    "searchBookmarks",
    "summariseLibrary",
    // Drops characters that hide text from a reader. A function of text alone.
    "visibleText",
  ]);
});

test("the one place it opens the library opens it read-only", () => {
  const opens = sources.flatMap(({ text }) => [
    ...text.matchAll(/openStore\(([^)]*)\)/g),
  ]);

  expect(opens.map(([, args]) => args)).toEqual(["path, { readOnly: true }"]);
});

test("nothing but the protocol is written to standard output", () => {
  for (const { name, text } of sources) {
    expect(text, name).not.toMatch(/console\.(log|info|debug)|process\.stdout/);
  }
});
