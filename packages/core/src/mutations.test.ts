import { expect, test } from "vitest";
import { getBookmark } from "./bookmarks.ts";
import {
  getCaptureParse,
  listParseIssues,
  parseCapture,
  reparseAllCaptures,
} from "./parsing.ts";
import { insertRawCapture } from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";
import { readFixture } from "./testing/fixtures.ts";
import { openTempStore } from "./testing/temp-database.ts";

const page = readFixture("x-web-client/Bookmarks/2026-10-12-text-posts.json");
const created = readFixture("x-web-client/CreateBookmark/2026-10-12-done.json");
const removed = readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json");
/** A post of the page fixture, which the mutations below are made to name. */
const POST: string =
  JSON.parse(
    page,
  ).data.bookmark_timeline_v2.timeline.instructions[0].entries[0].entryId.slice(
    6,
  );
const requestFor = (postId: string) =>
  JSON.stringify({ variables: { tweet_id: postId }, queryId: "abc" });

const monday = new Date("2026-10-05T09:00:00.000Z");
const tuesday = new Date("2026-10-06T09:00:00.000Z");
const wednesday = new Date("2026-10-07T09:00:00.000Z");
const thursday = new Date("2026-10-08T09:00:00.000Z");

type Kind = "page" | "create" | "remove";

/** Stores one capture: a page of the timeline that lists POST, or a mutation that names it. */
function capture(
  store: Store,
  kind: Kind,
  receivedAt: Date,
  postId = POST,
): number {
  return insertRawCapture(store, {
    source: "x-web-client",
    operation:
      kind === "page"
        ? "Bookmarks"
        : kind === "create"
          ? "CreateBookmark"
          : "DeleteBookmark",
    payload: kind === "page" ? page : kind === "create" ? created : removed,
    requestBody: kind === "page" ? undefined : requestFor(postId),
    receivedAt,
  }).id;
}

function parsed(store: Store, kind: Kind, receivedAt: Date, postId = POST) {
  const captureId = capture(store, kind, receivedAt, postId);
  return parseCapture(store, captureId);
}

const mutationRows = (store: Store) =>
  connectionOf(store)
    .prepare("SELECT * FROM bookmark_mutations ORDER BY post_id")
    .all();

test("a bookmark removed on X stays in the library, marked with when X confirmed the removal", () => {
  const store = openTempStore();
  parsed(store, "page", monday);

  expect(parsed(store, "remove", tuesday)).toMatchObject({
    outcome: "parsed",
    bookmarkCount: 0,
    failedEntryCount: 0,
    warningCount: 0,
  });

  expect(listParseIssues(store)).toEqual([]);
  expect(getBookmark(store, POST)).toMatchObject({
    postId: POST,
    removedOnXAt: tuesday,
    firstSeenAt: monday,
    lastSeenAt: monday,
  });
});

test("bookmarking it again clears the mark, and the confirmation is its bookmark time", () => {
  const store = openTempStore();
  parsed(store, "page", monday);
  parsed(store, "remove", tuesday);
  const before = getBookmark(store, POST);

  parsed(store, "create", wednesday);

  // The fixture's sort index puts the first bookmarking in May; the bookmark
  // that now stands is the one X confirmed on Wednesday.
  expect(before?.bookmarkedAt).toEqual(before?.estimatedBookmarkedAt);
  expect(getBookmark(store, POST)).toMatchObject({
    removedOnXAt: null,
    observedBookmarkedAt: wednesday,
    bookmarkedAt: wednesday,
    estimatedBookmarkedAt: before?.estimatedBookmarkedAt,
    firstSeenAt: monday,
  });
});

test("a page of the timeline that lists the post after its removal shows it was bookmarked again", () => {
  const store = openTempStore();
  parsed(store, "page", monday);
  parsed(store, "remove", tuesday);

  parsed(store, "page", wednesday);

  expect(getBookmark(store, POST)).toMatchObject({
    removedOnXAt: null,
    lastSeenAt: wednesday,
  });
});

test("removing it once more marks it again, with the later time", () => {
  const store = openTempStore();
  parsed(store, "page", monday);
  parsed(store, "remove", tuesday);
  parsed(store, "create", wednesday);

  parsed(store, "remove", thursday);

  expect(getBookmark(store, POST)).toMatchObject({
    removedOnXAt: thursday,
    observedBookmarkedAt: wednesday,
  });
});

test("a bookmark confirmed by X before the timeline listed it has both times, and the later one stands", () => {
  const store = openTempStore();
  parsed(store, "create", monday);

  expect(getBookmark(store, POST)).toBeUndefined();
  parsed(store, "page", tuesday);

  const bookmark = getBookmark(store, POST);
  expect(bookmark).toMatchObject({
    observedBookmarkedAt: monday,
    bookmarkedAt: monday,
    removedOnXAt: null,
  });
  expect(bookmark?.estimatedBookmarkedAt?.getTime()).toBeLessThan(
    monday.getTime(),
  );
});

test("a mutation of a post the library holds no bookmark of is kept, and makes no bookmark", () => {
  const store = openTempStore();
  const elsewhere = "1861899614026727424";

  parsed(store, "create", monday, elsewhere);
  parsed(store, "remove", tuesday, elsewhere);

  expect(getBookmark(store, elsewhere)).toBeUndefined();
  expect(mutationRows(store)).toEqual([
    {
      post_id: elsewhere,
      bookmarked_at: monday.getTime(),
      bookmarked_capture_id: 1,
      removed_at: tuesday.getTime(),
      removed_capture_id: 2,
    },
  ]);
});

test("a removal that reaches the library before the page that lists the post still marks it", () => {
  const store = openTempStore();
  const pageId = capture(store, "page", monday);
  const removalId = capture(store, "remove", tuesday);

  // Delivered out of order: the newer capture is parsed first.
  parseCapture(store, removalId);
  expect(getBookmark(store, POST)).toBeUndefined();
  parseCapture(store, pageId);

  expect(getBookmark(store, POST)).toMatchObject({
    removedOnXAt: tuesday,
    lastSeenAt: monday,
  });
});

test("the same captures give the same library in whatever order they are parsed", () => {
  const steps: [Kind, Date][] = [
    ["page", monday],
    ["remove", tuesday],
    ["create", wednesday],
    ["remove", thursday],
    ["create", tuesday],
    ["remove", monday],
  ];
  const outcome = (order: number[]) => {
    const store = openTempStore();
    const ids = steps.map(([kind, at]) => capture(store, kind, at));
    for (const index of order) parseCapture(store, ids[index] ?? 0);
    // Parsed a second time, in the opposite order, to show nothing moves.
    for (const index of order.toReversed())
      parseCapture(store, ids[index] ?? 0);
    const { lastSeenAt, removedOnXAt, observedBookmarkedAt, bookmarkedAt } =
      getBookmark(store, POST) ?? {};
    return {
      mutations: mutationRows(store),
      bookmark: {
        lastSeenAt,
        removedOnXAt,
        observedBookmarkedAt,
        bookmarkedAt,
      },
    };
  };

  const inOrder = outcome([0, 1, 2, 3, 4, 5]);

  expect(inOrder.bookmark).toEqual({
    lastSeenAt: monday,
    removedOnXAt: thursday,
    observedBookmarkedAt: wednesday,
    bookmarkedAt: wednesday,
  });
  for (const order of [
    [5, 4, 3, 2, 1, 0],
    [3, 0, 5, 2, 4, 1],
    [2, 3, 1, 0, 5, 4],
  ]) {
    expect(outcome(order)).toEqual(inOrder);
  }
});

test("a full re-parse reads the mutations again and, run twice, changes nothing the second time", () => {
  const store = openTempStore();
  capture(store, "page", monday);
  capture(store, "remove", tuesday);
  capture(store, "create", wednesday);
  capture(store, "remove", thursday);
  const derived = () => ({
    mutations: mutationRows(store),
    parses: connectionOf(store)
      .prepare("SELECT * FROM capture_parses ORDER BY capture_id")
      .all(),
    bookmark: getBookmark(store, POST),
  });

  expect(reparseAllCaptures(store)).toEqual({ captures: 4, changed: 4 });
  const first = derived();
  expect(reparseAllCaptures(store)).toEqual({ captures: 4, changed: 0 });

  expect(derived()).toEqual(first);
  expect(first.bookmark).toMatchObject({
    removedOnXAt: thursday,
    observedBookmarkedAt: wednesday,
  });
});

test("two mutations received in the same millisecond resolve the same way in either order", () => {
  const outcome = (order: number[]) => {
    const store = openTempStore();
    capture(store, "page", monday);
    const ids = [
      capture(store, "remove", tuesday),
      capture(store, "remove", tuesday),
    ];
    for (const index of order) parseCapture(store, ids[index] ?? 0);
    return mutationRows(store);
  };

  expect(outcome([0, 1])).toEqual(outcome([1, 0]));
  expect(outcome([0, 1])).toMatchObject([{ removed_capture_id: 3 }]);
});

test("a mutation X did not confirm changes nothing, and is recorded as not understood", () => {
  const store = openTempStore();
  parsed(store, "page", monday);
  const { id } = insertRawCapture(store, {
    source: "x-web-client",
    operation: "DeleteBookmark",
    payload: '{"errors":[{"code":139}]}',
    requestBody: requestFor(POST),
    receivedAt: tuesday,
  });

  parseCapture(store, id);

  expect(getCaptureParse(store, id)).toMatchObject({ outcome: "failed" });
  expect(mutationRows(store)).toEqual([]);
  expect(getBookmark(store, POST)?.removedOnXAt).toBeNull();
});

test("the database refuses a mutation row that says nothing, or half of something", () => {
  const store = openTempStore();
  const captureId = capture(store, "remove", monday);
  const insert = (columns: string, values: string) =>
    connectionOf(store)
      .prepare(`INSERT INTO bookmark_mutations (${columns}) VALUES (${values})`)
      .run({ captureId, at: monday.getTime() });

  expect(() => insert("post_id", "'123'")).toThrow(/CHECK constraint/);
  expect(() => insert("post_id, removed_at", "'123', @at")).toThrow(
    /CHECK constraint/,
  );
  expect(() =>
    insert("post_id, removed_at, removed_capture_id", "'12a', @at, @captureId"),
  ).toThrow(/CHECK constraint/);
  expect(() =>
    insert(
      "post_id, removed_at, removed_capture_id",
      "'123', 1791, @captureId",
    ),
  ).toThrow(/CHECK constraint/);
  expect(() =>
    insert("post_id, removed_at, removed_capture_id", "'123', @at, 999"),
  ).toThrow(/FOREIGN KEY constraint/);
});
