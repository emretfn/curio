import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import {
  acceptTagProposal,
  addTag,
  finishTaggingRun,
  getOpenTaggingRun,
  listTaggingRuns,
  recordTaggingProgress,
  startTaggingRun,
  summariseTagging,
  summariseTaggingSpend,
} from "@curio/core";
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
import {
  APP_TAGGING_ON,
  library,
  type TestLibrary,
  writeKey,
} from "./testing/library.ts";

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

test("unless the owner has turned it on, a pass sends nothing, does not open the key, and says how to turn it on", async () => {
  // The key is in place and bookmarks are waiting: everything a pass needs
  // but the owner's word.
  const lib = library(3);
  writeKey(lib.directory);
  const { api, keys, pass } = setup(lib);
  const platform = vi.spyOn(globalThis, "fetch");

  const result = await pass();

  expect(result).toMatchObject({
    status: "off",
    waiting: 3,
    reports: [],
    warning: null,
  });
  expect(result.message).toMatch(/^Tagging by the app is off/);
  // How to turn it on, where, and what does the same by hand.
  expect(result.message).toContain(
    `add the line CURIO_APP_TAGGING=on to ${lib.envFile}`,
  );
  expect(result.message).toContain("pnpm tag classifies what is waiting");
  expect(result.message).toContain("pnpm tag --new-tags");
  expect(result.message).toContain("Waiting now: 3 bookmarks.");
  expect(result.message).not.toContain(FAKE_KEY);
  expect(api.sent).toEqual([]);
  expect(keys).toEqual([]);
  expect(platform).not.toHaveBeenCalled();
  expect(listTaggingRuns(lib.store)).toEqual([]);
  expect(summariseTagging(lib.store)).toMatchObject({
    unclassified: 3,
    spentUsd: 0,
  });
  platform.mockRestore();
});

test("with no .env file at all the app's tagging is off, not missing a key", async () => {
  const lib = library(2);
  const { api, pass } = setup(lib);

  const result = await pass();

  expect(result.status).toBe("off");
  expect(result.message).not.toMatch(/API key/);
  expect(api.sent).toEqual([]);
});

test.each([
  ["an empty value", "CURIO_APP_TAGGING=\n"],
  ["off", "CURIO_APP_TAGGING=off\n"],
  ["true, which is not the word", "CURIO_APP_TAGGING=true\n"],
  ["1", "CURIO_APP_TAGGING=1\n"],
  ["a line commented out", "# CURIO_APP_TAGGING=on\n"],
  ["two lines that disagree", "CURIO_APP_TAGGING=on\nCURIO_APP_TAGGING=off\n"],
  ["another variable that ends the same", "NOT_CURIO_APP_TAGGING=on\n"],
])(
  "only the word on turns the app's tagging on: %s leaves it off",
  async (_, line) => {
    const lib = library(2);
    writeKey(lib.directory, {
      content: `CURIO_ANTHROPIC_API_KEY=${FAKE_KEY}\n${line}`,
    });
    const { api, keys, pass } = setup(lib);

    expect(await pass()).toMatchObject({ status: "off", reports: [] });
    expect(api.sent).toEqual([]);
    expect(keys).toEqual([]);
  },
);

test.each([
  ["as written", "CURIO_APP_TAGGING=on\n"],
  ["in capitals", "CURIO_APP_TAGGING=ON\n"],
  ["quoted, exported and commented", 'export CURIO_APP_TAGGING="on" # mine\n'],
])("the owner's line turns it on: %s", async (_, line) => {
  const lib = library(2);
  writeKey(lib.directory, {
    content: `CURIO_ANTHROPIC_API_KEY=${FAKE_KEY}\n${line}`,
  });
  const { api, pass } = setup(lib);

  expect(await pass()).toMatchObject({
    status: "ran",
    reports: [{ classified: 2 }],
  });
  expect(api.sent).toHaveLength(2);
});

test("a .env file that cannot be read leaves the app's tagging off", async () => {
  const lib = library(2);
  const path = writeKey(lib.directory, { appTagging: true });
  chmodSync(path, 0o000);
  const { api, pass } = setup(lib);

  const result = await pass();

  chmodSync(path, 0o600);
  expect(result.status).toBe("off");
  expect(api.sent).toEqual([]);
});

test("the setting is read from the file and never from an environment", async () => {
  const lib = library(2);
  writeKey(lib.directory);
  vi.stubEnv("CURIO_APP_TAGGING", "on");
  const { api, pass } = setup(lib);

  expect((await pass()).status).toBe("off");
  expect(api.sent).toEqual([]);
  vi.unstubAllEnvs();
});

test("the owner's edit takes effect at the next pass, both ways, with nothing restarted", async () => {
  const lib = library(2);
  writeKey(lib.directory);
  const { api, pass } = setup(lib);

  expect((await pass()).status).toBe("off");

  writeKey(lib.directory, { appTagging: true });
  expect(await pass()).toMatchObject({
    status: "ran",
    reports: [{ classified: 2 }],
  });

  writeKey(lib.directory);
  lib.add(3);
  const sent = api.sent.length;
  expect(await pass()).toMatchObject({ status: "off", waiting: 1 });
  expect(api.sent).toHaveLength(sent);
});

test("with the app's tagging off, accepting a proposed tag still puts it on the bookmarks that proposed it, and nothing is sent", async () => {
  const lib = library(3);
  writeKey(lib.directory);
  const { api, pass } = setup(lib, {
    reply: (_, index) => ({
      too_little_text: false,
      category: "tools",
      format: "tip",
      tags: [],
      proposed_tags: index < 2 ? ["drizzle"] : [],
    }),
  });
  // The owner's own run, which is theirs to start whatever the setting.
  await runTagging(lib.store, {
    claude: createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 0 }),
    startedBy: "owner",
    mode: "untagged",
    capUsd: 2,
  });
  const sent = api.sent.length;

  acceptTagProposal(lib.store, "drizzle");
  const result = await pass();

  // The two it was proposed for, whichever the run reached first.
  expect([1, 2, 3].flatMap((n) => lib.labels(n).tags)).toEqual([
    "drizzle",
    "drizzle",
  ]);
  expect(result).toMatchObject({ status: "off", reports: [] });
  expect(api.sent).toHaveLength(sent);
  expect(listTaggingRuns(lib.store).map(({ startedBy }) => startedBy)).toEqual([
    "owner",
  ]);
});

test("with the app's tagging off, a batch the owner's run left waiting is not collected by the app", async () => {
  const lib = library(4);
  writeKey(lib.directory);
  const { api, pass } = setup(lib, { batchPolls: 0 });
  await runTagging(lib.store, {
    claude: createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 0 }),
    startedBy: "owner",
    mode: "untagged",
    transport: "batch",
    capUsd: 2,
    batchWaitMs: 0,
  });
  const open = getOpenTaggingRun(lib.store);
  const sent = api.sent.length;

  const result = await pass();

  expect(open?.batchId).not.toBeNull();
  expect(result.status).toBe("off");
  expect(api.sent).toHaveLength(sent);
  expect(getOpenTaggingRun(lib.store)?.id).toBe(open?.id);
});

test.each([
  ["off, with a key in place and bookmarks waiting", false, "off"],
  // On, and stopped for want of a key: still nothing to send with.
  ["on, with no key", true, "no-key"],
])(
  "a process whose tagging is %s never loads the client, the run or the SDK",
  (_, on, expected) => {
    const lib = library(3);
    writeKey(lib.directory, on ? { content: APP_TAGGING_ON } : {});
    lib.store.close();

    // A process of its own, as the app is: this one has the client loaded.
    const { stdout, stderr } = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "testing/what-a-pass-loads.ts"), lib.path],
      {
        encoding: "utf8",
        env: { ...process.env, CURIO_DATA_DIR: lib.directory },
      },
    );
    expect(stderr).toBe("");
    const { status, loaded } = JSON.parse(stdout) as {
      status: string;
      loaded: string[];
    };
    const within = (part: string) =>
      loaded
        .filter((url) => url.includes(part))
        .map((url) => url.split("/").at(-1));

    expect(status).toBe(expected);
    // The hook saw the pass's own modules, so it would have seen the others.
    expect(within("/packages/tagger/src/").toSorted()).toEqual([
      "api-key.ts",
      "automatic.ts",
      "instructions.ts",
    ]);
    expect(within("@anthropic-ai")).toEqual([]);
  },
);

test.each([
  [
    "outside a test runner",
    { VITEST: undefined, NODE_TEST_CONTEXT: undefined },
    /No test runner started this process/,
  ],
  [
    "with no data directory of its own, where the repo's .env would be read",
    { CURIO_DATA_DIR: undefined },
    /CURIO_DATA_DIR is not set/,
  ],
  [
    "on a library outside that data directory",
    { CURIO_DATA_DIR: "/somewhere/else" },
    /must be the one in CURIO_DATA_DIR/,
  ],
])(
  "the script that lists what a pass loads refuses to run %s, before it opens anything",
  (_, changes, why) => {
    const lib = library(3);
    // Everything a real pass would need, so that only the refusal stops it.
    writeKey(lib.directory, { appTagging: true });
    lib.store.close();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CURIO_DATA_DIR: lib.directory,
      ...changes,
    };
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete env[name];
    }

    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "testing/what-a-pass-loads.ts"), lib.path],
      { encoding: "utf8", env },
    );

    expect(status).toBe(1);
    expect(stderr).toMatch(why);
    expect(stdout).toBe("");
  },
);

test("the script that lists what a pass loads makes no client, whatever its .env holds: with a key and the app's tagging on, it stops there", () => {
  const lib = library(3);
  writeKey(lib.directory, { appTagging: true });
  lib.store.close();

  const { stdout } = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "testing/what-a-pass-loads.ts"), lib.path],
    {
      encoding: "utf8",
      env: { ...process.env, CURIO_DATA_DIR: lib.directory },
    },
  );

  expect(JSON.parse(stdout)).toMatchObject({ status: "error" });
});

test("new bookmarks are classified by a pass, one request at a time, with the key from its file", async () => {
  const lib = library(5);
  writeKey(lib.directory, { appTagging: true });
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

test("with the app's tagging on and no key, a pass does nothing, says why, and reaches for no network", async () => {
  const lib = library(3);
  writeKey(lib.directory, { content: APP_TAGGING_ON });
  const { api, keys, pass } = setup(lib);

  const result = await pass();

  expect(result).toMatchObject({
    status: "no-key",
    waiting: 3,
    reports: [],
    warning: null,
  });
  expect(result.message).toContain(lib.envFile);
  expect(result.message).toContain("CURIO_ANTHROPIC_API_KEY");
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
    content: `ANTHROPIC_API_KEY=${standard}\n${APP_TAGGING_ON}`,
  });
  const both = library(2);
  writeKey(both.directory, {
    content: `ANTHROPIC_API_KEY=${standard}\nCURIO_ANTHROPIC_API_KEY=${FAKE_KEY}\n${APP_TAGGING_ON}`,
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
  writeKey(lib.directory, { appTagging: true });
  const { pass } = setup(lib);
  const before = { ...process.env };

  await pass();

  expect(process.env).toEqual(before);
  expect(JSON.stringify(process.env)).not.toContain(FAKE_KEY);
});

test("a key file others can read is as good as none", async () => {
  const lib = library(3);
  writeKey(lib.directory, { appTagging: true, mode: 0o644 });
  const { api, pass } = setup(lib);

  const result = await pass();

  expect(result.status).toBe("no-key");
  expect(result.message).toContain("chmod 600");
  expect(result.message).not.toContain(FAKE_KEY);
  expect(api.sent).toEqual([]);
});

test("with nothing waiting a pass does not even read the key", async () => {
  const lib = library(0);
  writeKey(lib.directory, { content: APP_TAGGING_ON });
  const { keys, pass } = setup(lib);

  expect(await pass()).toMatchObject({ status: "nothing-to-do", waiting: 0 });
  expect(keys).toEqual([]);
});

test("a backlog is left for the owner: a pass never starts the first run or a backfill", async () => {
  const lib = library(BACKLOG_LIMIT + 1);
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
  const platform = vi.spyOn(globalThis, "fetch");

  const result = await tagNewBookmarks(lib.store, { envFile: lib.envFile });

  expect(result).toMatchObject({ status: "error", reports: [] });
  expect(platform).not.toHaveBeenCalled();
  expect(summariseTagging(lib.store)).toMatchObject({ unclassified: 2 });
  platform.mockRestore();
});

test("a pass never throws, whatever breaks under it", async () => {
  const lib = library(2);
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
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

test("attempts that brought no answer use up the app's day as what they may have cost, though no token was counted", async () => {
  const lib = library(4);
  writeKey(lib.directory, { appTagging: true });
  // An API that takes every request and never answers.
  const { api, pass } = setup(lib, { unreachable: true });
  const now = new Date("2026-10-13T12:00:00.000Z");

  const lost = await pass(() => now);

  const [report] = lost.reports;
  expect(report).toMatchObject({
    status: "failed",
    failure: { kind: "unreachable" },
    costUsd: 0,
    unanswered: 1,
  });
  expect(report?.heldUsd).toBeGreaterThan(0);
  expect(
    summariseTaggingSpend(lib.store, {
      startedBy: "app",
      since: new Date(now.getTime() - 60_000),
    }),
  ).toEqual({ runs: 1, costUsd: 0, heldUsd: report?.heldUsd });

  // Passes like it through the day: each holds a little, none reports a
  // cost. Here, one that held the whole of the day's allowance.
  const held = startTaggingRun(lib.store, {
    startedBy: "app",
    mode: "untagged",
    transport: "direct",
    model: "a-model",
    instructionsVersion: 1,
    selected: 4,
    capUsd: PASS_CAP_USD,
    now,
  });
  recordTaggingProgress(lib.store, held.id, {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    classified: 0,
    failed: 0,
    costUsd: 0,
    unansweredRequests: 150,
    heldUsd: DAILY_CAP_USD,
    now,
  });
  finishTaggingRun(lib.store, held.id, { outcome: "failed", now });
  api.options.unreachable = false;
  const sent = api.sent.length;

  const capped = await pass(() => new Date(now.getTime() + 60 * 60 * 1000));

  expect(capped).toMatchObject({ status: "daily-cap", waiting: 4 });
  expect(api.sent).toHaveLength(sent);
  // A day later the allowance is there again.
  expect(
    await pass(() => new Date(now.getTime() + 25 * 60 * 60 * 1000)),
  ).toMatchObject({ status: "ran", reports: [{ classified: 4 }] });
});

test("the app's day is summed over every run of the day, however many runs there were since", async () => {
  const lib = library(2);
  writeKey(lib.directory, { appTagging: true });
  const { api, pass } = setup(lib);
  const now = new Date("2026-10-13T12:00:00.000Z");
  const record = (startedBy: "owner" | "app", costUsd: number, at: Date) => {
    const run = startTaggingRun(lib.store, {
      startedBy,
      mode: "untagged",
      transport: "direct",
      model: "a-model",
      instructionsVersion: 1,
      selected: 1,
      capUsd: 2,
      now: at,
    });
    recordTaggingProgress(lib.store, run.id, {
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      classified: 0,
      failed: 0,
      costUsd,
      now: at,
    });
    finishTaggingRun(lib.store, run.id, { outcome: "completed", now: at });
  };
  // The app spent its day's allowance this morning, and more than a
  // hundred runs have been made since: the owner's, and the app's own
  // passes that found nothing to pay for.
  record("app", DAILY_CAP_USD, new Date(now.getTime() - 6 * 60 * 60 * 1000));
  for (let n = 0; n < 120; n += 1) {
    record(
      n % 2 === 0 ? "owner" : "app",
      0,
      new Date(now.getTime() - 60 * 60 * 1000 + n * 1000),
    );
  }

  expect(await pass(() => now)).toMatchObject({ status: "daily-cap" });
  expect(api.sent).toEqual([]);
});

test("what the owner's runs spend does not count against the app's day", async () => {
  const lib = library(2);
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
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
  writeKey(lib.directory, { appTagging: true });
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
