import { expect, test } from "vitest";
import { upsertBookmark } from "./bookmarks.ts";
import {
  correctBookmark,
  type NewClassification,
  recordClassification,
  recordNewTags,
} from "./labels.ts";
import { insertRawCapture } from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";
import {
  finishTaggingRun,
  finishTaggingRunWith,
  getOpenTaggingRun,
  getTaggingRun,
  INSTRUCTIONS_VERSION,
  listClassificationCandidates,
  listTaggingRuns,
  MAX_CLASSIFICATION_ATTEMPTS,
  MAX_CLASSIFICATION_CANDIDATES,
  type NewTaggingRun,
  recordClassificationFailure,
  recordTaggingProgress,
  startTaggingRun,
  summariseTagging,
  summariseTaggingSpend,
  TAGGING_RUN_STALE_MS,
  TaggingRunInProgress,
  TaggingRunNotOpen,
} from "./tagging.ts";
import { TAXONOMY } from "./taxonomy.ts";
import { openTempStore } from "./testing/temp-database.ts";
import {
  acceptTagProposal,
  addTag,
  addTagAlias,
  mergeTags,
  renameTag,
  retireTag,
} from "./vocabulary.ts";

const captured = new Date("2026-10-05T09:00:00.000Z");
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute));
const day = (n: number) => new Date(Date.UTC(2026, 5, n, 12));
const postId = (n: number) => String(1975000000000000000n + BigInt(n));

/** A library of `count` bookmarks, numbered from 1 and bookmarked a day apart in that order. */
function library(count: number): Store {
  const store = openTempStore();
  const captureId = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: captured,
  }).id;
  for (let n = 1; n <= count; n += 1) {
    upsertBookmark(store, {
      postId: postId(n),
      authorId: String(1000 + n),
      authorHandle: `author${n}`,
      authorName: `Author ${n}`,
      text: `post ${n}`,
      postedAt: new Date("2026-01-01T00:00:00.000Z"),
      sortIndex: String(BigInt(day(n).getTime()) << 20n),
      captureId,
    });
  }
  return store;
}

const classify = (
  store: Store,
  n: number,
  parts: Partial<NewClassification> = {},
) =>
  recordClassification(store, {
    postId: postId(n),
    category: "web-dev",
    format: "guide",
    tags: [],
    tooLittleText: false,
    instructionsVersion: 1,
    model: "a-model",
    ...parts,
  });

const candidates = (
  store: Store,
  options: Partial<Parameters<typeof listClassificationCandidates>[1]> = {},
) => {
  const { total, bookmarks } = listClassificationCandidates(store, {
    which: "unclassified",
    instructionsVersion: 1,
    ...options,
  });
  return { total, ids: bookmarks.map((bookmark) => bookmark.postId) };
};

test("the unclassified bookmarks are the candidates, most recently bookmarked first", () => {
  const store = library(4);
  classify(store, 2);

  expect(candidates(store)).toEqual({
    total: 3,
    ids: [postId(4), postId(3), postId(1)],
  });
  expect(candidates(store, { limit: 2 })).toEqual({
    total: 3,
    ids: [postId(4), postId(3)],
  });
});

test("a spread order is the same on every call and does not follow the bookmark time", () => {
  const store = library(40);
  const spread = candidates(store, { order: "spread", limit: 10 }).ids;

  expect(candidates(store, { order: "spread", limit: 10 }).ids).toEqual(spread);
  expect(spread).not.toEqual(candidates(store, { limit: 10 }).ids);
  expect(new Set(spread).size).toBe(10);
});

test("a bookmark classified under older instructions is outdated and not unclassified", () => {
  const store = library(3);
  classify(store, 1);
  classify(store, 2);
  classify(store, 3);

  expect(candidates(store).total).toBe(0);
  expect(candidates(store, { which: "outdated" }).total).toBe(0);
  expect(
    candidates(store, { which: "outdated", instructionsVersion: 2 }).ids,
  ).toEqual([postId(3), postId(2), postId(1)]);

  classify(store, 2, { instructionsVersion: 2 });

  expect(
    candidates(store, { which: "outdated", instructionsVersion: 2 }).ids,
  ).toEqual([postId(3), postId(1)]);
});

test("a bookmark the classifier keeps failing on is passed over until asked for, and a success clears its record", () => {
  const store = library(2);
  const fail = () =>
    recordClassificationFailure(store, {
      postId: postId(1),
      reason: "refused",
      instructionsVersion: 1,
    });

  fail();
  expect(candidates(store).total).toBe(2);
  for (let attempt = 1; attempt < MAX_CLASSIFICATION_ATTEMPTS; attempt += 1)
    fail();

  expect(candidates(store).ids).toEqual([postId(2)]);
  expect(candidates(store, { retryFailed: true }).total).toBe(2);
  expect(summariseTagging(store)).toMatchObject({ unclassified: 2, failed: 1 });
  // New instructions are a new chance.
  expect(candidates(store, { instructionsVersion: 2 }).total).toBe(2);

  classify(store, 1);

  expect(
    connectionOf(store)
      .prepare("SELECT count(*) FROM classification_failures")
      .pluck()
      .get(),
  ).toBe(0);
  expect(summariseTagging(store)).toMatchObject({ unclassified: 1, failed: 0 });
});

test("a failure counts its attempts under one set of instructions and starts again under the next", () => {
  const store = library(1);
  const attempts = () =>
    connectionOf(store)
      .prepare("SELECT attempts, reason FROM classification_failures")
      .get();
  const fail = (instructionsVersion: number, reason: "refused" | "cut-short") =>
    recordClassificationFailure(store, {
      postId: postId(1),
      reason,
      instructionsVersion,
    });

  fail(1, "refused");
  fail(1, "cut-short");
  expect(attempts()).toEqual({ attempts: 2, reason: "cut-short" });

  fail(2, "refused");
  expect(attempts()).toEqual({ attempts: 1, reason: "refused" });
});

test("the limit is bounded", () => {
  const store = library(1);

  for (const limit of [0, 1.5, MAX_CLASSIFICATION_CANDIDATES + 1]) {
    expect(() => candidates(store, { limit })).toThrow(RangeError);
  }
  expect(() => candidates(store, { instructionsVersion: 0 })).toThrow(
    RangeError,
  );
});

const run = (parts: Partial<NewTaggingRun> = {}): NewTaggingRun => ({
  startedBy: "owner",
  mode: "untagged",
  transport: "direct",
  model: "a-model",
  instructionsVersion: 1,
  selected: 3,
  capUsd: 1.5,
  now: at(0),
  ...parts,
});

const usage = {
  inputTokens: 100,
  cacheWriteTokens: 2000,
  cacheReadTokens: 4000,
  outputTokens: 300,
};

test("a run is opened, records where it stands, and is closed with what it used", () => {
  const store = library(1);

  const opened = startTaggingRun(store, run());
  recordTaggingProgress(store, opened.id, {
    ...usage,
    classified: 2,
    failed: 1,
    costUsd: 0.0125,
    unansweredRequests: 3,
    heldUsd: 0.006,
    filedWithoutRequest: 1,
    now: at(1),
  });
  // Progress that says nothing of unanswered attempts, of what was held for
  // them, or of what was dealt with without a request leaves each as it was.
  recordTaggingProgress(store, opened.id, {
    ...usage,
    classified: 2,
    failed: 1,
    costUsd: 0.0125,
    now: at(1),
  });
  const closed = finishTaggingRun(store, opened.id, {
    outcome: "completed",
    now: at(2),
  });

  expect(opened).toMatchObject({
    startedAt: at(0),
    finishedAt: null,
    outcome: null,
    taxonomyVersion: TAXONOMY.version,
    selected: 3,
    capUsd: 1.5,
    costUsd: 0,
    unansweredRequests: 0,
    heldUsd: 0,
    filedWithoutRequest: 0,
  });
  expect(closed).toEqual({
    id: opened.id,
    startedAt: at(0),
    heartbeatAt: at(1),
    finishedAt: at(2),
    startedBy: "owner",
    mode: "untagged",
    transport: "direct",
    model: "a-model",
    taxonomyVersion: TAXONOMY.version,
    instructionsVersion: 1,
    vocabularyVersion: 1,
    outcome: "completed",
    failure: null,
    batchId: null,
    batchPostIds: null,
    selected: 3,
    classified: 2,
    failed: 1,
    ...usage,
    costUsd: 0.0125,
    unansweredRequests: 3,
    heldUsd: 0.006,
    filedWithoutRequest: 1,
    capUsd: 1.5,
  });
  expect(getOpenTaggingRun(store)).toBeUndefined();
  expect(listTaggingRuns(store)).toEqual([closed]);
});

test("a run is closed together with the last of its work: all of it is stored, or none", () => {
  const store = library(3);
  const opened = startTaggingRun(store, run());
  const progress = { ...usage, classified: 1, failed: 2, costUsd: 0.01 };
  const failures = () => summariseTagging(store).failed;
  const fail = (n: number) =>
    recordClassificationFailure(store, {
      postId: postId(n),
      reason: "refused",
      instructionsVersion: 1,
    });

  // Work that breaks halfway leaves nothing behind, and the run open.
  expect(() =>
    finishTaggingRunWith(store, opened.id, () => {
      classify(store, 1);
      fail(2);
      recordTaggingProgress(store, opened.id, progress);
      throw new Error("the process died here");
    }),
  ).toThrow("the process died here");
  expect(summariseTagging(store)).toMatchObject({ classified: 0, failed: 0 });
  expect(getOpenTaggingRun(store)).toMatchObject({
    id: opened.id,
    classified: 0,
  });

  // The same work done whole is stored with the closing.
  const closed = finishTaggingRunWith(store, opened.id, () => {
    classify(store, 1);
    fail(2);
    fail(3);
    recordTaggingProgress(store, opened.id, progress);
    return { outcome: "completed", now: at(2) };
  });
  expect(closed).toMatchObject({
    outcome: "completed",
    finishedAt: at(2),
    classified: 1,
    failed: 2,
  });
  expect(failures()).toBe(2);

  // A second process with the same results in hand finds the run closed:
  // its work is not called, and no failure is counted a second time.
  let called = false;
  expect(
    finishTaggingRunWith(store, opened.id, () => {
      called = true;
      fail(2);
      fail(3);
      return { outcome: "completed" };
    }),
  ).toBeUndefined();
  expect(called).toBe(false);
  // Counted once each, so both are still asked about by the next run.
  expect(candidates(store).total).toBe(2);
});

test("what one starter's runs have spent since a moment is summed over every run, and holds what was held for unanswered attempts", () => {
  const store = library(1);
  const spend = (
    startedBy: "owner" | "app",
    minute: number,
    costUsd: number,
    heldUsd: number,
  ) => {
    const opened = startTaggingRun(store, run({ startedBy, now: at(minute) }));
    recordTaggingProgress(store, opened.id, {
      ...usage,
      classified: 0,
      failed: 0,
      costUsd,
      heldUsd,
      now: at(minute),
    });
    return opened.id;
  };
  const finish = (id: number, minute: number) =>
    finishTaggingRun(store, id, { outcome: "completed", now: at(minute) });
  finish(spend("app", 0, 5, 5), 0);
  // More runs than any list of runs returns, the owner's among them.
  for (let n = 1; n <= 130; n += 1) {
    finish(spend(n % 13 === 0 ? "owner" : "app", n, 0.001, 0.0005), n);
  }
  // And one still open.
  spend("app", 131, 0.25, 0.125);

  const byApp = summariseTaggingSpend(store, {
    startedBy: "app",
    since: at(1),
  });

  expect(byApp.runs).toBe(121);
  expect(byApp.costUsd).toBeCloseTo(120 * 0.001 + 0.25, 10);
  expect(byApp.heldUsd).toBeCloseTo(120 * 0.0005 + 0.125, 10);
  expect(
    summariseTaggingSpend(store, { startedBy: "owner", since: at(1) }),
  ).toMatchObject({ runs: 10 });
  expect(
    summariseTaggingSpend(store, { startedBy: "app", since: at(200) }),
  ).toEqual({ runs: 0, costUsd: 0, heldUsd: 0 });
});

test("only one run is open at a time", () => {
  const store = library(1);
  const first = startTaggingRun(store, run());

  expect(() => startTaggingRun(store, run({ now: at(5) }))).toThrow(
    TaggingRunInProgress,
  );
  expect(getOpenTaggingRun(store)?.id).toBe(first.id);

  finishTaggingRun(store, first.id, { outcome: "failed", failure: "network" });

  expect(startTaggingRun(store, run({ now: at(6) })).id).toBeGreaterThan(
    first.id,
  );
});

test("a run that went silent is closed as abandoned by the next, and keeps what it had spent", () => {
  const store = library(1);
  const dead = startTaggingRun(store, run());
  recordTaggingProgress(store, dead.id, {
    ...usage,
    classified: 1,
    failed: 0,
    costUsd: 0.01,
    now: at(1),
  });
  const later = new Date(at(1).getTime() + TAGGING_RUN_STALE_MS);

  const next = startTaggingRun(store, run({ now: later }));

  expect(
    listTaggingRuns(store).map(({ id, outcome, costUsd }) => ({
      id,
      outcome,
      costUsd,
    })),
  ).toEqual([
    { id: next.id, outcome: null, costUsd: 0 },
    { id: dead.id, outcome: "abandoned", costUsd: 0.01 },
  ]);
});

test("a run that waits for a batch is never abandoned: its results are paid for", () => {
  const store = library(2);
  const waiting = startTaggingRun(store, run({ transport: "batch" }));
  recordTaggingProgress(store, waiting.id, {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    classified: 0,
    failed: 0,
    costUsd: 0,
    batch: { id: "batch-1", postIds: [postId(2), postId(1)] },
    now: at(1),
  });
  const muchLater = new Date(at(1).getTime() + 100 * TAGGING_RUN_STALE_MS);

  expect(() => startTaggingRun(store, run({ now: muchLater }))).toThrow(
    /waiting for the results of a batch/,
  );
  expect(getOpenTaggingRun(store)).toMatchObject({
    batchId: "batch-1",
    batchPostIds: [postId(2), postId(1)],
  });

  // Later progress leaves the batch as it was recorded.
  recordTaggingProgress(store, waiting.id, {
    ...usage,
    classified: 2,
    failed: 0,
    costUsd: 0.02,
  });
  expect(getOpenTaggingRun(store)).toMatchObject({
    batchId: "batch-1",
    classified: 2,
  });
});

test("a closed run takes no more progress and is not closed twice", () => {
  const store = library(1);
  const { id } = startTaggingRun(store, run());
  finishTaggingRun(store, id, { outcome: "stopped-at-cap" });

  expect(() =>
    recordTaggingProgress(store, id, {
      ...usage,
      classified: 0,
      failed: 0,
      costUsd: 0,
    }),
  ).toThrow(TaggingRunNotOpen);
  expect(() => finishTaggingRun(store, id, { outcome: "completed" })).toThrow(
    TaggingRunNotOpen,
  );
  // It is still there to read, as it was closed.
  expect(getTaggingRun(store, id)).toMatchObject({ outcome: "stopped-at-cap" });
  expect(() => getTaggingRun(store, id + 1)).toThrow(/no tagging run/);
  expect(() => listTaggingRuns(store, { limit: 0 })).toThrow(RangeError);
});

test("the summary says how the tagging stands, and keeps the two kinds of other apart", () => {
  const store = library(10);
  classify(store, 1);
  classify(store, 2, { category: "design", format: "unclear" });
  classify(store, 3, { category: "other", format: "discussion" });
  classify(store, 4, {
    category: "other",
    format: "unclear",
    tooLittleText: true,
  });
  classify(store, 5, {
    category: "other",
    format: "unclear",
    tooLittleText: true,
    model: null,
  });
  classify(store, 6, { proposedTags: ["drizzle", "server-actions"] });
  classify(store, 7, { proposedTags: ["drizzle"] });
  // The owner knew better than "too little text": it is no longer other at all.
  correctBookmark(store, postId(5), { category: "life" });
  // And filed one under other by hand, which is none of the above, not too little text.
  correctBookmark(store, postId(1), { category: "other", addTags: ["seo"] });
  recordClassificationFailure(store, {
    postId: postId(8),
    reason: "refused",
    instructionsVersion: 1,
  });
  const spent = startTaggingRun(store, run({ now: at(0) }));
  recordTaggingProgress(store, spent.id, {
    ...usage,
    classified: 7,
    failed: 1,
    costUsd: 0.25,
  });
  finishTaggingRun(store, spent.id, { outcome: "completed" });
  const open = startTaggingRun(
    store,
    run({ now: new Date(at(0).getTime() + 3 * 24 * 60 * 60 * 1000) }),
  );
  recordTaggingProgress(store, open.id, {
    ...usage,
    classified: 0,
    failed: 0,
    costUsd: 0.5,
  });

  expect(
    summariseTagging(store, {
      instructionsVersion: 1,
      now: new Date(at(0).getTime() + 3 * 24 * 60 * 60 * 1000 + 60_000),
    }),
  ).toEqual({
    bookmarks: 10,
    classified: 7,
    unclassified: 3,
    failed: 1,
    outdated: 0,
    behindVocabulary: 0,
    mentioningNewTags: 0,
    corrected: 2,
    other: {
      bookmarks: 3,
      tooLittleText: 1,
      noneOfTheAbove: 2,
      share: 3 / 7,
      noneOfTheAboveShare: 2 / 7,
    },
    unclearFormat: 3,
    proposals: 2,
    spentUsd: 0.75,
    spentLastDayUsd: 0.5,
    lastRun: expect.objectContaining({ id: open.id, outcome: null }),
  });
  expect(summariseTagging(store, { instructionsVersion: 2 }).outdated).toBe(7);
});

test("what is outdated is counted against the current instructions unless another version is named", () => {
  const store = library(3);
  // One classified by the instructions before these, two by the current ones.
  classify(store, 1, { instructionsVersion: INSTRUCTIONS_VERSION - 1 });
  classify(store, 2, { instructionsVersion: INSTRUCTIONS_VERSION });
  classify(store, 3, { instructionsVersion: INSTRUCTIONS_VERSION });

  // Asked with no version, as a status screen asks: the answer is the true one.
  expect(summariseTagging(store).outdated).toBe(1);
  expect(
    listClassificationCandidates(store, { which: "outdated" }).bookmarks.map(
      ({ postId: id }) => id,
    ),
  ).toEqual([postId(1)]);
  expect(
    summariseTagging(store, { instructionsVersion: INSTRUCTIONS_VERSION + 1 })
      .outdated,
  ).toBe(3);
  expect(INSTRUCTIONS_VERSION).toBeGreaterThan(1);
});

test("an empty library summarises to nothing, with no share to divide", () => {
  expect(summariseTagging(openTempStore())).toMatchObject({
    bookmarks: 0,
    classified: 0,
    other: { bookmarks: 0, share: 0, noneOfTheAboveShare: 0 },
    spentUsd: 0,
    lastRun: null,
  });
});

/** Classified bookmarks with texts that do and do not mention what will become tags. */
function mentioning() {
  const store = library(0);
  const captureId = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: captured,
  }).id;
  const texts = [
    "Moved our queries to Drizzle and never looked back",
    "drizzle-orm ships a new release today",
    "A thread about gardening, nothing else",
    "DrizzleORM migrations in ten minutes",
    "Server actions in depth: a guide",
    "Bun is fast",
    "A bundle of things, none of them a runtime",
  ];
  texts.forEach((text, index) => {
    const n = index + 1;
    upsertBookmark(store, {
      postId: postId(n),
      authorId: String(1000 + n),
      authorHandle: `author${n}`,
      authorName: `Author ${n}`,
      text,
      postedAt: new Date("2026-01-01T00:00:00.000Z"),
      sortIndex: String(BigInt(day(n).getTime()) << 20n),
      captureId,
    });
    classify(store, n);
  });
  return store;
}

test("a bookmark classified before a tag existed is behind the vocabulary, and worth asking again only if it mentions the tag", () => {
  const store = mentioning();

  expect(candidates(store, { which: "new-tags" }).total).toBe(0);
  expect(candidates(store, { which: "behind-vocabulary" }).total).toBe(0);

  addTag(store, "drizzle-orm", { aliases: ["drizzle"] });

  // By its name as words in a row, as one word, and by its alias.
  expect(candidates(store, { which: "new-tags" })).toEqual({
    total: 3,
    ids: [postId(4), postId(2), postId(1)],
  });
  expect(candidates(store, { which: "behind-vocabulary" }).total).toBe(7);
  expect(summariseTagging(store, { instructionsVersion: 1 })).toMatchObject({
    behindVocabulary: 7,
    mentioningNewTags: 3,
    outdated: 0,
    unclassified: 0,
  });
  // Neither an unclassified bookmark nor an outdated one, to an ordinary run.
  expect(candidates(store).total).toBe(0);
  expect(candidates(store, { which: "outdated" }).total).toBe(0);
});

test("a long one-word tag is found as a word and as the start of one, a short one only whole", () => {
  const store = mentioning();

  addTag(store, "bun");

  // "Bun is fast", and not "bundle".
  expect(candidates(store, { which: "new-tags" }).ids).toEqual([postId(6)]);

  addTag(store, "garden");
  addTag(store, "server-actions");

  // "gardening", and "Server actions" as words in a row.
  expect(candidates(store, { which: "new-tags" }).ids).toEqual([
    postId(6),
    postId(5),
    postId(3),
  ]);
});

test("a bookmark that has the new tag already, or on which the owner has spoken about it, is not asked", () => {
  const store = mentioning();
  // Proposed for 1, so accepting gives it the tag; the owner removes it from 2.
  classify(store, 1, { proposedTags: ["drizzle"] });
  acceptTagProposal(store, "drizzle");
  correctBookmark(store, postId(2), { removeTags: ["drizzle"] });

  expect(candidates(store, { which: "new-tags" }).ids).toEqual([postId(4)]);
});

test("once asked, a bookmark is no longer behind, whatever the answer was", () => {
  const store = mentioning();
  addTag(store, "drizzle");

  expect(
    recordNewTags(store, { postId: postId(1), tags: ["drizzle"] }),
  ).toEqual(["drizzle"]);
  expect(recordNewTags(store, { postId: postId(2), tags: [] })).toEqual([]);

  expect(candidates(store, { which: "new-tags" }).ids).toEqual([postId(4)]);
  expect(candidates(store, { which: "behind-vocabulary" }).total).toBe(5);
  // A bookmark classified now is asked about the whole vocabulary.
  classify(store, 4);
  expect(candidates(store, { which: "new-tags" }).total).toBe(0);
  expect(summariseTagging(store)).toMatchObject({
    behindVocabulary: 4,
    mentioningNewTags: 0,
  });
});

test("retiring, renaming and merging tags leave no bookmark behind: the bookmarks follow without being asked", () => {
  const store = mentioning();

  retireTag(store, "seo");
  renameTag(store, "nextjs", "next");
  mergeTags(store, "gemini", "chatgpt");
  addTagAlias(store, "drizzle", "react");

  expect(candidates(store, { which: "behind-vocabulary" }).total).toBe(0);
  expect(summariseTagging(store)).toMatchObject({
    behindVocabulary: 0,
    mentioningNewTags: 0,
  });

  // A restored tag is one the bookmarks classified meanwhile were not asked about.
  addTag(store, "seo");

  expect(candidates(store, { which: "behind-vocabulary" }).total).toBe(7);
});

test("a run records the vocabulary it asked with: the current one unless told", () => {
  const store = library(1);
  addTag(store, "bun");

  const current = startTaggingRun(store, run());
  finishTaggingRun(store, current.id, { outcome: "completed" });
  const earlier = startTaggingRun(
    store,
    run({ vocabularyVersion: 1, now: at(9) }),
  );

  expect(current.vocabularyVersion).toBe(2);
  expect(earlier.vocabularyVersion).toBe(1);
});
