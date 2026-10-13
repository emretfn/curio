import {
  addTag,
  finishTaggingRun,
  getOpenTaggingRun,
  listTaggingRuns,
  recordTaggingProgress,
  startTaggingRun,
  summariseTagging,
} from "@x-bookmarks/core";
import { expect, test, vi } from "vitest";
import { type Claude, createClaude } from "./anthropic.ts";
import {
  BACKLOG_LIMIT,
  DAILY_CAP_USD,
  PASS_CAP_USD,
  tagNewBookmarks,
} from "./automatic.ts";
import { runTagging } from "./run.ts";
import { FAKE_KEY, type FakeApiOptions, fakeApi } from "./testing/fake-api.ts";
import { library, type TestLibrary, writeKey } from "./testing/library.ts";

function setup(lib: TestLibrary, options: FakeApiOptions = {}) {
  const api = fakeApi(options);
  const keys: string[] = [];
  const connect = (apiKey: string): Claude => {
    keys.push(apiKey);
    return createClaude({ apiKey, send: api.send, retries: 0 });
  };
  return {
    api,
    keys,
    pass: (now?: () => Date) =>
      tagNewBookmarks(lib.store, {
        envFile: lib.envFile,
        connect,
        ...(now === undefined ? {} : { now }),
      }),
  };
}

test("new bookmarks are classified by a pass, one request at a time, with the key from its file", async () => {
  const lib = library(5);
  writeKey(lib.directory);
  const { api, keys, pass } = setup(lib);

  const result = await pass();

  expect(result).toMatchObject({
    status: "ran",
    waiting: 5,
    reports: [
      {
        status: "completed",
        transport: "direct",
        classified: 5,
        capUsd: PASS_CAP_USD,
      },
    ],
  });
  expect(keys).toEqual([FAKE_KEY]);
  expect(api.sent).toHaveLength(5);
  expect(listTaggingRuns(lib.store)[0]).toMatchObject({
    startedBy: "app",
    mode: "untagged",
    outcome: "completed",
  });
});

test("without a key file a pass does nothing, says why, and reaches for no network", async () => {
  const lib = library(3);
  const { api, keys, pass } = setup(lib);

  const result = await pass();

  expect(result).toMatchObject({
    status: "no-key",
    waiting: 3,
    reports: [],
    warning: null,
  });
  expect(result.message).toContain(lib.envFile);
  expect(result.message).toContain("X_BOOKMARKS_ANTHROPIC_API_KEY");
  expect(api.sent).toEqual([]);
  expect(keys).toEqual([]);
  expect(summariseTagging(lib.store)).toMatchObject({
    unclassified: 3,
    lastRun: null,
  });
});

test("a key under the standard name is not used, in the file or in the environment, and the pass says so", async () => {
  const standard = "sk-ant-api03-UNDER0THE0STANDARD0NAME000000000000";
  const onlyStandard = library(2);
  writeKey(onlyStandard.directory, {
    content: `ANTHROPIC_API_KEY=${standard}\n`,
  });
  const both = library(2);
  writeKey(both.directory, {
    content: `ANTHROPIC_API_KEY=${standard}\nX_BOOKMARKS_ANTHROPIC_API_KEY=${FAKE_KEY}\n`,
  });
  vi.stubEnv("ANTHROPIC_API_KEY", standard);
  const without = setup(onlyStandard);
  const withOwn = setup(both);

  const refused = await without.pass();
  const ran = await withOwn.pass();

  expect(refused.status).toBe("no-key");
  expect(refused.message).toMatch(/Rename the line/);
  expect(without.api.sent).toEqual([]);
  expect(ran).toMatchObject({ status: "ran", reports: [{ classified: 2 }] });
  expect(withOwn.keys).toEqual([FAKE_KEY]);
  for (const result of [refused, ran]) {
    expect(result.warning).toMatch(
      /ANTHROPIC_API_KEY is set in this environment and in /,
    );
    expect(JSON.stringify(result)).not.toContain(standard);
  }
  // Neither the environment's key nor the file's went anywhere.
  expect(JSON.stringify(withOwn.api.sent)).not.toContain(standard);
  vi.unstubAllEnvs();
});

test("a pass leaves this process's environment as it found it: the key is never put there", async () => {
  const lib = library(2);
  writeKey(lib.directory);
  const { pass } = setup(lib);
  const before = { ...process.env };

  await pass();

  expect(process.env).toEqual(before);
  expect(JSON.stringify(process.env)).not.toContain(FAKE_KEY);
});

test("a key file others can read is as good as none", async () => {
  const lib = library(3);
  writeKey(lib.directory, { mode: 0o644 });
  const { api, pass } = setup(lib);

  const result = await pass();

  expect(result.status).toBe("no-key");
  expect(result.message).toContain("chmod 600");
  expect(result.message).not.toContain(FAKE_KEY);
  expect(api.sent).toEqual([]);
});

test("with nothing waiting a pass does not even read the key", async () => {
  const lib = library(0);
  const { keys, pass } = setup(lib);

  expect(await pass()).toMatchObject({ status: "nothing-to-do", waiting: 0 });
  expect(keys).toEqual([]);
});

test("a backlog is left for the owner: a pass never starts the first run or a backfill", async () => {
  const lib = library(BACKLOG_LIMIT + 1);
  writeKey(lib.directory);
  const { api, keys, pass } = setup(lib);

  const result = await pass();

  expect(result).toMatchObject({
    status: "backlog",
    waiting: BACKLOG_LIMIT + 1,
    reports: [],
  });
  expect(result.message).toMatch(/run pnpm tag/);
  expect(api.sent).toEqual([]);
  expect(keys).toEqual([]);
  expect(listTaggingRuns(lib.store)).toEqual([]);
});

test("an API that cannot be reached costs nothing and loses nothing: the next pass classifies the same bookmarks", async () => {
  const lib = library(4);
  writeKey(lib.directory);
  const { api, pass } = setup(lib, { unreachable: true });

  const failed = await pass();

  expect(failed).toMatchObject({
    status: "ran",
    reports: [
      {
        status: "failed",
        failure: { kind: "unreachable" },
        classified: 0,
      },
    ],
  });
  expect(failed.message).toMatch(/could not be reached/);
  expect(summariseTagging(lib.store)).toMatchObject({
    unclassified: 4,
    failed: 0,
  });

  api.options.unreachable = false;
  expect(await pass()).toMatchObject({
    status: "ran",
    reports: [{ status: "completed", classified: 4 }],
  });
});

test("a pass left to make its own client, in a test, makes none: it reports an error and sends nothing", async () => {
  const lib = library(2);
  writeKey(lib.directory);
  const platform = vi.spyOn(globalThis, "fetch");

  const result = await tagNewBookmarks(lib.store, { envFile: lib.envFile });

  expect(result).toMatchObject({ status: "error", reports: [] });
  expect(platform).not.toHaveBeenCalled();
  expect(summariseTagging(lib.store)).toMatchObject({ unclassified: 2 });
  platform.mockRestore();
});

test("a pass never throws, whatever breaks under it", async () => {
  const lib = library(2);
  writeKey(lib.directory);
  const result = await tagNewBookmarks(lib.store, {
    envFile: lib.envFile,
    connect: () => {
      throw new RangeError("a secret detail that must not be repeated");
    },
  });

  expect(result).toMatchObject({ status: "error", reports: [] });
  expect(result.message).toContain("RangeError");
  expect(result.message).not.toContain("secret detail");
});

test("a pass spends within its own cap, and the app's passes within a day's", async () => {
  const lib = library(3);
  writeKey(lib.directory);
  const { api, pass } = setup(lib);
  const now = new Date("2026-10-13T12:00:00.000Z");
  await pass(() => now);

  // As if the app's passes had already spent the day's allowance.
  const store = lib.store;
  const spent = startTaggingRun(store, {
    startedBy: "app",
    mode: "untagged",
    transport: "direct",
    model: "a-model",
    instructionsVersion: 1,
    selected: 1,
    capUsd: PASS_CAP_USD,
    now,
  });
  recordTaggingProgress(store, spent.id, {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    classified: 0,
    failed: 0,
    costUsd: DAILY_CAP_USD,
    now,
  });
  finishTaggingRun(store, spent.id, { outcome: "completed", now });
  lib.add(4);
  const sent = api.sent.length;

  const capped = await pass(() => new Date(now.getTime() + 60 * 60 * 1000));

  expect(capped).toMatchObject({ status: "daily-cap", waiting: 1 });
  expect(api.sent).toHaveLength(sent);

  // A day later the allowance is there again.
  const later = await pass(() => new Date(now.getTime() + 25 * 60 * 60 * 1000));

  expect(later).toMatchObject({ status: "ran", reports: [{ classified: 1 }] });
});

test("what the owner's runs spend does not count against the app's day", async () => {
  const lib = library(2);
  writeKey(lib.directory);
  const { api, pass } = setup(lib);
  await runTagging(lib.store, {
    claude: createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 0 }),
    startedBy: "owner",
    mode: "untagged",
    capUsd: 2,
  });
  lib.add(3);

  expect(await pass()).toMatchObject({
    status: "ran",
    reports: [{ classified: 1 }],
  });
});

test("a pass collects a batch the owner's run left waiting, once it has ended, and never waits for one", async () => {
  const lib = library(BACKLOG_LIMIT);
  writeKey(lib.directory);
  const { api, pass } = setup(lib, { batchPolls: 2 });
  await runTagging(lib.store, {
    claude: createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 0 }),
    startedBy: "owner",
    mode: "untagged",
    transport: "batch",
    capUsd: 2,
    batchWaitMs: 0,
  });

  const early = await pass();

  expect(early).toMatchObject({
    status: "ran",
    message: expect.stringMatching(/still being processed/),
    reports: [{ status: "waiting-for-batch", resumed: true }],
  });

  const collected = await pass();

  expect(collected).toMatchObject({
    status: "ran",
    reports: [
      { status: "completed", resumed: true, classified: BACKLOG_LIMIT },
    ],
  });
  expect(api.sent.filter(({ method }) => method === "POST")).toHaveLength(1);
});

test("a pass that finds the owner's run at work leaves the bookmarks to it and says so", async () => {
  const lib = library(3);
  writeKey(lib.directory);
  const { api, pass } = setup(lib);
  const owners = startTaggingRun(lib.store, {
    startedBy: "owner",
    mode: "sample",
    transport: "direct",
    model: "a-model",
    instructionsVersion: 1,
    selected: 3,
    capUsd: 2,
  });

  const result = await pass();

  expect(result).toMatchObject({
    status: "ran",
    message: expect.stringMatching(/Another tagging run is at work/),
    reports: [{ status: "busy", classified: 0 }],
  });
  expect(api.sent).toEqual([]);
  expect(getOpenTaggingRun(lib.store)?.id).toBe(owners.id);
});

test("when the owner adds a tag, the next pass asks the bookmarks that mention it, and adds that tag alone", async () => {
  const lib = library(0);
  lib.add(1, {
    text: "We moved every query to Drizzle last month and it was painless",
  });
  lib.add(2, {
    text: "A long note about gardening and nothing to do with databases",
  });
  writeKey(lib.directory);
  const { api, pass } = setup(lib, {
    reply: () => ({
      too_little_text: false,
      category: "tools",
      format: "tip",
      tags: [],
      proposed_tags: [],
    }),
  });
  await pass();
  addTag(lib.store, "drizzle");
  lib.add(3, {
    text: "A new bookmark, about Drizzle too, captured after the tag was added",
  });
  api.options.reply = () => ({
    too_little_text: false,
    category: "design",
    format: "showcase",
    tags: ["drizzle"],
    proposed_tags: [],
  });
  const sent = api.sent.length;

  const result = await pass();

  expect(result).toMatchObject({
    status: "ran",
    // One unclassified, and one classified earlier that mentions the tag.
    waiting: 2,
    reports: [
      { mode: "untagged", status: "completed", classified: 1 },
      {
        mode: "new-tags",
        status: "completed",
        classified: 1,
        tags: { drizzle: 1 },
      },
    ],
  });
  expect(result.message).toMatch(
    /Classified 1 of 1 new bookmarks, and asked 1 of 1 about tags added since/,
  );
  expect(api.sent).toHaveLength(sent + 2);
  // The earlier bookmark keeps where it was filed and gains the tag; the
  // one that does not mention it was not asked.
  expect(lib.labels(1)).toMatchObject({
    category: "tools",
    format: "tip",
    tags: ["drizzle"],
  });
  expect(lib.labels(2)).toMatchObject({ category: "tools", tags: [] });
  expect(lib.labels(3)).toMatchObject({
    category: "design",
    tags: ["drizzle"],
  });
  expect(
    listTaggingRuns(lib.store).map(
      ({ mode, startedBy }) => `${startedBy} ${mode}`,
    ),
  ).toEqual(["app new-tags", "app untagged", "app untagged"]);
  expect(await pass()).toMatchObject({ status: "nothing-to-do", waiting: 0 });
});

test("more bookmarks mentioning a new tag than a pass takes are left to the owner", async () => {
  const lib = library(BACKLOG_LIMIT + 1);
  writeKey(lib.directory);
  const { api, pass } = setup(lib);
  await runTagging(lib.store, {
    claude: createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 0 }),
    startedBy: "owner",
    mode: "untagged",
    capUsd: 2,
  });
  // Every one of the test's bookmarks is "a walkthrough".
  addTag(lib.store, "walkthrough");
  const sent = api.sent.length;

  const result = await pass();

  expect(result).toMatchObject({
    status: "backlog",
    waiting: BACKLOG_LIMIT + 1,
  });
  expect(result.message).toMatch(/run pnpm tag --new-tags/);
  expect(api.sent).toHaveLength(sent);
});

test("both steps of a pass share the pass's one allowance", async () => {
  const lib = library(0);
  lib.add(1, {
    text: "We moved every query to Drizzle last month and it was painless",
  });
  writeKey(lib.directory);
  const { pass } = setup(lib);
  await pass();
  addTag(lib.store, "drizzle");
  lib.add(2);

  const result = await pass();

  const [first, second] = result.reports;
  expect(result.reports).toHaveLength(2);
  expect(second?.capUsd).toBeCloseTo(PASS_CAP_USD - (first?.costUsd ?? 0), 10);
  expect((first?.costUsd ?? 0) + (second?.costUsd ?? 0)).toBeLessThan(
    PASS_CAP_USD,
  );
});
