import {
  type Bookmark,
  getBookmark,
  getDigest,
  getRawCapture,
  isXOwnedHost,
  listBookmarks,
  listParseIssues,
  listRawCaptureIds,
  listTagProposals,
  listTags,
  listWithheldPosts,
  MAX_PAGE_SIZE,
  type Store,
  searchBookmarks,
  summariseLibrary,
  summariseParsing,
  summariseTagging,
  TAXONOMY,
  X_OWNED_DOMAINS,
} from "@curio/core";
import { openTempStore } from "@curio/core/testing";
import { expect, test } from "vitest";
import { AUTHORS } from "./authors.ts";
import { DIGEST } from "./digest.ts";
import { buildDemoLibrary, OWNER_TAGS, WEEKS_COVERED } from "./library.ts";
import { POSTS } from "./posts/index.ts";

/** A Wednesday afternoon, so that the digest's week is whole and three days are past it. */
const NOW = new Date(2026, 9, 14, 15, 30);
const DAY = 24 * 60 * 60 * 1000;

function build(now = NOW) {
  const store = openTempStore();
  return { store, demo: buildDemoLibrary(store, { now }) };
}

function everyBookmark(store: Store): Bookmark[] {
  const bookmarks: Bookmark[] = [];
  let after: string | undefined;
  do {
    const page = listBookmarks(store, {
      limit: MAX_PAGE_SIZE,
      after,
      includeRemoved: true,
    });
    bookmarks.push(...page.bookmarks);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined);
  return bookmarks;
}

/** One of X's domains, or a subdomain of one, standing as a host in a text. */
const X_HOST = new RegExp(
  `(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*(?:${X_OWNED_DOMAINS.map((domain) => domain.replace(".", "\\.")).join("|")})(?![A-Za-z0-9-])`,
  "i",
);

test("the demo builds: every post becomes a bookmark, and the parser understood all of it", () => {
  const { store, demo } = build();
  const parsing = summariseParsing(store);

  expect(demo.bookmarks).toBe(POSTS.length);
  expect(POSTS.length).toBeGreaterThanOrEqual(200);
  expect(everyBookmark(store)).toHaveLength(POSTS.length);
  expect(parsing.captures).toMatchObject({
    failed: 0,
    noParser: 0,
    pending: 0,
    outdated: 0,
  });
  expect(parsing.failedEntries).toBe(0);
  expect(parsing.warnings).toBe(0);
  expect(parsing.unavailableEntries).toBe(demo.neverHeld + 1);
  // What the parser reported is the posts X withholds, and nothing else.
  expect(
    listParseIssues(store).filter(({ kind }) => kind !== "post-unavailable"),
  ).toEqual([]);
});

test("nothing is left unclassified, and nothing waits on the classifier", () => {
  const { store } = build();
  const tagging = summariseTagging(store);

  expect(tagging.bookmarks).toBe(POSTS.length);
  expect(tagging.unclassified).toBe(0);
  expect(tagging.failed).toBe(0);
  expect(tagging.outdated).toBe(0);
  expect(tagging.behindVocabulary).toBe(0);
  // No run of the classifier is on record, and nothing was spent.
  expect(tagging.lastRun).toBeNull();
  expect(tagging.spentUsd).toBe(0);
  for (const bookmark of everyBookmark(store)) {
    expect(bookmark.labels.category, bookmark.postId).not.toBeNull();
    expect(bookmark.labels.format, bookmark.postId).not.toBeNull();
  }
});

test("no capture and no bookmark names a host X owns", () => {
  const { store } = build();
  const captures = listRawCaptureIds(store).map((id) =>
    getRawCapture(store, id),
  );

  expect(captures.length).toBeGreaterThan(10);
  for (const capture of captures) {
    expect(capture?.requestUrl).toBeNull();
    expect(X_HOST.test(capture?.payload ?? "")).toBe(false);
    expect(X_HOST.test(capture?.requestBody ?? "")).toBe(false);
  }
  const stored = JSON.stringify(everyBookmark(store));
  expect(X_HOST.test(stored)).toBe(false);
  // Every address in the library, wherever it is, is on a reserved name.
  const hosts = new Set(
    [...stored.matchAll(/https?:\/\/[^\s"\\]+/g)].map(
      ([url]) => new URL(url).hostname,
    ),
  );
  expect(hosts.size).toBeGreaterThan(10);
  for (const host of hosts) {
    expect(isXOwnedHost(host), host).toBe(false);
    expect(host, host).toMatch(/\.(example|invalid)$/);
  }
});

test("no source of the demo's posts names a host X owns either", () => {
  for (const { text, quote, card, article } of POSTS) {
    for (const written of [
      text,
      quote?.text,
      card?.title,
      card?.description,
      article?.title,
      article?.preview,
    ]) {
      expect(X_HOST.test(written ?? ""), written).toBe(false);
    }
  }
  expect(X_HOST.test(JSON.stringify(DIGEST))).toBe(false);
});

test("every handle is longer than X allows one to be, and no author goes by a full name", () => {
  const authors = Object.values(AUTHORS);

  expect(new Set(authors.map(({ handle }) => handle)).size).toBe(
    authors.length,
  );
  for (const { handle } of authors) {
    expect(handle, handle).toMatch(/^[a-z0-9_]{16,}$/);
  }
  const { store } = build();
  for (const bookmark of everyBookmark(store)) {
    // Twenty digits from nine up: more than the 64 bits of an id of X's hold.
    expect(BigInt(bookmark.postId) > 2n ** 64n, bookmark.postId).toBe(true);
    expect(BigInt(bookmark.authorId) > 2n ** 63n, bookmark.authorId).toBe(true);
  }
});

test("the library covers the taxonomy: every category and format, both kinds of other, tags and proposals", () => {
  const { store } = build();
  const summary = summariseLibrary(store);
  const tagging = summariseTagging(store);

  expect(summary.categories.map(({ category }) => category).toSorted()).toEqual(
    TAXONOMY.categories.map(({ id }) => id).toSorted(),
  );
  expect(summary.formats.map(({ format }) => format).toSorted()).toEqual(
    TAXONOMY.formats.map(({ id }) => id).toSorted(),
  );
  for (const { bookmarks } of summary.categories) {
    expect(bookmarks).toBeGreaterThanOrEqual(10);
  }
  expect(summary.other.tooLittleText).toBeGreaterThanOrEqual(5);
  expect(summary.other.noneOfTheAbove).toBeGreaterThanOrEqual(5);
  expect(summary.tags.length).toBeGreaterThanOrEqual(25);
  expect(summary.authors).toBe(Object.keys(AUTHORS).length);
  expect(summary.languages.map(({ lang }) => lang)).toContain("tr");
  expect(summary.withMedia).toBeGreaterThanOrEqual(15);
  expect(summary.withLinks).toBeGreaterThanOrEqual(25);

  // The tags the owner added are in use, and proposals wait to be decided.
  const inUse = new Map(listTags(store).map((tag) => [tag.tag, tag]));
  for (const tag of OWNER_TAGS) {
    expect(inUse.get(tag)?.bookmarks, tag).toBeGreaterThan(0);
  }
  const proposals = listTagProposals(store, { minBookmarks: 2 });
  expect(proposals.total).toBeGreaterThanOrEqual(6);
  expect(proposals.belowThreshold).toBeGreaterThanOrEqual(5);
  // One subject under two spellings is one entry, and one resembles a tag.
  expect(proposals.proposals.some(({ variants }) => variants.length > 1)).toBe(
    true,
  );
  expect(
    proposals.proposals.some(({ similarTags }) => similarTags.length > 0),
  ).toBe(true);
  expect(tagging.corrected).toBe(3);
});

test("the bookmarks are spread over the months before now, newest minutes ago", () => {
  const { store, demo } = build();
  const summary = summariseLibrary(store);
  const earliest = summary.earliestBookmarkedAt?.getTime() ?? 0;
  const latest = summary.latestBookmarkedAt?.getTime() ?? 0;

  expect(latest).toBeLessThan(NOW.getTime());
  expect(NOW.getTime() - latest).toBeLessThan(DAY);
  expect(earliest).toBeGreaterThan(
    demo.digestWeek.start.getTime() - (WEEKS_COVERED * 7 + 1) * DAY,
  );
  expect(NOW.getTime() - earliest).toBeGreaterThan(20 * 7 * DAY);
  // Every bookmark has a time of its own, read from the timeline, and none
  // falls back on the day it was captured.
  for (const bookmark of everyBookmark(store)) {
    expect(bookmark.estimatedBookmarkedAt, bookmark.postId).not.toBeNull();
    expect(bookmark.postedAt.getTime()).toBeLessThan(
      bookmark.bookmarkedAt.getTime(),
    );
  }
  const months = new Set(
    everyBookmark(store).map(
      ({ bookmarkedAt }) =>
        `${bookmarkedAt.getFullYear()}-${bookmarkedAt.getMonth()}`,
    ),
  );
  expect(months.size).toBeGreaterThanOrEqual(6);
});

test("one bookmark is removed on X, one is withheld with its copy kept, one has an exact time, and two were never held", () => {
  const { store, demo } = build();
  const removed = getBookmark(store, demo.keyed["removed-on-x"] ?? "");
  const kept = getBookmark(store, demo.keyed["kept-copy"] ?? "");
  const observed = getBookmark(store, demo.keyed.observed ?? "");

  expect(removed?.removedOnXAt).not.toBeNull();
  expect(summariseLibrary(store).removedOnX).toBe(1);
  expect(kept?.withheldOnXAt).not.toBeNull();
  expect(kept?.text).toMatch(/recurring revenue/);
  expect(observed?.observedBookmarkedAt).not.toBeNull();
  const withheld = listWithheldPosts(store);
  expect(withheld.total).toBe(demo.neverHeld + 1);
});

test("the week that last ended holds a written digest, plainly a sample, that points at posts of that week", () => {
  const { store, demo } = build();
  const digest = getDigest(store, demo.digestWeek.key);
  const inWeek = new Set(
    listBookmarks(store, {
      bookmarkedSince: demo.digestWeek.start,
      bookmarkedBefore: demo.digestWeek.end,
      limit: MAX_PAGE_SIZE,
    }).bookmarks.map(({ postId }) => postId),
  );

  expect(digest).toBeDefined();
  expect(digest?.text.overview).toMatch(/^This is a sample summary/);
  expect(digest?.text.overview).toMatch(/No model was called/);
  expect(digest?.model).toMatch(/no API call/);
  expect(digest?.costUsd).toBe(0);
  expect(digest?.postIds.length).toBe(inWeek.size);
  expect(inWeek.size).toBeGreaterThanOrEqual(10);
  const named = [
    ...(digest?.text.themes.flatMap(({ postIds }) => postIds) ?? []),
    ...(digest?.text.worthRevisiting.map(({ postId }) => postId) ?? []),
  ];
  expect(named.length).toBeGreaterThanOrEqual(10);
  for (const postId of named) expect(inWeek.has(postId), postId).toBe(true);
  // What was stored is what was written: nothing in it read as an address.
  expect(digest?.text.themes.map(({ title }) => title)).toEqual(
    DIGEST.themes.map(({ title }) => title),
  );
  expect(digest?.text.overview).toBe(DIGEST.overview);
});

test("a search typed without Turkish letters finds the posts written with them", () => {
  const { store } = build();
  const found = searchBookmarks(store, { query: "kisayol" });

  expect(found.total).toBeGreaterThanOrEqual(3);
  const texts = found.hits.map(({ bookmark }) => bookmark.text).join("\n");
  expect(texts).toMatch(/kısayol/);
  expect(texts).toMatch(/KISAYOL/);
});

test.each([
  ["a Monday just after midnight", new Date(2026, 9, 12, 0, 20)],
  [
    "a Sunday evening, when the week is still running",
    new Date(2026, 9, 11, 21, 0),
  ],
  ["a Sunday afternoon", new Date(2026, 9, 11, 14, 0)],
  ["the day the clocks go back", new Date(2026, 9, 25, 3, 30)],
])("it builds whole on %s", (_, now) => {
  const { store, demo } = build(now);
  const tagging = summariseTagging(store);

  expect(tagging.bookmarks).toBe(POSTS.length);
  expect(tagging.unclassified).toBe(0);
  expect(summariseParsing(store).warnings).toBe(0);
  expect(getDigest(store, demo.digestWeek.key)).toBeDefined();
  for (const bookmark of everyBookmark(store)) {
    expect(bookmark.estimatedBookmarkedAt, bookmark.postId).not.toBeNull();
    expect(bookmark.bookmarkedAt.getTime()).toBeLessThan(now.getTime());
  }
});

test("it refuses a library that already holds something, and so can never be built over a real one", () => {
  const { store } = build();

  expect(() => buildDemoLibrary(store, { now: NOW })).toThrow(
    /empty library of its own/,
  );
});

test("two builds at one moment are the same library", () => {
  const first = build();
  const second = build();

  expect(first.demo).toEqual(second.demo);
  expect(JSON.stringify(everyBookmark(first.store))).toBe(
    JSON.stringify(everyBookmark(second.store)),
  );
});
