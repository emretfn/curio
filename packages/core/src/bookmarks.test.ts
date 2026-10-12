import { expect, test } from "vitest";
import {
  type BookmarkSighting,
  estimateBookmarkedAt,
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
    authorHandle: "someone",
    authorName: "Some One",
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
    authorHandle: "someone",
    authorName: "Some One",
    authorAvatarUrl: null,
    authorVerified: false,
    text: "original text",
    postedAt: new Date("2026-04-08T06:30:15.000Z"),
    lang: null,
    conversationId: null,
    inReplyToPostId: null,
    inReplyToHandle: null,
    media: [],
    links: [],
    card: null,
    article: null,
    quoted: null,
    likeCount: null,
    repostCount: null,
    replyCount: null,
    quoteCount: null,
    bookmarkCount: null,
    viewCount: null,
    sortIndex: null,
    estimatedBookmarkedAt: null,
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

test("everything a sighting says about its post is stored and read back, across a reopen", () => {
  const path = tempDatabasePath();
  const store = openTempStore(path);
  const captureId = captureReceivedAt(store, monday);
  const content = {
    authorAvatarUrl: "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
    authorVerified: true,
    lang: "en",
    conversationId: "1974000000000000000",
    inReplyToPostId: "1974000000000000000",
    inReplyToHandle: "someone_else",
    media: [
      {
        type: "video" as const,
        imageUrl: "https://pbs.twimg.com/amplify_video_thumb/2/img/b.jpg",
        width: 1280,
        height: 720,
        altText: "a caf\u00e9 \u{1F516}",
        videoUrl: "https://video.twimg.com/amplify_video/2/vid/c.mp4",
        durationMs: 12_500,
      },
    ],
    links: [
      {
        url: "https://example.com/a?b=1&c=2",
        shortUrl: "https://t.co/abcdefghij",
        displayUrl: "example.com/a",
      },
    ],
    card: {
      name: "summary_large_image",
      url: "https://example.com/a?b=1&c=2",
      title: "A title",
      description: null,
      domain: "example.com",
      imageUrl: null,
    },
    article: {
      id: "1973000000000000000",
      title: "An article",
      previewText: "It begins",
      coverImageUrl: null,
    },
    likeCount: 12,
    repostCount: 3,
    replyCount: 0,
    quoteCount: 1,
    bookmarkCount: 40,
    viewCount: 5_000_000_000,
  };
  const quoted = {
    ...content,
    available: true as const,
    postId: "1972000000000000000",
    authorId: "12",
    authorHandle: "quoted",
    authorName: "Quoted",
    text: "the quoted text",
    postedAt: new Date("2026-04-01T00:00:00.123Z"),
    quotedPostId: "1971000000000000000",
  };

  const bookmark = upsertBookmark(
    store,
    sighting(captureId, {
      ...content,
      quoted,
      sortIndex: "1861891119789912064",
    }),
  );

  expect(bookmark).toMatchObject({ ...content, quoted });
  expect(bookmark.quoted).toEqual(quoted);
  store.close();
  expect(getBookmark(openTempStore(path), bookmark.postId)).toEqual(bookmark);
});

test("a quoted post X withholds is stored by its id", () => {
  const store = openTempStore();
  const captureId = captureReceivedAt(store, monday);

  const bookmark = upsertBookmark(
    store,
    sighting(captureId, {
      quoted: { available: false, postId: "1972000000000000000" },
    }),
  );

  expect(bookmark.quoted).toEqual({
    available: false,
    postId: "1972000000000000000",
  });
});

test("a later sighting that says less replaces what an earlier one said", () => {
  const store = openTempStore();
  const first = captureReceivedAt(store, monday);
  const second = captureReceivedAt(store, thursday);
  upsertBookmark(
    store,
    sighting(first, {
      lang: "en",
      likeCount: 4,
      sortIndex: "1861891119789912064",
    }),
  );

  const updated = upsertBookmark(store, sighting(second));

  expect(updated).toMatchObject({
    lang: null,
    likeCount: null,
    sortIndex: null,
    estimatedBookmarkedAt: null,
    firstSeenAt: monday,
  });
});

// The sort index and the times of the bookmark the research note works
// through: posted 06:30:15, synced 13:19:23, both on 2026-04-08 (UTC).
const SORT_INDEX = "1861891119789912064";
const posted = new Date("2026-04-08T06:30:15.000Z");
const synced = new Date("2026-04-08T13:19:23.000Z");

test("a bookmark time is estimated from the sort index, and stored apart from first-seen", () => {
  expect(estimateBookmarkedAt(SORT_INDEX, posted, synced)).toEqual(
    new Date("2026-04-08T08:42:20.888Z"),
  );
  const store = openTempStore();
  const captureId = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: synced,
  }).id;

  const bookmark = upsertBookmark(
    store,
    sighting(captureId, { postedAt: posted, sortIndex: SORT_INDEX }),
  );

  expect(bookmark).toMatchObject({
    sortIndex: SORT_INDEX,
    estimatedBookmarkedAt: new Date("2026-04-08T08:42:20.888Z"),
    firstSeenAt: synced,
    lastSeenAt: synced,
  });
});

test.each([
  ["before the post was written", new Date("2026-04-08T08:42:21.000Z"), synced],
  [
    "after the capture was received",
    posted,
    new Date("2026-04-08T08:30:00.000Z"),
  ],
])(
  "a sort index that would put the bookmark %s gives no estimate",
  (_, postedAt, receivedAt) => {
    expect(estimateBookmarkedAt(SORT_INDEX, postedAt, receivedAt)).toBeNull();
  },
);

test("the estimate allows for the browser's clock running a little behind X's", () => {
  const justBefore = new Date("2026-04-08T08:40:00.000Z");

  expect(estimateBookmarkedAt(SORT_INDEX, posted, justBefore)).toEqual(
    new Date("2026-04-08T08:42:20.888Z"),
  );
});

test.each(["", "not-a-number", "-5", "1".repeat(20)])(
  "a sort index of %j gives no estimate",
  (sortIndex) => {
    expect(estimateBookmarkedAt(sortIndex, posted, synced)).toBeNull();
  },
);

test("a sort index that is not a string of digits is rejected by the database", () => {
  const store = openTempStore();
  const captureId = captureReceivedAt(store, monday);

  expect(() =>
    upsertBookmark(store, sighting(captureId, { sortIndex: "18618 91" })),
  ).toThrow(/CHECK constraint failed/);
});
