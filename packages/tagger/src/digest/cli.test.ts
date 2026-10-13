/**
 * The command, run as the owner or the schedule runs it: as a process of
 * its own, against a temporary data directory. Only what needs no API is
 * run this way; a run that sends is tested in `run.test.ts`, against the
 * fake.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  finishDigestRun,
  listDigestRuns,
  openStore,
  startDigestRun,
  weekOf,
} from "@x-bookmarks/core";
import { expect, test } from "vitest";
import { library, postId, type TestLibrary } from "../testing/library.ts";

const CLI = join(import.meta.dirname, "cli.ts");
/** The test library dates bookmark `n` to noon UTC on the nth of June 2026, whose 8th is a Monday. */
const WEEK = weekOf(new Date(Date.UTC(2026, 5, 10, 12)));

function digest(lib: TestLibrary, ...args: string[]) {
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
      },
    },
  );
  return { status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

const hashOf = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function weekLibrary(): TestLibrary {
  const lib = library();
  for (const day of [8, 9, 10, 11, 12]) lib.add(day);
  return lib;
}

test("a dry run prints the plan, needs no key, and leaves the database file byte for byte as it was", () => {
  const lib = weekLibrary();
  lib.store.close();
  const before = hashOf(lib.path);

  // Any day of the week names the week.
  const run = digest(lib, "--dry-run", "--week", "2026-06-11");

  expect(run.status).toBe(0);
  expect(run.stdout).toMatch(
    /Dry run\. Nothing was sent, nothing was written, and no key was read\./,
  );
  expect(run.stdout).toContain(`(${WEEK.key})`);
  expect(run.stdout).toMatch(/Bookmarks made that week\s+5/);
  expect(run.stdout).toMatch(/Would be sent, in one request\s+5/);
  expect(run.stdout).toMatch(/Cost\s+\$0\.\d+ to \$0\.\d+/);
  expect(run.stdout).toMatch(/At most\s+\$0\.\d+/);
  expect(run.stdout).toContain(`pnpm digest --week ${WEEK.key}`);
  expect(hashOf(lib.path)).toBe(before);
  expect(existsSync(lib.envFile)).toBe(false);
  // Counts and money, and nothing of a bookmark.
  expect(run.output).not.toContain("Bookmark number");
  expect(run.output).not.toContain("author8");
});

test("with no key, a week to write is refused with what to do, before any run is opened", () => {
  const lib = weekLibrary();
  lib.store.close();

  const run = digest(lib, "--week", WEEK.key);

  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/There is no API key yet/);
  expect(run.stderr).toContain(lib.envFile);
  const store = openStore(lib.path, { readOnly: true });
  try {
    expect(listDigestRuns(store)).toEqual([]);
  } finally {
    store.close();
  }
});

test("with no key, a week that needs no request says so and succeeds: one with its digest, and one with too few bookmarks", () => {
  const lib = weekLibrary();
  lib.add(16);
  const run = startDigestRun(lib.store, {
    week: WEEK,
    startedBy: "owner",
    model: "a-model",
    instructionsVersion: 1,
    bookmarksInWeek: 5,
    postIds: [8, 9, 10, 11, 12].map(postId),
    capUsd: 0.5,
  });
  finishDigestRun(lib.store, run.id, {
    outcome: "written",
    text: {
      overview: "A secret overview.",
      themes: [],
      worthRevisiting: [],
    },
    inputTokens: 1000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 500,
    costUsd: 0.014,
    unansweredRequests: 0,
  });
  lib.store.close();

  const written = digest(lib, "--week", WEEK.key, "--scheduled");
  const few = digest(lib, "--week", "2026-06-16");
  const listed = digest(lib, "--list");

  expect(written.status).toBe(0);
  expect(written.stdout).toMatch(/is already written/);
  expect(written.stdout).toMatch(/Nothing was sent/);
  expect(few.status).toBe(0);
  expect(few.stdout).toMatch(
    /holds 1 bookmark, and a digest is written from 3/,
  );
  expect(listed.status).toBe(0);
  expect(listed.stdout).toMatch(
    new RegExp(
      `${WEEK.key}\\s+written\\s+5 sent\\s+1,000 in\\s+500 out\\s+\\$0\\.0140`,
    ),
  );
  // The digest itself is on the page, and in no terminal or log.
  for (const output of [written.output, few.output, listed.output]) {
    expect(output).not.toContain("secret overview");
  }
});

test("options that make no sense are refused before anything is opened", () => {
  const lib = weekLibrary();
  lib.store.close();

  for (const [args, message] of [
    [["--week", "next week"], /--week takes a day as YYYY-MM-DD/],
    [["--week", "2026-02-30"], /--week takes a day as YYYY-MM-DD/],
    [["--max-usd", "free"], /--max-usd takes a number above zero/],
    [["--max-usd", "0"], /--max-usd takes a number above zero/],
    [["--retag"], /Unknown option/],
  ] as const) {
    const run = digest(lib, ...args);
    expect(run.status, args.join(" ")).toBe(1);
    expect(run.stderr, args.join(" ")).toMatch(message);
  }
  expect(digest(lib, "--help").stdout).toMatch(/pnpm digest \[options\]/);
});

test("with no library yet, the command says so and makes none", () => {
  const lib = library();
  lib.store.close();
  const elsewhere = join(lib.directory, "nowhere");

  const { status, stderr } = spawnSync(process.execPath, [CLI, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, X_BOOKMARKS_DATA_DIR: elsewhere },
  });

  expect(status).toBe(1);
  expect(stderr).toMatch(/There is no database/);
  expect(existsSync(elsewhere)).toBe(false);
});
