/**
 * Re-tagging, which needs answers made under older instructions than the
 * current ones. The first version has none older, so this file runs with
 * the current version moved on by one, and nothing else changed; that is
 * why it is a file of its own beside `run.test.ts`.
 */
import {
  correctBookmark,
  getOpenTaggingRun,
  recordClassification,
  recordTaggingProgress,
  startTaggingRun,
} from "@curio/core";
import { expect, test, vi } from "vitest";
import { createClaude } from "./anthropic.ts";
import { INSTRUCTIONS_VERSION, MODEL } from "./instructions.ts";
import { planTagging, type RunOptions, runTagging } from "./run.ts";
import { DEFAULT_ANSWER, FAKE_KEY, fakeApi } from "./testing/fake-api.ts";
import { library, postId, type TestLibrary } from "./testing/library.ts";

vi.mock("./instructions.ts", async (original) => {
  const actual = await original<typeof import("./instructions.ts")>();
  return { ...actual, INSTRUCTIONS_VERSION: actual.INSTRUCTIONS_VERSION + 1 };
});

const OLDER = INSTRUCTIONS_VERSION - 1;

/** Classifies bookmark `n` as the instructions before the current ones did. */
function classifiedBefore(lib: TestLibrary, n: number): void {
  recordClassification(lib.store, {
    postId: postId(n),
    category: "tools",
    format: "tip",
    tags: ["security"],
    proposedTags: ["an-old-idea"],
    tooLittleText: false,
    instructionsVersion: OLDER,
    model: "an-older-model",
    classifiedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
}

function setup() {
  const api = fakeApi({
    reply: () => ({ ...DEFAULT_ANSWER, tags: ["react", "nextjs"] }),
  });
  const run = (parts: Partial<RunOptions> = {}): RunOptions => ({
    claude: createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 0 }),
    startedBy: "owner",
    mode: "retag",
    capUsd: 2,
    ...parts,
  });
  return { api, run };
}

test("a re-tagging classifies again what older instructions classified, and only that", async () => {
  const lib = library(4);
  classifiedBefore(lib, 1);
  classifiedBefore(lib, 2);
  const { api, run } = setup();
  // Bookmark 3 is classified under the current instructions; 4 not at all.
  await runTagging(lib.store, run({ mode: "untagged", limit: 1 }));
  const before = api.sent.length;

  expect(planTagging(lib.store, { mode: "retag" })).toMatchObject({
    candidates: 2,
    toSend: 2,
  });
  const report = await runTagging(lib.store, run());

  expect(before).toBe(1);
  expect(report).toMatchObject({
    status: "completed",
    mode: "retag",
    selected: 2,
    classified: 2,
  });
  expect(api.sent).toHaveLength(before + 2);
  expect(lib.labels(1)).toMatchObject({
    category: "web-dev",
    format: "guide",
    tags: ["nextjs", "react"],
    classification: {
      instructionsVersion: INSTRUCTIONS_VERSION,
      model: MODEL,
      proposedTags: [],
    },
  });
  expect(report.summary).toMatchObject({
    outdated: 0,
    classified: 3,
    unclassified: 1,
  });
  expect(await runTagging(lib.store, run())).toMatchObject({
    status: "nothing-to-do",
  });
});

test("an ordinary run leaves outdated answers alone: re-tagging is asked for by name", async () => {
  const lib = library(2);
  classifiedBefore(lib, 1);
  classifiedBefore(lib, 2);
  const { api, run } = setup();

  const report = await runTagging(lib.store, run({ mode: "untagged" }));

  expect(report.status).toBe("nothing-to-do");
  expect(report.summary.outdated).toBe(2);
  expect(api.sent).toEqual([]);
  expect(lib.labels(1).classification?.model).toBe("an-older-model");
});

test("a re-tagging never overwrites what the owner corrected", async () => {
  const lib = library(2);
  classifiedBefore(lib, 1);
  classifiedBefore(lib, 2);
  correctBookmark(lib.store, postId(1), {
    category: "life",
    format: "discussion",
    addTags: ["career"],
    removeTags: ["react"],
  });
  const { run } = setup();

  const report = await runTagging(lib.store, run());

  expect(report.classified).toBe(2);
  expect(lib.labels(1)).toEqual({
    // The owner's category and format, and the owner's word on two tags;
    // the tag the owner said nothing about follows the new answer.
    category: "life",
    format: "discussion",
    tags: ["career", "nextjs"],
    tooLittleText: false,
    corrected: { category: true, format: true, tags: true },
    classification: expect.objectContaining({
      category: "web-dev",
      format: "guide",
      tags: ["nextjs", "react"],
      instructionsVersion: INSTRUCTIONS_VERSION,
    }),
  });
  // The bookmark nobody corrected simply follows the new answer.
  expect(lib.labels(2)).toMatchObject({
    category: "web-dev",
    tags: ["nextjs", "react"],
    corrected: { category: false, format: false, tags: false },
  });
});

test("a batch left waiting under instructions since replaced is closed without storing its answers", async () => {
  const lib = library(2);
  // A run of the instructions before these, as its record says, that
  // submitted a batch and did not live to collect it.
  const waiting = startTaggingRun(lib.store, {
    startedBy: "owner",
    mode: "untagged",
    transport: "batch",
    model: MODEL,
    instructionsVersion: OLDER,
    selected: 2,
    capUsd: 2,
  });
  recordTaggingProgress(lib.store, waiting.id, {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    classified: 0,
    failed: 0,
    costUsd: 0,
    batch: { id: "msgbatch_older", postIds: [postId(1), postId(2)] },
  });
  const { api, run } = setup();

  const report = await runTagging(lib.store, run({ mode: "untagged" }));

  expect(report).toMatchObject({
    status: "failed",
    resumed: true,
    failure: { kind: "versions-changed" },
    classified: 0,
  });
  expect(api.sent).toEqual([]);
  expect(lib.labels(1).classification).toBeNull();
  expect(getOpenTaggingRun(lib.store)).toBeUndefined();

  // The way is then clear to classify under the current ones.
  expect(await runTagging(lib.store, run({ mode: "untagged" }))).toMatchObject({
    status: "completed",
    classified: 2,
  });
});
