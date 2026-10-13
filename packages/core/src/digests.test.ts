import { expect, test } from "vitest";
import { type BookmarkSighting, upsertBookmark } from "./bookmarks.ts";
import {
  DIGEST_LIMITS,
  DIGEST_RUN_STALE_MS,
  DigestRunInProgress,
  DigestRunNotOpen,
  type DigestRunResult,
  type DigestText,
  finishDigestRun,
  getDigest,
  listDigestRuns,
  listWeeks,
  type NewDigestRun,
  startDigestRun,
  summariseWeek,
} from "./digests.ts";
import { correctBookmark, recordClassification } from "./labels.ts";
import { listBookmarks } from "./library.ts";
import { parseCapture } from "./parsing.ts";
import { insertRawCapture } from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";
import { readFixture } from "./testing/fixtures.ts";
import { openTempStore } from "./testing/temp-database.ts";
import { weekAfter, weekBefore, weekFromKey, weekOf } from "./weeks.ts";

const posted = new Date("2026-01-01T00:00:00.000Z");
const captured = new Date("2026-10-05T09:00:00.000Z");
/** A moment of this computer's June 2026, in which the 8th is a Monday. */
const june = (day: number, hour = 12) => new Date(2026, 5, day, hour);
const WEEK = weekOf(june(10));
const postId = (n: number) => String(1975000000000000000n + BigInt(n));
/** A sort index that decodes to the given bookmark time. */
const sortIndexAt = (at: Date) => String(BigInt(at.getTime()) << 20n);

interface Library {
  store: Store;
  /** Adds bookmark `n`, bookmarked at `at`. */
  add(n: number, at: Date, content?: Partial<BookmarkSighting>): string;
  file(n: number, category: string, tags?: string[], little?: boolean): void;
}

function library(): Library {
  const store = openTempStore();
  const captureId = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: captured,
  }).id;
  return {
    store,
    add(n, at, content = {}) {
      upsertBookmark(store, {
        postId: postId(n),
        authorId: String(1000 + n),
        authorHandle: `author${n}`,
        authorName: `Author ${n}`,
        text: `post ${n}`,
        postedAt: posted,
        sortIndex: sortIndexAt(at),
        captureId,
        ...content,
      });
      return postId(n);
    },
    file(n, category, tags = [], little = false) {
      recordClassification(store, {
        postId: postId(n),
        category,
        format: "guide",
        tags,
        tooLittleText: little,
        instructionsVersion: 1,
        model: "a-model",
      });
    },
  };
}

test("a week's summary counts what was bookmarked in it, to the moment, by category, format and tag", () => {
  const { store, add, file } = library();
  add(1, WEEK.start);
  add(2, june(10));
  add(3, june(12));
  add(4, new Date(WEEK.end.getTime() - 1));
  // Either side of the week: the last moment before it and the first after.
  add(5, new Date(WEEK.start.getTime() - 1));
  add(6, WEEK.end);
  file(1, "web-dev", ["react", "nextjs"]);
  file(2, "web-dev", ["react"]);
  file(3, "ai-agents");
  file(5, "design", ["tailwind"]);

  const summary = summariseWeek(store, WEEK);

  expect(summary).toEqual({
    week: WEEK,
    bookmarks: 4,
    removedOnX: 0,
    filed: 3,
    unfiled: 1,
    categories: [
      { category: "web-dev", bookmarks: 2 },
      { category: "ai-agents", bookmarks: 1 },
    ],
    formats: [{ format: "guide", bookmarks: 3 }],
    tags: [
      { tag: "react", bookmarks: 2 },
      { tag: "nextjs", bookmarks: 1 },
    ],
    other: { bookmarks: 0, tooLittleText: 0, noneOfTheAbove: 0 },
  });
  expect(summariseWeek(store, weekBefore(WEEK)).bookmarks).toBe(1);
  expect(summariseWeek(store, weekAfter(WEEK)).bookmarks).toBe(1);
  // The same bookmarks a list of the week holds.
  expect(
    listBookmarks(store, {
      bookmarkedSince: WEEK.start,
      bookmarkedBefore: WEEK.end,
    }).total,
  ).toBe(summary.bookmarks);
});

test("the two reasons for 'other' are counted apart, and the owner's word comes first", () => {
  const { store, add, file } = library();
  for (const n of [1, 2, 3, 4]) add(n, june(8 + n));
  file(1, "other", [], true);
  file(2, "other");
  file(3, "other");
  file(4, "other", [], true);
  // The owner files one of the two that said too little: it leaves "other".
  correctBookmark(store, postId(4), { category: "life" });

  expect(summariseWeek(store, WEEK)).toMatchObject({
    bookmarks: 4,
    filed: 4,
    unfiled: 0,
    other: { bookmarks: 3, tooLittleText: 1, noneOfTheAbove: 2 },
  });
  expect(
    listBookmarks(store, {
      category: "other",
      tooLittleText: false,
      bookmarkedSince: WEEK.start,
      bookmarkedBefore: WEEK.end,
    }).bookmarks.map((bookmark) => bookmark.postId),
  ).toEqual([postId(3), postId(2)]);
});

test("a bookmark removed on X leaves the week's counts and is counted apart", () => {
  const { store, add } = library();
  add(1, june(9));
  const removed = add(2, june(10));
  const capture = insertRawCapture(store, {
    source: "x-web-client",
    operation: "DeleteBookmark",
    payload: readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json"),
    requestBody: JSON.stringify({ variables: { tweet_id: removed } }),
    receivedAt: new Date("2026-10-06T09:00:00.000Z"),
  });
  parseCapture(store, capture.id);

  expect(summariseWeek(store, WEEK)).toMatchObject({
    bookmarks: 1,
    removedOnX: 1,
  });
  expect(listWeeks(store)).toEqual([
    { week: WEEK, bookmarks: 1, written: false },
  ]);
});

test("the weeks that hold something are listed latest first, each with its count", () => {
  const { store, add } = library();
  add(1, june(2));
  add(2, june(9));
  add(3, june(14, 23));
  add(4, june(24));

  expect(
    listWeeks(store).map(({ week, bookmarks }) => [week.key, bookmarks]),
  ).toEqual([
    ["2026-06-22", 1],
    ["2026-06-08", 2],
    ["2026-06-01", 1],
  ]);
  expect(listWeeks(openTempStore())).toEqual([]);
});

function newRun(parts: Partial<NewDigestRun> = {}): NewDigestRun {
  return {
    week: WEEK,
    startedBy: "owner",
    model: "a-model",
    instructionsVersion: 1,
    bookmarksInWeek: 3,
    postIds: [postId(1), postId(2), postId(3)],
    capUsd: 0.5,
    now: new Date("2026-10-06T10:00:00.000Z"),
    ...parts,
  };
}

const TEXT: DigestText = {
  overview: "Three posts, two of them about one thing.",
  themes: [
    {
      title: "One thing",
      summary: "Two posts walk through it.",
      postIds: [postId(1), postId(2)],
    },
  ],
  worthRevisiting: [{ postId: postId(3), why: "It is the longest." }],
};

const written = (parts: Partial<DigestRunResult> = {}): DigestRunResult => ({
  outcome: "written",
  text: TEXT,
  inputTokens: 1200,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 800,
  costUsd: 0.0208,
  unansweredRequests: 0,
  now: new Date("2026-10-06T10:01:00.000Z"),
  ...parts,
});

function weekOfThree(): Library {
  const lib = library();
  for (const n of [1, 2, 3]) lib.add(n, june(8 + n));
  return lib;
}

test("a run is recorded with what it was asked, what it used and what it wrote, and is then the week's digest", () => {
  const lib = weekOfThree();

  const open = startDigestRun(lib.store, newRun());
  expect(open).toMatchObject({
    week: WEEK.key,
    periodStart: WEEK.start,
    periodEnd: WEEK.end,
    startedBy: "owner",
    model: "a-model",
    instructionsVersion: 1,
    outcome: null,
    finishedAt: null,
    bookmarksInWeek: 3,
    postIds: [postId(1), postId(2), postId(3)],
    capUsd: 0.5,
    costUsd: 0,
    text: null,
  });
  expect(getDigest(lib.store, WEEK.key)).toBeUndefined();

  const closed = finishDigestRun(lib.store, open.id, written());

  expect(closed).toMatchObject({
    outcome: "written",
    failure: null,
    finishedAt: new Date("2026-10-06T10:01:00.000Z"),
    inputTokens: 1200,
    outputTokens: 800,
    costUsd: 0.0208,
    unansweredRequests: 0,
    text: TEXT,
  });
  expect(getDigest(lib.store, WEEK.key)).toEqual(closed);
  expect(getDigest(lib.store, weekBefore(WEEK).key)).toBeUndefined();
  expect(getDigest(lib.store, "not a week")).toBeUndefined();
  expect(listWeeks(lib.store)).toEqual([
    { week: WEEK, bookmarks: 3, written: true },
  ]);
});

test("a digest written again takes the place of the earlier one, which stays on record", () => {
  const lib = weekOfThree();
  const first = startDigestRun(lib.store, newRun());
  finishDigestRun(lib.store, first.id, written());
  const second = startDigestRun(lib.store, newRun({ startedBy: "schedule" }));
  finishDigestRun(
    lib.store,
    second.id,
    written({ text: { ...TEXT, overview: "Written again." } }),
  );

  expect(getDigest(lib.store, WEEK.key)).toMatchObject({
    id: second.id,
    startedBy: "schedule",
    text: { overview: "Written again." },
  });
  expect(listDigestRuns(lib.store).map(({ id }) => id)).toEqual([
    second.id,
    first.id,
  ]);
  expect(listDigestRuns(lib.store, { week: WEEK.key })).toHaveLength(2);
  expect(listDigestRuns(lib.store, { week: "2026-06-15" })).toEqual([]);
  expect(() => listDigestRuns(lib.store, { limit: 0 })).toThrow(RangeError);
});

test("a failed run records its code and what it cost, and leaves an earlier digest standing", () => {
  const lib = weekOfThree();
  const first = startDigestRun(lib.store, newRun());
  finishDigestRun(lib.store, first.id, written());
  const second = startDigestRun(lib.store, newRun());

  const failed = finishDigestRun(lib.store, second.id, {
    outcome: "failed",
    failure: "cut-short",
    inputTokens: 1200,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 8000,
    costUsd: 0.1648,
    unansweredRequests: 1,
  });

  expect(failed).toMatchObject({
    outcome: "failed",
    failure: "cut-short",
    costUsd: 0.1648,
    unansweredRequests: 1,
    text: null,
  });
  expect(getDigest(lib.store, WEEK.key)?.id).toBe(first.id);
});

test("a digest can point only at the bookmarks its run sent", () => {
  const lib = weekOfThree();
  lib.add(4, june(13));
  const run = startDigestRun(lib.store, newRun());
  const naming = (id: string): DigestText => ({
    ...TEXT,
    themes: [{ title: "A theme", summary: "About a post.", postIds: [id] }],
  });

  // A bookmark of the library that this run did not send, an id of none,
  // and a text that is no id at all.
  for (const id of [postId(4), postId(99), "https://example.com/"]) {
    expect(() =>
      finishDigestRun(lib.store, run.id, written({ text: naming(id) })),
    ).toThrow(/was not among those sent/);
  }
  expect(() =>
    finishDigestRun(
      lib.store,
      run.id,
      written({
        text: { ...TEXT, worthRevisiting: [{ postId: postId(4), why: "x" }] },
      }),
    ),
  ).toThrow(/was not among those sent/);
  // Refused, the run is still open, and nothing was stored.
  expect(listDigestRuns(lib.store)[0]).toMatchObject({
    outcome: null,
    text: null,
  });
  expect(() =>
    finishDigestRun(lib.store, run.id, written({ text: naming(postId(2)) })),
  ).not.toThrow();
});

test("a run cannot be opened for bookmarks the library does not hold, twice for one, or for a week that is none", () => {
  const lib = weekOfThree();

  expect(() =>
    startDigestRun(lib.store, newRun({ postIds: [postId(1), postId(99)] })),
  ).toThrow(/does not hold/);
  expect(() =>
    startDigestRun(lib.store, newRun({ postIds: [postId(1), postId(1)] })),
  ).toThrow(/once/);
  expect(() =>
    startDigestRun(lib.store, newRun({ week: { ...WEEK, key: "2026-06-09" } })),
  ).toThrow(/not the name of a week/);
  expect(() =>
    startDigestRun(lib.store, newRun({ instructionsVersion: 0 })),
  ).toThrow(RangeError);
  expect(listDigestRuns(lib.store)).toEqual([]);
});

test("what a digest says is stored as plain text: no hidden characters, no control characters, no address, within its limits", () => {
  const lib = weekOfThree();
  const run = startDigestRun(lib.store, newRun());
  // U+E0041 is a tag character: it shows as nothing and a model reads it.
  const hidden = String.fromCodePoint(0xe0041);

  const closed = finishDigestRun(
    lib.store,
    run.id,
    written({
      text: {
        overview: `  Read${hidden} this at https://example.com/a?b=c or www.example.org now.\u0007\n\nSecond line.  `,
        themes: [
          {
            title: "T".repeat(DIGEST_LIMITS.themeTitle + 50),
            summary:
              "javascript://alert(1) is gone, and <b>markup</b> is text.",
            postIds: [postId(1), postId(1), postId(2)],
          },
        ],
        worthRevisiting: [
          { postId: postId(3), why: "Once." },
          { postId: postId(3), why: "Twice." },
        ],
      },
    }),
  );

  expect(closed.text).toEqual({
    overview: "Read this at or now.\n\nSecond line.",
    themes: [
      {
        title: "T".repeat(DIGEST_LIMITS.themeTitle),
        summary: "is gone, and <b>markup</b> is text.",
        postIds: [postId(1), postId(2)],
      },
    ],
    worthRevisiting: [{ postId: postId(3), why: "Once." }],
  });
});

test("a digest with an empty part, a part that is not text, or more themes than a page holds is refused", () => {
  const lib = weekOfThree();
  const run = startDigestRun(lib.store, newRun());
  const refused = (text: unknown) =>
    expect(() =>
      finishDigestRun(lib.store, run.id, written({ text: text as DigestText })),
    ).toThrow(RangeError);

  refused({ ...TEXT, overview: "   " });
  refused({ ...TEXT, overview: 7 });
  refused({ ...TEXT, overview: "https://example.com/only-an-address" });
  refused({ ...TEXT, themes: "none" });
  refused({
    ...TEXT,
    themes: Array.from({ length: DIGEST_LIMITS.themes + 1 }, () => ({
      title: "A theme",
      summary: "A summary.",
      postIds: [],
    })),
  });
  // An ending needs its text exactly when it wrote one.
  expect(() =>
    finishDigestRun(lib.store, run.id, written({ outcome: "failed" })),
  ).toThrow(RangeError);
  expect(() =>
    finishDigestRun(lib.store, run.id, written({ text: undefined })),
  ).toThrow(RangeError);
});

test("one run is open at a time, and a run left open by a process that died gives way once it is stale", () => {
  const lib = weekOfThree();
  const started = new Date("2026-10-06T10:00:00.000Z");
  const first = startDigestRun(lib.store, newRun({ now: started }));
  const later = (ms: number) => new Date(started.getTime() + ms);

  let refusal: unknown;
  try {
    startDigestRun(lib.store, newRun({ now: later(60_000) }));
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(DigestRunInProgress);
  expect((refusal as DigestRunInProgress).run.id).toBe(first.id);

  const second = startDigestRun(
    lib.store,
    newRun({ now: later(DIGEST_RUN_STALE_MS) }),
  );

  expect(
    listDigestRuns(lib.store).map(({ id, outcome }) => [id, outcome]),
  ).toEqual([
    [second.id, null],
    [first.id, "abandoned"],
  ]);
  // The process that died comes back: its run is no longer its to end.
  expect(() => finishDigestRun(lib.store, first.id, written())).toThrow(
    DigestRunNotOpen,
  );
  expect(getDigest(lib.store, WEEK.key)).toBeUndefined();
});

test("a week's name in a stored run is the name of a week, whatever wrote the row", () => {
  const lib = weekOfThree();
  const db = connectionOf(lib.store);
  const insert = (week: string) =>
    db
      .prepare(
        `INSERT INTO digest_runs (
           week, period_start_at, period_end_at, started_at, started_by,
           model, instructions_version, bookmarks_in_week, post_ids, cap_usd
         ) VALUES (?, ?, ?, ?, 'owner', 'a-model', 1, 0, '[]', 1)`,
      )
      .run(week, WEEK.start.getTime(), WEEK.end.getTime(), captured.getTime());

  expect(() => insert("last week")).toThrow(/CHECK/);
  expect(weekFromKey(WEEK.key)).toEqual(WEEK);
});
