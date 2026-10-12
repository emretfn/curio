import { expect, test } from "vitest";
import {
  type BookmarkSighting,
  getBookmark,
  upsertBookmark,
} from "./bookmarks.ts";
import { insertRawCapture } from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";
import { openTempStore, tempDatabasePath } from "./testing/temp-database.ts";

const monday = new Date("2026-10-05T09:00:00.000Z");
const thursday = new Date("2026-10-08T18:30:00.000Z");

function captureReceivedAt(store: Store, receivedAt: Date): number {
  return insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt,
  }).id;
}

function sighting(
  captureId: number,
  overrides: Partial<BookmarkSighting> = {},
): BookmarkSighting {
  return {
    postId: "1975000000000000001",
    authorId: "44196397",
    text: "original text",
    postedAt: new Date("2026-04-08T06:30:15.000Z"),
    captureId,
    ...overrides,
  };
}

test("a new bookmark is first seen when its capture was received, not when it was parsed", () => {
  const store = openTempStore();
  const captureId = captureReceivedAt(store, monday);

  const bookmark = upsertBookmark(store, sighting(captureId));

  expect(bookmark).toEqual({
    postId: "1975000000000000001",
    authorId: "44196397",
    text: "original text",
    postedAt: new Date("2026-04-08T06:30:15.000Z"),
    firstSeenAt: monday,
    firstSeenCaptureId: captureId,
    lastSeenAt: monday,
    lastSeenCaptureId: captureId,
  });
  expect(getBookmark(store, bookmark.postId)).toEqual(bookmark);
});

test("upserting the same bookmark again keeps the original first-seen time", () => {
  const path = tempDatabasePath();
  const store = openTempStore(path);
  const first = captureReceivedAt(store, monday);
  const second = captureReceivedAt(store, thursday);
  upsertBookmark(store, sighting(first));

  const updated = upsertBookmark(
    store,
    sighting(second, { text: "edited text" }),
  );

  expect(updated.firstSeenAt).toEqual(monday);
  expect(updated.firstSeenCaptureId).toBe(first);
  expect(updated.lastSeenAt).toEqual(thursday);
  expect(updated.lastSeenCaptureId).toBe(second);
  expect(updated.text).toBe("edited text");
  store.close();
  expect(getBookmark(openTempStore(path), updated.postId)).toEqual(updated);
});

test("replaying an older capture changes nothing", () => {
  const store = openTempStore();
  const older = captureReceivedAt(store, monday);
  const newer = captureReceivedAt(store, thursday);
  const current = upsertBookmark(store, sighting(newer, { text: "current" }));

  const afterReplay = upsertBookmark(store, sighting(older, { text: "stale" }));

  expect(afterReplay).toEqual(current);
});

test("re-parsing the same capture updates the content and keeps first-seen", () => {
  const store = openTempStore();
  const captureId = captureReceivedAt(store, monday);
  upsertBookmark(store, sighting(captureId, { text: "truncated previ" }));

  const reparsed = upsertBookmark(
    store,
    sighting(captureId, { text: "the full long-post text" }),
  );

  expect(reparsed.text).toBe("the full long-post text");
  expect(reparsed.firstSeenAt).toEqual(monday);
});

test("the database refuses to overwrite first-seen, even through raw SQL", () => {
  const store = openTempStore();
  const first = captureReceivedAt(store, monday);
  const second = captureReceivedAt(store, thursday);
  const { postId } = upsertBookmark(store, sighting(first));
  const db = connectionOf(store);

  expect(() =>
    db
      .prepare("UPDATE bookmarks SET first_seen_at = ? WHERE post_id = ?")
      .run(Date.now(), postId),
  ).toThrow(/set once and never overwritten/);
  expect(() =>
    db
      .prepare(
        "UPDATE bookmarks SET first_seen_capture_id = ? WHERE post_id = ?",
      )
      .run(second, postId),
  ).toThrow(/set once and never overwritten/);
  expect(getBookmark(store, postId)?.firstSeenAt).toEqual(monday);
});

test("a bookmark cannot cite a capture that was never stored", () => {
  const store = openTempStore();

  expect(() => upsertBookmark(store, sighting(999))).toThrow(
    /Raw capture 999 does not exist/,
  );
  expect(getBookmark(store, sighting(999).postId)).toBeUndefined();
});

test("ids that are not X's numeric ids are rejected", () => {
  const store = openTempStore();
  const captureId = captureReceivedAt(store, monday);

  for (const postId of ["", "tweet-1975000000000000001", "19750 1"]) {
    expect(() =>
      upsertBookmark(store, sighting(captureId, { postId })),
    ).toThrow(/CHECK constraint failed/);
  }
  expect(() =>
    upsertBookmark(store, sighting(captureId, { authorId: "@jack" })),
  ).toThrow(/CHECK constraint failed/);
});

test("an unknown post id reads as undefined", () => {
  expect(getBookmark(openTempStore(), "1")).toBeUndefined();
});
