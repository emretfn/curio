import { expect, test } from "vitest";
import {
  type BookmarkSighting,
  getBookmark,
  upsertBookmark,
} from "./bookmarks.ts";
import { correctBookmark, recordClassification } from "./labels.ts";
import {
  LONG_POST_CHARACTERS,
  listBookmarks,
  listWithheldPosts,
  MAX_PAGE_SIZE,
  searchBookmarks,
  summariseLibrary,
  summariseMatches,
} from "./library.ts";
import {
  listParseIssues,
  parseCapture,
  reparseAllCaptures,
} from "./parsing.ts";
import { insertRawCapture } from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";
import { summariseTagging } from "./tagging.ts";
import { readFixture } from "./testing/fixtures.ts";
import { openTempStore } from "./testing/temp-database.ts";
import { addTagAlias, retireTag } from "./vocabulary.ts";

const posted = new Date("2026-01-01T00:00:00.000Z");
const captured = new Date("2026-10-05T09:00:00.000Z");
const day = (n: number) => new Date(Date.UTC(2026, 5, n, 12));

/** A sort index that decodes to the given bookmark time. */
const sortIndexAt = (at: Date) => String(BigInt(at.getTime()) << 20n);

interface Library {
  store: Store;
  captureId: number;
  /** Adds a bookmark: `id` is a short number that becomes its post id. */
  add(id: number, content: Partial<BookmarkSighting>): string;
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
    captureId,
    add(id, content) {
      const postId = String(1975000000000000000n + BigInt(id));
      upsertBookmark(store, {
        postId,
        authorId: String(1000 + id),
        authorHandle: `author${id}`,
        authorName: `Author ${id}`,
        text: "",
        postedAt: posted,
        sortIndex: sortIndexAt(day(id)),
        captureId,
        ...content,
      });
      return postId;
    },
  };
}

const found = (store: Store, query: string, options = {}) =>
  searchBookmarks(store, { query, ...options }).hits.map(
    ({ bookmark }) => bookmark.postId,
  );

const media = {
  type: "photo" as const,
  imageUrl: "https://pbs.twimg.com/media/a.jpg",
  width: 1,
  height: 1,
  altText: null,
  videoUrl: null,
  durationMs: null,
};
const link = {
  url: "https://example.com/a",
  shortUrl: "https://t.co/a",
  displayUrl: "example.com/a",
};

test("a bookmark is found by its text, its author, its quoted post, its headlines and its descriptions", () => {
  const { store, add } = library();
  const byText = add(1, { text: "a note about hummingbirds" });
  const byHandle = add(2, { authorHandle: "hummingbird_fan" });
  const byName = add(3, { authorName: "Hummingbird Daily" });
  const byQuote = add(4, {
    quoted: {
      available: true,
      quotedPostId: null,
      postId: "1975000000000000900",
      authorId: "9",
      authorHandle: "someone",
      authorName: "Some One",
      authorAvatarUrl: null,
      authorVerified: false,
      text: "hummingbirds again",
      postedAt: posted,
      lang: "en",
      conversationId: null,
      inReplyToPostId: null,
      inReplyToHandle: null,
      media: [],
      links: [],
      card: null,
      article: null,
      likeCount: null,
      repostCount: null,
      replyCount: null,
      quoteCount: null,
      bookmarkCount: null,
      viewCount: null,
    },
  });
  const byCardTitle = add(5, {
    card: {
      name: "summary",
      url: "https://example.com/a",
      title: "The hummingbird guide",
      description: null,
      domain: null,
      imageUrl: null,
    },
  });
  const byArticle = add(6, {
    article: {
      id: "1",
      title: "Hummingbird migration",
      previewText: "",
      coverImageUrl: null,
    },
  });
  const byDescription = add(7, {
    card: {
      name: "summary",
      url: "https://example.com/b",
      title: null,
      description: "All about the hummingbird",
      domain: "example.com",
      imageUrl: null,
    },
  });
  const byAltText = add(8, {
    media: [{ ...media, altText: "a hummingbird at a feeder" }],
  });
  add(9, { text: "nothing of the kind" });
  add(10, { quoted: { available: false, postId: "1975000000000000901" } });

  expect(found(store, "hummingbird").toSorted()).toEqual(
    [
      byText,
      byHandle,
      byName,
      byQuote,
      byCardTitle,
      byArticle,
      byDescription,
      byAltText,
    ].toSorted(),
  );
  expect(found(store, "example.com")).toEqual([byDescription]);
});

test("Turkish is found however it is typed: case, accents and the dotless i make no difference", () => {
  const { store, add } = library();
  const lower = add(1, { text: "ışık hızında çalışma" });
  const upper = add(2, { text: "IŞIK HIZINDA ÇALIŞMA" });
  const ascii = add(3, { text: "isik hizinda calisma" });
  const city = add(4, { text: "İstanbul'da öğrenme günü" });
  const all = [lower, upper, ascii].toSorted();

  for (const query of ["ışık", "IŞIK", "isik", "Isik", "çalışma", "calisma"]) {
    expect(found(store, query).toSorted(), query).toEqual(all);
  }
  for (const query of [
    "istanbul",
    "İSTANBUL",
    "ıstanbul",
    "ogrenme",
    "ÖĞRENME",
  ]) {
    expect(found(store, query), query).toEqual([city]);
  }
});

test("a word also finds its longer forms, after the bookmarks that hold the word itself", () => {
  const { store, add } = library();
  const longer = add(1, { text: "kitaplarımdan biri" });
  const exact = add(2, { text: "bir kitap daha" });
  const apostrophe = add(3, { text: "Claude'un kitap listesi" });
  add(4, { text: "google it" });

  expect(found(store, "kitap")).toEqual([exact, apostrophe, longer]);
  expect(found(store, "claude")).toEqual([apostrophe]);
  // Too short to be a prefix: `go` is not `google`.
  expect(found(store, "go")).toEqual([]);
});

test("a phrase in quotes matches those words in that order, and nothing else", () => {
  const { store, add } = library();
  const phrase = add(1, { text: "an open source tool" });
  const apart = add(2, { text: "the source is open" });

  expect(found(store, '"open source"')).toEqual([phrase]);
  expect(found(store, "open source").toSorted()).toEqual(
    [phrase, apart].toSorted(),
  );
});

test("all words must match unless any is asked for, and then the bookmark holding more of them comes first", () => {
  const { store, add } = library();
  const both = add(1, { text: "vector databases and embeddings" });
  const one = add(2, { text: "embeddings only, with some other words" });
  add(3, { text: "neither" });

  expect(found(store, "vector embeddings")).toEqual([both]);
  expect(found(store, "vector embeddings", { match: "any" })).toEqual([
    both,
    one,
  ]);
});

test("where a word was found decides the order: the author and a headline before the text, the quoted post last", () => {
  const { store, add } = library();
  const filler = "one two three four five six seven eight nine ten";
  const inQuote = add(1, {
    text: filler,
    quoted: {
      available: true,
      quotedPostId: null,
      postId: "1975000000000000900",
      authorId: "9",
      authorHandle: "someone",
      authorName: "Some One",
      authorAvatarUrl: null,
      authorVerified: false,
      text: "zebra",
      postedAt: posted,
      lang: null,
      conversationId: null,
      inReplyToPostId: null,
      inReplyToHandle: null,
      media: [],
      links: [],
      card: null,
      article: null,
      likeCount: null,
      repostCount: null,
      replyCount: null,
      quoteCount: null,
      bookmarkCount: null,
      viewCount: null,
    },
  });
  const inText = add(2, { text: `${filler} zebra` });
  const inAuthor = add(3, { text: filler, authorName: "Zebra" });
  const inTitle = add(4, {
    text: filler,
    article: { id: "1", title: "Zebra", previewText: "", coverImageUrl: null },
  });

  expect(found(store, "zebra")).toEqual([inTitle, inAuthor, inText, inQuote]);
});

test("equal matches are ordered by bookmark time, the most recent first", () => {
  const { store, add } = library();
  const older = add(1, { text: "the same words" });
  const newer = add(2, { text: "the same words" });

  expect(found(store, "words")).toEqual([newer, older]);
});

test.each([
  '"',
  '""',
  "AND",
  "a AND",
  "NEAR(a b)",
  "text:",
  "a* -b (c",
  "^a + b",
  "{a b}",
])("the query %s is searched for as text, whatever it looks like", (query) => {
  const { store, add } = library();
  add(1, { text: "a b c and near" });

  expect(() => searchBookmarks(store, { query })).not.toThrow();
});

test("a query with nothing to search for finds nothing, and says it searched for nothing", () => {
  const { store, add } = library();
  add(1, { text: "anything" });

  expect(searchBookmarks(store, { query: " ?! " })).toEqual({
    total: 0,
    hits: [],
    terms: [],
  });
});

test("a hit carries the whole bookmark, and the part of a long text that matched", () => {
  const { store, add } = library();
  const postId = add(1, {
    text: `${"lorem ".repeat(200)}the ışık is here ${"ipsum ".repeat(200)}`,
  });

  const { hits, terms, total } = searchBookmarks(store, {
    query: "ISIK",
    excerptLength: 60,
  });

  expect(total).toBe(1);
  expect(terms).toEqual(["isik"]);
  expect(hits[0]?.bookmark).toMatchObject({ postId, bookmarkedAt: day(1) });
  expect(hits[0]?.excerpt).toMatch(/^…lorem .*the ışık is here .*ipsum…$/);
});

function filtered(): Library &
  Record<"plain" | "withMedia" | "withLink" | "turkish" | "removed", string> {
  const lib = library();
  const plain = lib.add(1, { text: "common words", lang: "en" });
  const withMedia = lib.add(2, {
    text: "common words",
    lang: "en",
    media: [media],
    authorHandle: "Shared_Author",
  });
  const withLink = lib.add(3, {
    text: "common words https://example.com/a",
    lang: "en",
    links: [link],
    authorHandle: "shared_author",
  });
  const turkish = lib.add(4, { text: "common words", lang: "tr" });
  const removed = lib.add(5, { text: "common words", lang: "en" });
  const removal = insertRawCapture(lib.store, {
    source: "x-web-client",
    operation: "DeleteBookmark",
    payload: readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json"),
    requestBody: JSON.stringify({ variables: { tweet_id: removed } }),
    receivedAt: new Date("2026-10-06T09:00:00.000Z"),
  });
  parseCapture(lib.store, removal.id);
  return { ...lib, plain, withMedia, withLink, turkish, removed };
}

test("a search and a list take the same filters", () => {
  const { store, plain, withMedia, withLink, turkish, removed } = filtered();
  const listed = (options = {}) =>
    listBookmarks(store, options).bookmarks.map(({ postId }) => postId);
  const cases: [object, string[]][] = [
    [{}, [turkish, withLink, withMedia, plain]],
    [{ includeRemoved: true }, [removed, turkish, withLink, withMedia, plain]],
    [{ author: "shared_author" }, [withLink, withMedia]],
    [{ author: "@SHARED_AUTHOR" }, [withLink, withMedia]],
    [{ author: "nobody" }, []],
    [{ hasMedia: true }, [withMedia]],
    [{ hasMedia: false }, [turkish, withLink, plain]],
    [{ hasLink: true }, [withLink]],
    [{ hasLink: false }, [turkish, withMedia, plain]],
    [{ lang: "tr" }, [turkish]],
    [{ lang: "EN", hasMedia: false, hasLink: false }, [plain]],
    [{ bookmarkedSince: day(3) }, [turkish, withLink]],
    [{ bookmarkedBefore: day(3) }, [withMedia, plain]],
    [
      { bookmarkedSince: day(2), bookmarkedBefore: day(4) },
      [withLink, withMedia],
    ],
    [{ bookmarkedSince: day(5), includeRemoved: true }, [removed]],
  ];

  for (const [filter, expected] of cases) {
    expect(listed(filter), JSON.stringify(filter)).toEqual(expected);
    // A search has an order of its own, by how well each bookmark matches.
    expect(
      found(store, "common", filter).toSorted(),
      JSON.stringify(filter),
    ).toEqual(expected.toSorted());
  }
});

test("a list is ordered by bookmark time, either way, and pages through all of it", () => {
  const { store, plain, withMedia, withLink, turkish } = filtered();
  const ids = (options: object) =>
    listBookmarks(store, options).bookmarks.map(({ postId }) => postId);

  expect(ids({ order: "oldest" })).toEqual([
    plain,
    withMedia,
    withLink,
    turkish,
  ]);
  expect(listBookmarks(store, { limit: 3 })).toMatchObject({ total: 4 });
  expect(ids({ limit: 3 })).toEqual([turkish, withLink, withMedia]);
  expect(ids({ limit: 3, offset: 3 })).toEqual([plain]);
  expect(ids({ limit: 3, offset: 6 })).toEqual([]);
  expect(listBookmarks(store).bookmarks[0]).toMatchObject({
    postId: turkish,
    bookmarkedAt: day(4),
    removedOnXAt: null,
  });
});

test("a list is read a page at a time by cursor, either way, and the pages together are the list", () => {
  const { store, add } = library();
  for (let id = 1; id <= 7; id++) add(id, {});
  // Two bookmarks made at the same moment keep one order between them.
  add(8, { sortIndex: sortIndexAt(day(3)) });
  const ids = (options: object) =>
    listBookmarks(store, { limit: MAX_PAGE_SIZE, ...options }).bookmarks.map(
      ({ postId }) => postId,
    );

  for (const order of ["newest", "oldest"] as const) {
    const paged: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = listBookmarks(store, { order, limit: 3, after });
      expect(page.total).toBe(8);
      paged.push(...page.bookmarks.map(({ postId }) => postId));
      after = page.nextCursor ?? undefined;
      pages += 1;
    } while (after !== undefined && pages < 10);

    expect(pages, order).toBe(3);
    expect(paged, order).toEqual(ids({ order }));
  }
  // A page that ends the list says so, also when it is exactly full.
  expect(listBookmarks(store, { limit: 8 }).nextCursor).toBeNull();
  expect(listBookmarks(openTempStore()).nextCursor).toBeNull();
});

test("a cursor keeps its place when bookmarks arrive between two pages, where an offset would repeat one", () => {
  const { store, add } = library();
  for (let id = 1; id <= 4; id++) add(id, {});
  const first = listBookmarks(store, { limit: 2 });
  const rest = listBookmarks(store, { after: first.nextCursor ?? "" });

  // Newer than everything listed so far.
  const arrived = add(9, {});

  const after = listBookmarks(store, { after: first.nextCursor ?? "" });
  expect(after.bookmarks).toEqual(rest.bookmarks);
  expect(after.total).toBe(5);
  expect(listBookmarks(store, { limit: 2, offset: 2 }).bookmarks[0]).toEqual(
    first.bookmarks[1],
  );
  expect(listBookmarks(store, { limit: 1 }).bookmarks[0]?.postId).toBe(arrived);
});

test("a cursor continues within the filter it is given with, and only a cursor a list returned is taken", () => {
  const { store, add } = library();
  const photos = [1, 2, 3, 4, 5].map((id) =>
    add(id, id % 2 === 1 ? { media: [media] } : {}),
  );
  const first = listBookmarks(store, { hasMedia: true, limit: 1 });

  expect(
    listBookmarks(store, {
      hasMedia: true,
      after: first.nextCursor ?? "",
    }).bookmarks.map(({ postId }) => postId),
  ).toEqual([photos[2], photos[0]]);
  for (const after of ["", "1", "1:", ":1", "a:b", "1:2:3", "-1:2", "1.5:2"]) {
    expect(() => listBookmarks(store, { after }), after).toThrow(RangeError);
  }
});

test("a search pages through its hits and reports how many there are in all", () => {
  const { store, add } = library();
  for (let id = 1; id <= 7; id++) add(id, { text: "the same words" });
  const page = (offset: number) =>
    searchBookmarks(store, { query: "words", limit: 3, offset });

  expect(page(0).total).toBe(7);
  expect(page(0).hits).toHaveLength(3);
  expect(page(6).hits).toHaveLength(1);
  expect(
    new Set(
      [0, 3, 6].flatMap((offset) =>
        page(offset).hits.map(({ bookmark }) => bookmark.postId),
      ),
    ).size,
  ).toBe(7);
});

test.each([
  { limit: 0 },
  { limit: MAX_PAGE_SIZE + 1 },
  { limit: 1.5 },
  { offset: -1 },
  { bookmarkedSince: new Date("not a date") },
])("a page that cannot be, %o, is refused and not guessed at", (options) => {
  const { store } = library();

  expect(() => listBookmarks(store, options)).toThrow(RangeError);
  expect(() => searchBookmarks(store, { query: "a", ...options })).toThrow(
    RangeError,
  );
});

test("the summary counts what is in the library, leaving out what was removed on X", () => {
  const { store, removed } = filtered();

  expect(summariseLibrary(store, { topAuthors: 2 })).toEqual({
    bookmarks: 4,
    removedOnX: 1,
    earliestBookmarkedAt: day(1),
    latestBookmarkedAt: day(4),
    withMedia: 1,
    withLinks: 1,
    authors: 4,
    topAuthors: [
      { handle: "author1", name: "Author 1", bookmarks: 1 },
      { handle: "author4", name: "Author 4", bookmarks: 1 },
    ],
    languages: [
      { lang: "en", bookmarks: 3 },
      { lang: "tr", bookmarks: 1 },
    ],
    categories: [{ category: null, bookmarks: 4 }],
    formats: [{ format: null, bookmarks: 4 }],
    tags: [],
    other: {
      bookmarks: 0,
      tooLittleText: 0,
      noneOfTheAbove: 0,
      share: 0,
      noneOfTheAboveShare: 0,
    },
  });
  expect(removed).toBeDefined();
});

test("an author is counted once under the name of the latest sighting", () => {
  const { store, add } = library();
  add(1, { authorId: "77", authorHandle: "old_name", authorName: "Old" });
  add(2, { authorId: "77", authorHandle: "old_name", authorName: "Old" });
  const later = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: new Date("2026-10-06T09:00:00.000Z"),
  }).id;
  upsertBookmark(store, {
    postId: "1975000000000000003",
    authorId: "77",
    authorHandle: "new_name",
    authorName: "New",
    text: "",
    postedAt: posted,
    captureId: later,
  });
  add(4, {});

  expect(summariseLibrary(store)).toMatchObject({
    authors: 2,
    topAuthors: [
      { handle: "new_name", name: "New", bookmarks: 3 },
      { handle: "author4", name: "Author 4", bookmarks: 1 },
    ],
  });
});

test("an empty library summarises to nothing", () => {
  expect(summariseLibrary(openTempStore())).toEqual({
    bookmarks: 0,
    removedOnX: 0,
    earliestBookmarkedAt: null,
    latestBookmarkedAt: null,
    withMedia: 0,
    withLinks: 0,
    authors: 0,
    topAuthors: [],
    languages: [],
    categories: [],
    formats: [],
    tags: [],
    other: {
      bookmarks: 0,
      tooLittleText: 0,
      noneOfTheAbove: 0,
      share: 0,
      noneOfTheAboveShare: 0,
    },
  });
});

/** The index as stored, and what the view says it should be. */
function indexAndView(store: Store): { index: unknown; view: unknown } {
  const db = connectionOf(store);
  db.exec(
    "INSERT INTO bookmark_search (bookmark_search) VALUES ('integrity-check')",
  );
  return {
    index: db
      .prepare(
        "SELECT rowid AS id, text, author, title, quoted, detail FROM bookmark_search ORDER BY rowid",
      )
      .all(),
    view: db.prepare("SELECT * FROM bookmark_search_text ORDER BY id").all(),
  };
}

test("a later sighting with other words replaces what the bookmark is found by", () => {
  const { store, add } = library();
  const postId = add(1, { text: "about walruses" });

  add(1, { text: "about narwhals", authorName: "Renamed" });

  expect(found(store, "walruses")).toEqual([]);
  expect(found(store, "narwhals")).toEqual([postId]);
  expect(found(store, "renamed")).toEqual([postId]);
  const { index, view } = indexAndView(store);
  expect(index).toEqual(view);
});

test("a sighting that says the same leaves the index untouched", () => {
  const { store, add } = library();
  add(1, { text: "about walruses", likeCount: 1 });
  const segments = () =>
    connectionOf(store).prepare("SELECT * FROM bookmark_search_data").all();
  const before = segments();

  add(1, { text: "about walruses", likeCount: 2 });

  expect(segments()).toEqual(before);
});

test("the index follows parsing and a full re-parse, and a second re-parse changes none of it", () => {
  const store = openTempStore();
  for (const [name, receivedAt] of [
    ["text-posts", "2026-10-05T09:00:00.000Z"],
    ["quoted-posts", "2026-10-06T09:00:00.000Z"],
    ["links-and-cards", "2026-10-07T09:00:00.000Z"],
    ["media", "2026-10-08T09:00:00.000Z"],
  ] as const) {
    const { id } = insertRawCapture(store, {
      source: "x-web-client",
      operation: "Bookmarks",
      payload: readFixture(`x-web-client/Bookmarks/2026-10-12-${name}.json`),
      receivedAt: new Date(receivedAt),
    });
    parseCapture(store, id);
  }
  const parsed = indexAndView(store);
  expect(parsed.index).toEqual(parsed.view);
  expect(parsed.index).toHaveLength(listBookmarks(store).total);
  const segments = () =>
    connectionOf(store).prepare("SELECT * FROM bookmark_search_data").all();

  reparseAllCaptures(store);
  const first = { ...indexAndView(store), segments: segments() };
  reparseAllCaptures(store);

  expect(first.index).toEqual(parsed.index);
  expect({ ...indexAndView(store), segments: segments() }).toEqual(first);
});

test("a bookmark parsed from a real-shaped page is found by its author's handle", () => {
  const store = openTempStore();
  const payload = readFixture(
    "x-web-client/Bookmarks/2026-10-12-text-posts.json",
  );
  const entry =
    JSON.parse(payload).data.bookmark_timeline_v2.timeline.instructions[0]
      .entries[0];
  const handle: string =
    entry.content.itemContent.tweet_results.result.core.user_results.result.core
      .screen_name;
  const { id } = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    receivedAt: captured,
  });
  parseCapture(store, id);

  expect(found(store, handle)).toContain(entry.entryId.slice(6));
  expect(found(store, "x", { author: handle, match: "any" })).toEqual([]);
  expect(
    listBookmarks(store, { author: handle }).bookmarks.map(
      ({ postId }) => postId,
    ),
  ).toContain(entry.entryId.slice(6));
});

const video = { ...media, type: "video" as const, durationMs: 1000 };
const article = {
  id: "1",
  title: "A headline",
  previewText: "",
  coverImageUrl: null,
};

/** One bookmark of each kind a filter can ask for, all holding the same words. */
function kinds(): Library &
  Record<
    | "plain"
    | "photo"
    | "clip"
    | "linked"
    | "withArticle"
    | "quoting"
    | "long"
    | "turkish"
    | "japanese"
    | "unnamed"
    | "lastYear"
    | "removed",
    string
  > {
  const lib = library();
  const words = "common words";
  const plain = lib.add(1, { text: words, lang: "en" });
  const photo = lib.add(2, { text: words, lang: "en", media: [media] });
  const clip = lib.add(3, { text: words, lang: "en", media: [media, video] });
  const linked = lib.add(4, { text: words, lang: "en", links: [link] });
  const withArticle = lib.add(5, { text: words, lang: "en", article });
  const quoting = lib.add(6, {
    text: words,
    lang: "en",
    quoted: { available: false, postId: "1975000000000000900" },
  });
  const long = lib.add(7, {
    text: `${words} ${"é".repeat(LONG_POST_CHARACTERS)}`,
    lang: "en",
  });
  const turkish = lib.add(8, { text: words, lang: "tr" });
  const japanese = lib.add(9, { text: words, lang: "ja" });
  const unnamed = lib.add(10, { text: words });
  const lastYear = lib.add(11, {
    text: words,
    lang: "en",
    postedAt: new Date("2024-01-01T00:00:00.000Z"),
    sortIndex: sortIndexAt(new Date(Date.UTC(2025, 5, 15, 12))),
  });
  const removed = lib.add(12, { text: words, lang: "tr", media: [media] });
  const removal = insertRawCapture(lib.store, {
    source: "x-web-client",
    operation: "DeleteBookmark",
    payload: readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json"),
    requestBody: JSON.stringify({ variables: { tweet_id: removed } }),
    receivedAt: new Date("2026-10-06T09:00:00.000Z"),
  });
  parseCapture(lib.store, removal.id);
  return {
    ...lib,
    plain,
    photo,
    clip,
    linked,
    withArticle,
    quoting,
    long,
    turkish,
    japanese,
    unnamed,
    lastYear,
    removed,
  };
}

test("a search and a list can ask for what a post has, for every language but some, and for the removed alone", () => {
  const all = kinds();
  const { store } = all;
  const listed = (options = {}) =>
    listBookmarks(store, options)
      .bookmarks.map(({ postId }) => postId)
      .toSorted();
  const rest = (...left: string[]) =>
    [
      all.plain,
      all.photo,
      all.clip,
      all.linked,
      all.withArticle,
      all.quoting,
      all.long,
      all.turkish,
      all.japanese,
      all.unnamed,
      all.lastYear,
    ]
      .filter((postId) => !left.includes(postId))
      .toSorted();
  const cases: [object, string[]][] = [
    [{ hasVideo: true }, [all.clip]],
    [{ hasVideo: false }, rest(all.clip)],
    [{ hasMedia: true, hasVideo: false }, [all.photo]],
    [{ hasArticle: true }, [all.withArticle]],
    [{ hasArticle: false }, rest(all.withArticle)],
    [{ hasQuote: true }, [all.quoting]],
    [{ hasQuote: false }, rest(all.quoting)],
    [{ isLong: true }, [all.long]],
    [{ isLong: false }, rest(all.long)],
    [{ langNot: ["en", "TR"] }, [all.japanese, all.unnamed].toSorted()],
    [{ langNot: [] }, rest()],
    [{ onlyRemoved: true }, [all.removed]],
    [{ onlyRemoved: true, includeRemoved: false }, [all.removed]],
    [{ onlyRemoved: true, lang: "en" }, []],
    [{ onlyRemoved: false }, rest()],
  ];

  for (const [filter, expected] of cases) {
    expect(listed(filter), JSON.stringify(filter)).toEqual(expected);
    expect(
      found(store, "common", { ...filter, limit: MAX_PAGE_SIZE }).toSorted(),
      JSON.stringify(filter),
    ).toEqual(expected);
  }
});

test("a post is long from one character past the limit, counted by character and not by byte", () => {
  const { store, add } = library();
  add(1, { text: "é".repeat(LONG_POST_CHARACTERS) });
  const over = add(2, { text: "é".repeat(LONG_POST_CHARACTERS + 1) });

  expect(
    listBookmarks(store, { isLong: true }).bookmarks.map(
      ({ postId }) => postId,
    ),
  ).toEqual([over]);
});

test("an author is found by the account's id under every handle it was seen with", () => {
  const { store, add } = library();
  const first = add(1, { authorId: "77", authorHandle: "old_name" });
  const second = add(2, { authorId: "77", authorHandle: "new_name" });
  add(3, { authorId: "78", authorHandle: "old_name" });

  expect(
    listBookmarks(store, { authorId: "77" }).bookmarks.map(
      ({ postId }) => postId,
    ),
  ).toEqual([second, first]);
  expect(listBookmarks(store, { authorId: "7" }).total).toBe(0);
  expect(found(store, "old_name", { authorId: "77" })).toEqual([first]);
});

test("the matches are counted, with what each further filter would leave of them", () => {
  const { store } = kinds();

  expect(summariseMatches(store)).toEqual({
    total: 11,
    withMedia: 2,
    withVideo: 1,
    withLinks: 1,
    withArticle: 1,
    withQuote: 1,
    long: 1,
    withheldOnX: 0,
    tooLittleText: 0,
    languages: [
      { lang: "en", bookmarks: 8 },
      { lang: null, bookmarks: 1 },
      { lang: "ja", bookmarks: 1 },
      { lang: "tr", bookmarks: 1 },
    ],
    years: [
      { year: 2026, bookmarks: 10 },
      { year: 2025, bookmarks: 1 },
    ],
    removedOnX: 1,
    categories: [{ category: null, bookmarks: 11 }],
    formats: [{ format: null, bookmarks: 11 }],
    tags: [],
  });
});

test("a count is taken within the other filters, and a group's own choice is set aside for that group alone", () => {
  const { store } = kinds();
  const open = summariseMatches(store, { hasMedia: true });

  expect(open).toMatchObject({ total: 2, withMedia: 2, withVideo: 1 });
  expect(open.languages).toEqual([{ lang: "en", bookmarks: 2 }]);
  // The removed bookmark has media too, and is counted only as removed.
  expect(open.removedOnX).toBe(1);

  // Choosing a language leaves the other languages' counts standing, and
  // narrows everything else.
  const turkish = summariseMatches(store, { lang: "tr" });
  expect(turkish.languages).toEqual(summariseMatches(store).languages);
  expect(turkish).toMatchObject({ total: 1, withMedia: 0, removedOnX: 1 });
  expect(summariseMatches(store, { langNot: ["en"] }).languages).toEqual(
    turkish.languages,
  );

  // Likewise a time range and the years.
  const lastYear = summariseMatches(store, {
    bookmarkedBefore: new Date(Date.UTC(2026, 0, 1, 12)),
  });
  expect(lastYear.total).toBe(1);
  expect(lastYear.years).toEqual(summariseMatches(store).years);
  expect(lastYear.languages).toEqual([{ lang: "en", bookmarks: 1 }]);

  // And the choice about removed bookmarks, for the count of the removed.
  expect(summariseMatches(store, { onlyRemoved: true })).toMatchObject({
    total: 1,
    withMedia: 1,
    removedOnX: 1,
  });
  expect(summariseMatches(store, { includeRemoved: true }).total).toBe(12);
});

test("the matches of a search are counted as the search finds them", () => {
  const { store, add, long } = kinds();
  const other = add(20, { text: "something else entirely", media: [video] });

  expect(summariseMatches(store, { query: "common" })).toMatchObject({
    total: 11,
    withVideo: 1,
    long: 1,
  });
  expect(summariseMatches(store, { query: "ENTİRELY" })).toMatchObject({
    total: 1,
    withMedia: 1,
    withVideo: 1,
    languages: [{ lang: null, bookmarks: 1 }],
  });
  expect(
    summariseMatches(store, { query: "common entirely", match: "any" }).total,
  ).toBe(12);
  for (const query of ["common", "entirely", "common entirely", "nothing"]) {
    expect(summariseMatches(store, { query }).total, query).toBe(
      searchBookmarks(store, { query }).total,
    );
  }
  expect(found(store, "common", { isLong: true })).toEqual([long]);
  expect(found(store, "entirely")).toEqual([other]);
});

test("a search with nothing to search for counts nothing, and an empty library counts to nothing", () => {
  const nothing = {
    total: 0,
    withMedia: 0,
    withVideo: 0,
    withLinks: 0,
    withArticle: 0,
    withQuote: 0,
    long: 0,
    withheldOnX: 0,
    tooLittleText: 0,
    languages: [],
    years: [],
    removedOnX: 0,
    categories: [],
    formats: [],
    tags: [],
  };

  expect(summariseMatches(kinds().store, { query: " ?! " })).toEqual(nothing);
  expect(summariseMatches(openTempStore())).toEqual(nothing);
  expect(() =>
    summariseMatches(kinds().store, { query: '" AND (' }),
  ).not.toThrow();
});

/** A real-shaped page with two posts X withholds, and the ids of those two. */
function withWithheldPosts(receivedAt: Date, store = openTempStore()) {
  const { id } = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: readFixture(
      "x-web-client/Bookmarks/2026-10-12-withheld-posts.json",
    ),
    receivedAt,
  });
  parseCapture(store, id);
  const withheld = listParseIssues(store, id)
    .filter((issue) => issue.kind === "post-unavailable")
    .map((issue) => issue.postId ?? "");
  expect(withheld).toHaveLength(2);
  return { store, withheld };
}

test("the posts X withholds are listed by id, with when a capture last found them so", () => {
  const { store, withheld } = withWithheldPosts(captured);

  const { total, posts } = listWithheldPosts(store);

  expect(total).toBe(2);
  expect(posts.map(({ postId }) => postId).toSorted()).toEqual(
    withheld.toSorted(),
  );
  for (const post of posts) {
    expect(post).toMatchObject({ withheldAt: captured, bookmarked: false });
    expect(getBookmark(store, post.postId)).toBeUndefined();
  }
  expect(listWithheldPosts(store, { limit: 1 })).toMatchObject({
    total: 2,
    posts: [posts[0]],
  });
  expect(listWithheldPosts(store, { limit: 1, offset: 1 }).posts).toEqual([
    posts[1],
  ]);
  expect(listWithheldPosts(openTempStore())).toEqual({ total: 0, posts: [] });
  expect(() => listWithheldPosts(store, { limit: 0 })).toThrow(RangeError);
  // None of them was ever held, so none is a bookmark that is withheld.
  expect(listWithheldPosts(store, { bookmarked: false })).toEqual({
    total,
    posts,
  });
  expect(listWithheldPosts(store, { bookmarked: true })).toEqual({
    total: 0,
    posts: [],
  });
  expect(listBookmarks(store, { onlyWithheld: true }).total).toBe(0);
});

test("a post withheld after the library captured it is listed as withheld and still held, until a capture holds it again", () => {
  const { store, captureId, add } = library();
  const later = new Date("2026-10-06T09:00:00.000Z");
  const [kept = ""] = withWithheldPosts(later, openTempStore()).withheld;
  // The library read the post from an earlier capture.
  upsertBookmark(store, {
    postId: kept,
    authorId: "1",
    authorHandle: "author",
    authorName: "Author",
    text: "what it said",
    postedAt: posted,
    captureId,
  });
  add(1, { text: "another bookmark" });

  withWithheldPosts(later, store);

  const held = listWithheldPosts(store).posts.find(
    ({ postId }) => postId === kept,
  );
  expect(held).toEqual({ postId: kept, withheldAt: later, bookmarked: true });
  expect(getBookmark(store, kept)?.text).toBe("what it said");
  expect(listWithheldPosts(store).total).toBe(2);
  expect(listWithheldPosts(store, { bookmarked: true })).toEqual({
    total: 1,
    posts: [held],
  });
  expect(
    listWithheldPosts(store, { bookmarked: false }).posts.map(
      ({ postId }) => postId,
    ),
  ).not.toContain(kept);

  // The bookmark says so itself, stays in every list, and can be asked for
  // alone; the count beside that filter is the same number.
  expect(getBookmark(store, kept)?.withheldOnXAt).toEqual(later);
  const all = listBookmarks(store);
  expect(all.bookmarks.map(({ postId }) => postId)).toContain(kept);
  const withheld = listBookmarks(store, { onlyWithheld: true });
  expect(withheld.bookmarks.map(({ postId }) => postId)).toEqual([kept]);
  expect(withheld.bookmarks[0]?.withheldOnXAt).toEqual(later);
  expect(found(store, "said", { onlyWithheld: true })).toEqual([kept]);
  expect(found(store, "another", { onlyWithheld: true })).toEqual([]);
  expect(summariseMatches(store)).toMatchObject({
    total: all.total,
    withheldOnX: 1,
  });
  expect(summariseMatches(store, { query: "another" }).withheldOnX).toBe(0);
  expect(summariseMatches(store, { onlyWithheld: true })).toMatchObject({
    total: 1,
    withheldOnX: 1,
  });
  expect(listBookmarks(store, { onlyWithheld: false }).total).toBe(all.total);

  // X sends the post again: it is a bookmark like any other.
  const again = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: new Date("2026-10-07T09:00:00.000Z"),
  }).id;
  upsertBookmark(store, {
    postId: kept,
    authorId: "1",
    authorHandle: "author",
    authorName: "Author",
    text: "what it says now",
    postedAt: posted,
    captureId: again,
  });

  expect(
    listWithheldPosts(store).posts.map(({ postId }) => postId),
  ).not.toContain(kept);
  expect(listWithheldPosts(store).total).toBe(1);
  expect(getBookmark(store, kept)?.withheldOnXAt).toBeNull();
  expect(listBookmarks(store, { onlyWithheld: true }).total).toBe(0);
  expect(summariseMatches(store).withheldOnX).toBe(0);
});

/** Six bookmarks filed by the classifier, one of them refiled by the owner, and a seventh filed under nothing. */
function labelled() {
  const base = library();
  const file = (
    id: number,
    text: string,
    category: string,
    format: string,
    tags: string[],
  ) => {
    const postId = base.add(id, { text, lang: id === 4 ? "tr" : "en" });
    recordClassification(base.store, {
      postId,
      category,
      format,
      tags,
      tooLittleText: false,
      instructionsVersion: 1,
      model: "a-model",
    });
    return postId;
  };
  const ids = {
    hooks: file(1, "a guide to hooks", "web-dev", "guide", ["react"]),
    routing: file(2, "routing in depth", "web-dev", "guide", [
      "react",
      "nextjs",
    ]),
    starter: file(3, "a new starter is out", "web-dev", "launch", ["nextjs"]),
    motion: file(4, "hareketli bir tasarım", "design", "showcase", [
      "animation",
    ]),
    gallery: file(5, "a gallery to browse", "design", "resource-list", []),
    pricing: file(6, "what the plans cost", "ai-agents", "discussion", [
      "ai-pricing",
    ]),
    unfiled: base.add(7, { text: "nobody has looked at this" }),
  };
  // The owner moves the gallery to web development and gives it a tag.
  correctBookmark(base.store, ids.gallery, {
    category: "web-dev",
    addTags: ["ui-components"],
  });
  return { ...base, ids };
}

const listed = (store: Store, options = {}) =>
  listBookmarks(store, options).bookmarks.map(({ postId }) => postId);

test("bookmarks are filtered by category, format and tags, all of which must hold", () => {
  const { store, ids } = labelled();

  expect(listed(store, { category: "web-dev" })).toEqual([
    ids.gallery,
    ids.starter,
    ids.routing,
    ids.hooks,
  ]);
  expect(listed(store, { category: "web-dev", format: "guide" })).toEqual([
    ids.routing,
    ids.hooks,
  ]);
  expect(listed(store, { tags: ["react"] })).toEqual([ids.routing, ids.hooks]);
  expect(listed(store, { tags: ["react", "nextjs"] })).toEqual([ids.routing]);
  expect(listed(store, { format: "launch", tags: ["react"] })).toEqual([]);
  expect(listed(store, { category: "design", lang: "tr" })).toEqual([
    ids.motion,
  ]);
});

test("a filter reads the owner's correction before the classifier's answer", () => {
  const { store, ids } = labelled();

  expect(listed(store, { category: "design" })).toEqual([ids.motion]);
  expect(listed(store, { tags: ["ui-components"] })).toEqual([ids.gallery]);

  correctBookmark(store, ids.hooks, { removeTags: ["react"] });

  expect(listed(store, { tags: ["react"] })).toEqual([ids.routing]);
});

test("a tag in a filter may be written any way the taxonomy or the owner knows it", () => {
  const { store, ids } = labelled();
  addTagAlias(store, "hareket", "animation");

  expect(listed(store, { tags: ["Next.js"] })).toEqual([
    ids.starter,
    ids.routing,
  ]);
  expect(listed(store, { tags: ["#NEXTJS", "next.js"] })).toEqual([
    ids.starter,
    ids.routing,
  ]);
  expect(listed(store, { tags: ["Hareket"] })).toEqual([ids.motion]);
});

test("the filed and the unfiled can each be asked for alone", () => {
  const { store, ids } = labelled();

  expect(listed(store, { classified: false })).toEqual([ids.unfiled]);
  expect(listBookmarks(store, { classified: true }).total).toBe(6);

  // Filed by the owner alone counts as filed.
  correctBookmark(store, ids.unfiled, { category: "life" });

  expect(listed(store, { classified: false })).toEqual([]);
  expect(listed(store, { category: "life" })).toEqual([ids.unfiled]);
});

test("a category, format or tag the taxonomy does not hold is refused, not read as nothing found", () => {
  const { store } = labelled();

  expect(() => listBookmarks(store, { category: "cooking" })).toThrow(
    /not a category. The categories are: ai-agents, /,
  );
  expect(() => listBookmarks(store, { format: "thread" })).toThrow(
    /not a format. The formats are: launch, /,
  );
  expect(() => listBookmarks(store, { tags: ["react", "rust"] })).toThrow(
    /"rust" is not a tag/,
  );
  expect(() =>
    searchBookmarks(store, { query: "guide", category: "cooking" }),
  ).toThrow(RangeError);
  expect(() => summariseMatches(store, { tags: ["rust"] })).toThrow(RangeError);
});

test("a retired tag is on no bookmark and in no count, and asking for it says it was retired", () => {
  const { store, ids } = labelled();

  retireTag(store, "react");

  expect(listed(store, { tags: ["nextjs"] })).toEqual([
    ids.starter,
    ids.routing,
  ]);
  expect(getBookmark(store, ids.routing)?.labels).toMatchObject({
    tags: ["nextjs"],
    classification: { tags: ["nextjs"] },
  });
  expect(summariseMatches(store).tags.map(({ tag }) => tag)).not.toContain(
    "react",
  );
  expect(summariseLibrary(store).tags.map(({ tag }) => tag)).not.toContain(
    "react",
  );
  expect(() => listBookmarks(store, { tags: ["react"] })).toThrow(
    /"react" is a tag that was retired/,
  );
});

test("a search is narrowed by the same filters", () => {
  const { store, ids } = labelled();

  expect(found(store, "guide routing", { match: "any" })).toHaveLength(2);
  expect(
    found(store, "guide routing", { match: "any", tags: ["nextjs"] }),
  ).toEqual([ids.routing]);
  expect(found(store, "starter", { category: "design" })).toEqual([]);
});

test("the matches are counted by category, format and tag", () => {
  const { store } = labelled();
  const all = summariseMatches(store);

  expect(all.categories).toEqual([
    { category: "web-dev", bookmarks: 4 },
    { category: null, bookmarks: 1 },
    { category: "ai-agents", bookmarks: 1 },
    { category: "design", bookmarks: 1 },
  ]);
  expect(all.formats).toEqual([
    { format: "guide", bookmarks: 2 },
    { format: null, bookmarks: 1 },
    { format: "discussion", bookmarks: 1 },
    { format: "launch", bookmarks: 1 },
    { format: "resource-list", bookmarks: 1 },
    { format: "showcase", bookmarks: 1 },
  ]);
  expect(all.tags).toEqual([
    { tag: "nextjs", bookmarks: 2 },
    { tag: "react", bookmarks: 2 },
    { tag: "ai-pricing", bookmarks: 1 },
    { tag: "animation", bookmarks: 1 },
    { tag: "ui-components", bookmarks: 1 },
  ]);
});

test("a chosen category leaves the other categories on offer, and narrows the formats and tags", () => {
  const { store } = labelled();
  const chosen = summariseMatches(store, { category: "web-dev" });

  expect(chosen.total).toBe(4);
  expect(chosen.categories).toEqual(summariseMatches(store).categories);
  expect(chosen.formats).toEqual([
    { format: "guide", bookmarks: 2 },
    { format: "launch", bookmarks: 1 },
    { format: "resource-list", bookmarks: 1 },
  ]);
  expect(chosen.tags).toEqual([
    { tag: "nextjs", bookmarks: 2 },
    { tag: "react", bookmarks: 2 },
    { tag: "ui-components", bookmarks: 1 },
  ]);

  // A chosen format does the same for formats, within the category.
  const guides = summariseMatches(store, {
    category: "web-dev",
    format: "guide",
  });
  expect(guides.formats).toEqual(chosen.formats);
  expect(guides.categories).toEqual([{ category: "web-dev", bookmarks: 2 }]);

  // A tag's count is what adding it would leave.
  expect(summariseMatches(store, { tags: ["react"] }).tags).toEqual([
    { tag: "react", bookmarks: 2 },
    { tag: "nextjs", bookmarks: 1 },
  ]);
  for (const { tag, bookmarks } of chosen.tags) {
    expect(
      listBookmarks(store, { category: "web-dev", tags: [tag] }).total,
      tag,
    ).toBe(bookmarks);
  }
});

test("the counts beside a search are taken among what it found", () => {
  const { store } = labelled();

  expect(
    summariseMatches(store, { query: "guide routing", match: "any" }),
  ).toMatchObject({
    total: 2,
    categories: [{ category: "web-dev", bookmarks: 2 }],
    formats: [{ format: "guide", bookmarks: 2 }],
    tags: [
      { tag: "react", bookmarks: 2 },
      { tag: "nextjs", bookmarks: 1 },
    ],
  });
});

test("the library's summary counts its categories, formats and tags, leaving out what was removed on X", () => {
  const { store, ids, captureId } = labelled();
  const removed = insertRawCapture(store, {
    source: "x-web-client",
    operation: "DeleteBookmark",
    payload: readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json"),
    requestBody: JSON.stringify({ variables: { tweet_id: ids.pricing } }),
    receivedAt: new Date("2026-10-06T09:00:00.000Z"),
  }).id;
  parseCapture(store, removed);
  const summary = summariseLibrary(store);

  expect(captureId).toBeLessThan(removed);
  expect(summary.removedOnX).toBe(1);
  expect(summary.categories).toEqual([
    { category: "web-dev", bookmarks: 4 },
    { category: null, bookmarks: 1 },
    { category: "design", bookmarks: 1 },
  ]);
  expect(summary.formats).toContainEqual({ format: "guide", bookmarks: 2 });
  expect(summary.formats).not.toContainEqual({
    format: "discussion",
    bookmarks: 1,
  });
  expect(summary.tags).toEqual([
    { tag: "nextjs", bookmarks: 2 },
    { tag: "react", bookmarks: 2 },
    { tag: "animation", bookmarks: 1 },
    { tag: "ui-components", bookmarks: 1 },
  ]);
});

/** A week's bookmarks under "other", of both kinds, with what the classifier proposed for some. */
function withOthers() {
  const base = library();
  const file = (
    id: number,
    category: string,
    parts: { tooLittleText?: boolean; proposedTags?: string[] } = {},
  ) => {
    const postId = base.add(id, { text: `post ${id}` });
    recordClassification(base.store, {
      postId,
      category,
      format: parts.tooLittleText ? "unclear" : "discussion",
      tags: [],
      proposedTags: parts.proposedTags ?? [],
      tooLittleText: parts.tooLittleText ?? false,
      instructionsVersion: 1,
      model: "a-model",
    });
    return postId;
  };
  const ids = {
    bareLink: file(1, "other", { tooLittleText: true }),
    fewWords: file(2, "other", { tooLittleText: true }),
    gardening: file(3, "other", { proposedTags: ["gardening"] }),
    cooking: file(4, "other", { proposedTags: ["Cooking", "gardening"] }),
    web: file(5, "web-dev", { proposedTags: ["drizzle"] }),
    design: file(6, "design"),
    // Filed for want of text by the classifier, and then filed by the owner.
    rescued: file(7, "other", { tooLittleText: true }),
    // Filed under other by the owner, over the classifier's category.
    demoted: file(8, "tools"),
  };
  correctBookmark(base.store, ids.rescued, { category: "life" });
  correctBookmark(base.store, ids.demoted, { category: "other" });
  return { ...base, ids };
}

test("the two reasons for other can each be listed alone, within a period like any other filter", () => {
  const { store, ids } = withOthers();

  expect(listed(store, { category: "other" })).toEqual([
    ids.demoted,
    ids.cooking,
    ids.gardening,
    ids.fewWords,
    ids.bareLink,
  ]);
  expect(listed(store, { category: "other", tooLittleText: true })).toEqual([
    ids.fewWords,
    ids.bareLink,
  ]);
  // Text enough, and no category that fits: what says a category is missing.
  expect(listed(store, { category: "other", tooLittleText: false })).toEqual([
    ids.demoted,
    ids.cooking,
    ids.gardening,
  ]);
  expect(
    listed(store, {
      category: "other",
      tooLittleText: false,
      bookmarkedSince: day(4),
      bookmarkedBefore: day(8),
    }),
  ).toEqual([ids.cooking]);
  // A bookmark the owner filed is no longer there for want of text, wherever it went.
  expect(listed(store, { tooLittleText: true })).not.toContain(ids.rescued);
  expect(listBookmarks(store, { tooLittleText: false }).total).toBe(6);
});

test("the bookmarks a tag was proposed for are listed by the proposal, however it is written", () => {
  const { store, ids } = withOthers();

  expect(listed(store, { proposedTag: "gardening" })).toEqual([
    ids.cooking,
    ids.gardening,
  ]);
  expect(listed(store, { proposedTag: "#Cooking" })).toEqual([ids.cooking]);
  expect(listed(store, { proposedTag: "drizzle", category: "other" })).toEqual(
    [],
  );
  expect(listed(store, { proposedTag: "nothing-proposed-this" })).toEqual([]);
  // A proposal is on no bookmark as a tag.
  expect(
    listBookmarks(store, { classified: true }).bookmarks.flatMap(
      ({ labels }) => labels.tags,
    ),
  ).toEqual([]);
});

test("the matches and the library both count other by its two reasons", () => {
  const { store } = withOthers();
  const week = summariseMatches(store, {
    bookmarkedSince: day(2),
    bookmarkedBefore: day(6),
  });
  const all = summariseLibrary(store);

  expect(summariseMatches(store).tooLittleText).toBe(2);
  expect(week.tooLittleText).toBe(1);
  expect(week.categories).toContainEqual({ category: "other", bookmarks: 3 });
  expect(all.other).toEqual({
    bookmarks: 5,
    tooLittleText: 2,
    noneOfTheAbove: 3,
    share: 5 / 8,
    noneOfTheAboveShare: 3 / 8,
  });
  // The same numbers the classifier's own summary reports.
  expect(summariseTagging(store).other).toEqual(all.other);
});
