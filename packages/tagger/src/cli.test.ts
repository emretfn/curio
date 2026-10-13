/**
 * The command, run as the owner runs it: as a process of its own, against a
 * temporary data directory. Only what needs no API is run this way; a run
 * that sends is tested in `run.test.ts`, against the fake.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addTag, recordClassification, retireTag } from "@x-bookmarks/core";
import { expect, test } from "vitest";
import { INSTRUCTIONS_VERSION } from "./instructions.ts";
import { FAKE_KEY } from "./testing/fake-api.ts";
import {
  library,
  postId,
  type TestLibrary,
  writeKey,
} from "./testing/library.ts";

const CLI = join(import.meta.dirname, "cli.ts");

/** Further variables for the next command's environment. */
let environment: Record<string, string> = {};

function tag(lib: TestLibrary, ...args: string[]) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [CLI, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        // A moved data directory has its own .env: the command never looks
        // at the repo's, where the owner's key is.
        X_BOOKMARKS_DATA_DIR: lib.directory,
        // Set, to show that it is neither read as the key nor passed on.
        ANTHROPIC_API_KEY: "sk-ant-api03-FROM0THE0ENVIRONMENT0000000000",
        ...environment,
      },
    },
  );
  return { status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

test("a dry run prints the plan, needs no key, and leaves the database file byte for byte as it was", () => {
  const lib = library(12);
  lib.add(13, { text: "" });
  lib.store.close();
  const before = digest(lib.path);

  const run = tag(lib, "--dry-run");

  expect(run.status).toBe(0);
  expect(run.stdout).toMatch(
    /Dry run\. Nothing was sent, nothing was written, and no key was read\./,
  );
  expect(run.stdout).toMatch(/Would be sent to the API\s+12/);
  expect(run.stdout).toMatch(/Too little text to send\s+1/);
  expect(run.stdout).toMatch(/Cost\s+\$0\.\d+ to \$0\.\d+/);
  expect(digest(lib.path)).toBe(before);
  // Counts and money, and nothing of a bookmark.
  expect(run.output).not.toContain("Bookmark number");
  expect(run.output).not.toContain("author1");
});

test("a dry run of a sample and of a re-tagging say which bookmarks they would take", () => {
  const lib = library(12);
  lib.store.close();

  expect(tag(lib, "--dry-run", "--sample", "5").stdout).toMatch(
    /Taken by this run\s+5/,
  );
  expect(tag(lib, "--dry-run", "--sample").stdout).toMatch(
    /Taken by this run\s+12/,
  );
  expect(tag(lib, "--dry-run", "--retag").stdout).toMatch(
    /There is nothing to send\./,
  );
  expect(tag(lib, "--dry-run", "--limit", "3").stdout).toMatch(
    /Taken by this run\s+3/,
  );
});

test("without a .env file a run refuses, says how to make one, and says the environment's key was not used", () => {
  const lib = library(3);
  lib.store.close();

  const run = tag(lib, "--sample", "2");

  expect(run.status).toBe(1);
  expect(run.stderr).toContain(lib.envFile);
  expect(run.stderr).toMatch(/Copy \.env\.example/);
  expect(run.stderr).toMatch(/X_BOOKMARKS_ANTHROPIC_API_KEY=/);
  // The environment's key was noticed, said to be unused, and not shown.
  expect(run.stderr).toMatch(
    /ANTHROPIC_API_KEY is set in this environment\. It was not used/,
  );
  expect(run.output).not.toContain("FROM0THE0ENVIRONMENT");
});

test("this project's variable in the environment is not where the key is read from either", () => {
  const lib = library(3);
  lib.store.close();
  environment = { X_BOOKMARKS_ANTHROPIC_API_KEY: FAKE_KEY };

  const run = tag(lib, "--check");
  environment = {};

  expect(run.status).toBe(1);
  expect(run.stderr).toContain("does not exist");
  expect(run.output).not.toContain(FAKE_KEY);
});

test("a .env file others can read is refused, and the key is not shown", () => {
  const lib = library(3);
  lib.store.close();
  writeKey(lib.directory, { mode: 0o644 });

  const run = tag(lib, "--sample", "2");

  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/chmod 600/);
  expect(run.output).not.toContain(FAKE_KEY);
});

test("a key under the standard name in .env is refused, with the name to give it", () => {
  const lib = library(1);
  lib.store.close();
  writeKey(lib.directory, { content: `ANTHROPIC_API_KEY=${FAKE_KEY}\n` });

  const run = tag(lib, "--check");

  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(
    /Rename the line to X_BOOKMARKS_ANTHROPIC_API_KEY=/,
  );
  expect(run.stderr).toMatch(
    /ANTHROPIC_API_KEY is set in this environment and in /,
  );
  expect(run.output).not.toContain(FAKE_KEY);
});

test("--check passes a safe .env without a request, and says that is all it shows", () => {
  const lib = library(1);
  lib.store.close();

  expect(tag(lib, "--check").status).toBe(1);

  writeKey(lib.directory);
  const checked = tag(lib, "--check");

  expect(checked.status).toBe(0);
  expect(checked.stdout).toContain(
    `X_BOOKMARKS_ANTHROPIC_API_KEY is set in ${lib.envFile}, and the file is readable by you alone.`,
  );
  expect(checked.stdout).toMatch(/No request was made/);
  // A key in place does not turn the app's own tagging on, and the check says so.
  expect(checked.stdout).toMatch(/Tagging by the app is off/);
  expect(checked.output).not.toContain(FAKE_KEY);
});

test("--status and --proposals read the library and change nothing", () => {
  const lib = library(4);
  lib.store.close();
  const before = digest(lib.path);

  const status = tag(lib, "--status");
  const proposals = tag(lib, "--proposals");

  expect(status.status).toBe(0);
  expect(status.stdout).toMatch(/Not classified yet\s+4/);
  expect(status.stdout).toContain(
    `Tagging by the app is off: by itself the app sends nothing to the API and spends nothing. To turn it on, add the line X_BOOKMARKS_APP_TAGGING=on to ${lib.envFile}`,
  );
  writeKey(lib.directory, { appTagging: true });
  const turnedOn = tag(lib, "--status");
  expect(turnedOn.stdout).toMatch(/Tagging by the app is on/);
  expect(turnedOn.stdout).toContain(
    `remove X_BOOKMARKS_APP_TAGGING=on from ${lib.envFile}`,
  );
  expect(turnedOn.output).not.toContain(FAKE_KEY);
  expect(proposals.stdout).toMatch(
    /No tag outside the vocabulary has been proposed for 2 bookmarks or more/,
  );
  expect(digest(lib.path)).toBe(before);
});

test("--tags lists the vocabulary with its other names, and --proposals the proposals worth a look, alike ones together", () => {
  const lib = library(4);
  const propose = (n: number, proposedTags: string[]) =>
    recordClassification(lib.store, {
      postId: postId(n),
      category: "web-dev",
      format: "guide",
      tags: n === 1 ? ["react"] : [],
      proposedTags,
      tooLittleText: false,
      instructionsVersion: 1,
      model: "a-model",
    });
  propose(1, ["amp"]);
  propose(2, ["amp-code"]);
  propose(3, ["mcp-servers"]);
  propose(4, ["mcp-servers", "bun"]);
  addTag(lib.store, "drizzle");
  retireTag(lib.store, "seo");
  lib.store.close();
  const before = digest(lib.path);

  const tags = tag(lib, "--tags").stdout;
  const proposals = tag(lib, "--proposals").stdout;
  const all = tag(lib, "--proposals", "1").stdout;

  expect(tags).toMatch(/The vocabulary, version 3/);
  expect(tags).toMatch(/^\s+1 {2}react$/m);
  expect(tags).toMatch(/^\s+0 {2}ads {2}= reklam$/m);
  expect(tags).toMatch(/^\s+0 {2}drizzle$/m);
  expect(tags).toMatch(/^\s+0 {2}seo {2}\(retired\)$/m);
  expect(proposals).toMatch(/2 subjects proposed for 2 bookmarks or more/);
  expect(proposals).toMatch(/^\s+2 {2}amp, amp-code$/m);
  expect(proposals).toMatch(/^\s+2 {2}mcp-servers {2}\[mcp\]$/m);
  expect(proposals).toMatch(/1 more were proposed for fewer/);
  expect(all).toMatch(/^\s+1 {2}bun$/m);
  expect(tag(lib, "--status").stdout).toMatch(
    /vocabulary version 3 \(32 tags\)/,
  );
  expect(digest(lib.path)).toBe(before);
});

test("a dry run of the new tags says how many bookmarks mention a tag added since they were classified", () => {
  const lib = library(0);
  lib.add(1, {
    text: "We moved every query to Drizzle last month and it was painless",
  });
  lib.add(2, {
    text: "A long note about gardening and nothing to do with databases",
  });
  for (const n of [1, 2]) {
    recordClassification(lib.store, {
      postId: postId(n),
      category: "web-dev",
      format: "guide",
      tags: [],
      tooLittleText: false,
      instructionsVersion: INSTRUCTIONS_VERSION,
      model: "a-model",
    });
  }
  addTag(lib.store, "drizzle");
  lib.store.close();

  const mentioning = tag(lib, "--dry-run", "--new-tags").stdout;
  const every = tag(lib, "--dry-run", "--new-tags", "--every-bookmark").stdout;

  expect(mentioning).toMatch(
    /Mode: bookmarks classified before a tag joined the vocabulary/,
  );
  expect(mentioning).toMatch(/Would be sent to the API\s+1/);
  expect(every).toMatch(/Would be sent to the API\s+2/);
  expect(tag(lib, "--dry-run").stdout).toMatch(/There is nothing to send/);
  expect(tag(lib, "--every-bookmark").stderr).toMatch(/goes with --new-tags/);
  expect(tag(lib, "--new-tags", "--retag").stderr).toMatch(/different runs/);
});

test("options that contradict each other, or that it does not know, end with the reason", () => {
  const lib = library(1);
  lib.store.close();

  expect(tag(lib, "--sample", "--retag")).toMatchObject({ status: 1 });
  expect(tag(lib, "--direct", "--batch").stderr).toMatch(
    /two different routes/,
  );
  expect(tag(lib, "--max-usd", "lots").stderr).toMatch(/number above zero/);
  expect(tag(lib, "--nonsense").status).toBe(1);
  expect(tag(lib, "--help").stdout).toMatch(/pnpm tag \[options\]/);
});
