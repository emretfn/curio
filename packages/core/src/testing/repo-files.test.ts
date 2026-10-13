import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  NOT_SOURCE,
  repoFiles,
  repoRoot,
  repoSourceFiles,
} from "./repo-files.ts";

/** A directory holding these files, each a path from its root, and `ignore` as its `.gitignore`. */
function tree(files: readonly string[], ignore?: string): string {
  const root = mkdtempSync(join(tmpdir(), "curio-test-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  if (ignore === undefined) {
    copyFileSync(join(repoRoot, ".gitignore"), join(root, ".gitignore"));
  } else {
    writeFileSync(join(root, ".gitignore"), ignore);
  }
  return root;
}

test("this checkout's files are its source, every package included, and nothing that is only on this computer", () => {
  const files = repoFiles();

  for (const expected of [
    ".env.example",
    ".gitignore",
    ".mcp.json",
    "CODING_STANDARDS.md",
    "docs/research/ai-layer.md",
    "lint/sqlite-boundary.grit",
    "package.json",
    "packages/core/src/parsers/fixtures/x-web-client/Bookmarks/2026-10-12-media.json",
    "packages/core/src/parsing.ts",
    "packages/extension/manifest.json",
    "packages/tagger/launchd/dev.curio.digest.plist",
    "packages/web/src/app/page.tsx",
    "pnpm-lock.yaml",
  ]) {
    expect(files).toContain(expected);
  }
  expect(
    files.filter((path) =>
      /(?:^|\/)(?:node_modules|\.git|\.next[^/]*|dist|coverage)\/|^(?:data|demo-data)\/|^\.claude\/(?:worktrees\/|settings\.local\.json$)|(?:^|\/)(?:\.env|next-env\.d\.ts)$|\.(?:db|log|tsbuildinfo)$/.test(
        path,
      ),
    ),
  ).toEqual([]);
  expect(files).toEqual(files.toSorted());
});

test("under the repo's own .gitignore, what is local is left out and what a commit would take is kept, tracked or new", () => {
  const kept = [
    // The settings a team shares, a new file nobody has added yet, and the
    // example of the key's file, which one line takes back in.
    ".claude/settings.json",
    ".env.example",
    ".gitignore",
    "package.json",
    "packages/new/src/not-added-yet.ts",
    // Names the file ignores only as a directory, or only at the root.
    "packages/tagger/src/build.ts",
    "packages/web/src/data/list.ts",
    "packages/web/src/dist",
    "packages/web/src/server/data.ts",
  ];
  const root = tree([
    ...kept.filter((path) => path !== ".gitignore"),
    // One computer's settings for a tool, which hold its paths.
    ".claude/settings.local.json",
    // Another checkout placed inside this one by a tool, and one that only
    // its own `.git` gives away.
    ".claude/worktrees/agent-1/packages/core/src/store.ts",
    "elsewhere/another-checkout/.git",
    "elsewhere/another-checkout/src/index.ts",
    // Git's own directory.
    ".git/config",
    // The key's file and its variants.
    ".env",
    ".env.local",
    // The library, the demo's, and a response saved while debugging.
    "data/bookmarks.db",
    "data/ingest-token",
    "demo-data/bookmarks.db",
    "packages/core/src/parsers/x-web-client/saved.capture.json",
    "packages/e2e/trace.har",
    // Dependencies and what the tools build.
    "node_modules/vitest/index.js",
    "packages/web/node_modules/next/index.js",
    "packages/extension/dist/background.js",
    "packages/web/.next/server/app.js",
    "packages/web/.next-e2e/server/app.js",
    "packages/web/.next-demo/server/app.js",
    "packages/web/build/output.js",
    "packages/web/out/index.html",
    "packages/web/next-env.d.ts",
    "packages/web/tsconfig.tsbuildinfo",
    "coverage/index.html",
    "packages/tagger/run.log",
  ]);

  expect(repoFiles(root)).toEqual(kept.toSorted());
});

test("the last line that matches decides, a path is matched from the root, and a name at any depth", () => {
  const root = tree(
    [
      "a.json",
      "kept.json",
      "local/a.ts",
      "packages/local/a.ts",
      "packages/x/notes.txt",
      "packages/x/notes1.txt",
      "packages/y/cache",
      "packages/y/cache.d/a.ts",
    ],
    [
      "# a comment, and an empty line",
      "",
      "*.json",
      "!kept.json",
      "/local/",
      "packages/x/notes?.txt  ",
      "cache.d/",
      "cache/",
    ].join("\r\n"),
  );

  expect(repoFiles(root)).toEqual([
    ".gitignore",
    "kept.json",
    "packages/local/a.ts",
    "packages/x/notes.txt",
    "packages/y/cache",
  ]);
});

test.each([
  ["two stars", "**/generated/"],
  ["a set of characters", "*.[oa]"],
  ["an escape", "\\#notes"],
])(
  "a .gitignore line with %s is refused, not read as matching nothing",
  (_, line) => {
    const root = tree(["a.ts"], `node_modules/\n${line}\n`);

    expect(() => repoFiles(root)).toThrow(
      `The .gitignore line "${line}" uses a form repo-files.ts has no case for.`,
    );
  },
);

test("a .gitignore below the root is refused, since git would read it and this does not", () => {
  const root = tree(["packages/web/.gitignore"], "node_modules/\n");

  expect(() => repoFiles(root)).toThrow(
    "packages/web/.gitignore is a .gitignore below the root.",
  );
});

test("source is the repo's files without the prose, the fixtures and the lockfile, by the pattern asked for", () => {
  const root = tree([
    "biome.json",
    "docs/architecture/architecture.html",
    "docs/research/notes.json",
    "packages/core/src/docs/reader.ts",
    "packages/core/src/parsers/fixtures/x-web-client/Bookmarks/page.json",
    "packages/core/src/parsers/index.ts",
    "packages/e2e/src/fixtures/page.json",
    "packages/web/src/app/layout.tsx",
    "packages/web/src/app/globals.css",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]);

  expect(Object.keys(NOT_SOURCE)).toEqual([
    "docs/",
    "packages/core/src/parsers/fixtures/",
    "pnpm-lock.yaml",
  ]);
  // Only the directories named are left out: one of the same name deeper in
  // the tree is source like any other.
  expect(repoSourceFiles(/\.(?:ts|tsx|json|yaml)$/, root)).toEqual([
    "biome.json",
    "packages/core/src/docs/reader.ts",
    "packages/core/src/parsers/index.ts",
    "packages/e2e/src/fixtures/page.json",
    "packages/web/src/app/layout.tsx",
    "pnpm-workspace.yaml",
  ]);
  expect(repoSourceFiles(/\.html$/, root)).toEqual([]);
});
