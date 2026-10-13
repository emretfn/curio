import {
  type Bookmark,
  LONG_POST_CHARACTERS,
  listBookmarks,
  listParseIssues,
  MAX_PAGE_SIZE,
  markMatches,
  parsePendingCaptures,
  searchBookmarks,
  summariseLibrary,
  summariseParsing,
  upsertBookmark,
} from "@curio/core";
import { openTempStore, readFixture } from "@curio/core/testing";
import { expect, test } from "vitest";
import {
  getLibraryFacets,
  getLibraryStatus,
  LIBRARY_LANGUAGES,
  type LibraryBookmark,
  type LibraryItem,
  type LibraryQuery,
  labelChoices,
  listLibrary,
  NOT_CLASSIFIED,
  POST_FEATURES,
  type PostFeature,
  readTags,
} from "./library.ts";
import {
  BACKUPS_WELL,
  bookmarksFixture,
  commonWord,
  openFiledLibrary,
  openFixtureLibrary,
  storeCapture,
} from "./library-testing.ts";

function bookmarksOf(items: LibraryItem[]): Bookmark[] {
  return items
    .filter((item): item is LibraryBookmark => item.kind === "bookmark")
    .map((item) => item.bookmark);
}

const idsOf = (items: LibraryItem[]) =>
  items.map((item) =>
    item.kind === "bookmark" ? item.bookmark.postId : item.postId,
  );

/** Every item a query matches, read a page at a time as the screen reads it. */
function everything(
  store: ReturnType<typeof openTempStore>,
  query: LibraryQuery = {},
  limit = MAX_PAGE_SIZE,
) {
  const items: LibraryItem[] = [];
  let after: string | null = null;
  let total = 0;
  let pages = 0;
  do {
    const page = listLibrary(store, query, { after, limit });
    items.push(...page.items);
    total = page.total;
    after = page.nextCursor;
    pages += 1;
  } while (after !== null && pages < 500);
  return { items, total, pages, bookmarks: bookmarksOf(items) };
}

function everyBookmark(store = openFixtureLibrary()) {
  return { store, ...everything(store) };
}

/** What each feature means, written again here from the bookmark alone. */
const HAS: Record<PostFeature, (bookmark: Bookmark) => boolean> = {
  media: (bookmark) => bookmark.media.length > 0,
  video: (bookmark) => bookmark.media.some((media) => media.type !== "photo"),
  link: (bookmark) => bookmark.links.length > 0,
  article: (bookmark) => bookmark.article !== null,
  quote: (bookmark) => bookmark.quoted !== null,
  long: (bookmark) => [...bookmark.text].length > LONG_POST_CHARACTERS,
};

test("an empty library lists nothing, counts nothing and reports nothing wrong", () => {
  const store = openTempStore();

  expect(listLibrary(store)).toEqual({
    items: [],
    nextCursor: null,
    total: 0,
    terms: [],
  });
  const facets = getLibraryFacets(store);
  expect(facets.total).toBe(0);
  expect(facets.librarySize).toBe(0);
  expect(facets.savedYears).toEqual([]);
  expect(getLibraryStatus(store, BACKUPS_WELL)).toMatchObject({
    level: "ok",
    captures: { count: 0, lastReceivedAt: null },
  });
});

test("every bookmark core holds is listed, once, most recently bookmarked first, as core lists them", () => {
  const { store, total, bookmarks } = everyBookmark();

  expect(total).toBe(summariseParsing(store).bookmarks);
  expect(bookmarks).toHaveLength(total);
  expect(new Set(bookmarks.map((bookmark) => bookmark.postId)).size).toBe(
    total,
  );
  const saved = bookmarks.map((bookmark) => bookmark.bookmarkedAt.getTime());
  expect(saved).toEqual([...saved].sort((a, b) => b - a));
  expect(bookmarks.slice(0, 20)).toEqual(
    listBookmarks(store, { limit: 20 }).bookmarks,
  );
});

test("pages follow one another by cursor and together are the whole list", () => {
  const { store, items: whole, total } = everyBookmark();

  const paged = everything(store, {}, 7);

  expect(paged.total).toBe(total);
  expect(paged.pages).toBe(Math.ceil(total / 7));
  expect(idsOf(paged.items)).toEqual(idsOf(whole));
});

test("a cursor from before the list grew still continues from the same place", () => {
  const store = openTempStore();
  storeCapture(store, bookmarksFixture("text-posts"));
  parsePendingCaptures(store);
  const first = listLibrary(store, {}, { limit: 2 });
  const rest = listLibrary(store, {}, { after: first.nextCursor });

  storeCapture(store, bookmarksFixture("media"));
  parsePendingCaptures(store);

  const after = idsOf(
    listLibrary(store, {}, { after: first.nextCursor, limit: MAX_PAGE_SIZE })
      .items,
  );
  for (const postId of idsOf(rest.items)) expect(after).toContain(postId);
  for (const postId of idsOf(first.items)) expect(after).not.toContain(postId);
});

test("a new capture shows up in the list without a restart", () => {
  const store = openTempStore();
  storeCapture(store, bookmarksFixture("text-posts"));
  parsePendingCaptures(store);
  const before = listLibrary(store).total;

  storeCapture(store, bookmarksFixture("media"));
  parsePendingCaptures(store);

  expect(listLibrary(store).total).toBe(summariseParsing(store).bookmarks);
  expect(listLibrary(store).total).toBeGreaterThan(before);
});

/** A word of the fixtures' invented text that the fewest posts hold, and those posts. */
function rareWord(bookmarks: Bookmark[]): [string, Set<string>] {
  const holders = new Map<string, Set<string>>();
  for (const bookmark of bookmarks) {
    for (const [word] of bookmark.text
      .toLowerCase()
      .matchAll(/\b[a-z]{6,}\b/g)) {
      holders.set(word, (holders.get(word) ?? new Set()).add(bookmark.postId));
    }
  }
  const [rarest] = [...holders].sort(([, a], [, b]) => a.size - b.size);
  if (rarest === undefined) throw new Error("The fixtures hold no long word.");
  return rarest;
}

test("the screen's search is core's search: the same bookmarks, in the same order, for the same terms", () => {
  const { store, bookmarks } = everyBookmark();
  const [word] = rareWord(bookmarks);
  const [author] = bookmarks;

  for (const text of [
    word,
    word.toUpperCase(),
    `${word.slice(0, 4)} @${author?.authorHandle}`,
    `"${word}"`,
    commonWord(store),
  ]) {
    const found = searchBookmarks(store, { query: text, limit: MAX_PAGE_SIZE });
    const page = listLibrary(store, { text }, { limit: MAX_PAGE_SIZE });

    expect(bookmarksOf(page.items), text).toEqual(
      found.hits.map(({ bookmark }) => bookmark),
    );
    expect(page.total, text).toBe(found.total);
    expect(page.terms, text).toEqual(found.terms);
    expect(getLibraryFacets(store, { text }).total, text).toBe(found.total);
  }
});

test("search finds a word whatever its case, in every post whose text holds it and in no post that lacks it", () => {
  const { store, bookmarks } = everyBookmark();
  const [word, inText] = rareWord(bookmarks);

  const { bookmarks: found, total } = everything(store, {
    text: word.toUpperCase(),
  });

  expect(total).toBe(found.length);
  for (const postId of inText) {
    expect(found.map((bookmark) => bookmark.postId)).toContain(postId);
  }
  for (const bookmark of found) {
    expect(
      markMatches(JSON.stringify(bookmark), [word]).some(
        (piece) => piece.marked,
      ),
    ).toBe(true);
  }
  expect(listLibrary(store, { text: "zzqqxxnothingholdsthis" }).total).toBe(0);
});

test("a search is paged by position, and its pages together are every match", () => {
  const { store } = everyBookmark();
  const text = commonWord(store);
  const whole = everything(store, { text });
  expect(whole.total).toBeGreaterThan(6);

  const paged = everything(store, { text }, 3);

  expect(paged.pages).toBe(Math.ceil(whole.total / 3));
  expect(idsOf(paged.items)).toEqual(idsOf(whole.items));
  expect(listLibrary(store, { text }, { limit: 3 }).nextCursor).toBe("s:3");
});

test("a search with nothing in it to look for finds nothing, as it does everywhere", () => {
  const { store } = everyBookmark();

  expect(listLibrary(store, { text: "?!" })).toEqual({
    items: [],
    nextCursor: null,
    total: 0,
    terms: [],
  });
  expect(getLibraryFacets(store, { text: "?!" }).total).toBe(0);
  // Spaces alone are no search at all.
  expect(listLibrary(store, { text: "   " }).total).toBe(
    listLibrary(store).total,
  );
});

test("a search narrows the list: one author's handle does not match the whole library", () => {
  const { store, bookmarks } = everyBookmark();
  const [bookmark] = bookmarks;
  if (bookmark === undefined) throw new Error("The fixtures hold no bookmark.");

  const page = listLibrary(store, { text: `@${bookmark.authorHandle}` });

  expect(page.total).toBeGreaterThan(0);
  expect(page.total).toBeLessThan(bookmarks.length);
});

test("search finds a post by its author's handle and by the post it quotes", () => {
  const { store, bookmarks } = everyBookmark();
  const quoting = bookmarks.find((bookmark) => bookmark.quoted?.available);
  const quoted = quoting?.quoted;
  if (quoting === undefined || !quoted?.available) {
    throw new Error("The fixtures hold no quoted post.");
  }

  const byAuthor = everything(store, { text: `@${quoting.authorHandle}` });
  expect(idsOf(byAuthor.items)).toContain(quoting.postId);

  const byQuotedAuthor = everything(store, {
    text: `@${quoted.authorHandle}`,
  });
  expect(idsOf(byQuotedAuthor.items)).toContain(quoting.postId);
});

test("every word of a search has to match, and a phrase in quotes matches as a whole", () => {
  const { store, bookmarks } = everyBookmark();
  const source = bookmarks.find((bookmark) =>
    /\p{L}{4,} \p{L}{4,}/u.test(bookmark.text),
  );
  const [phrase = ""] = /\p{L}{4,} \p{L}{4,}/u.exec(source?.text ?? "") ?? [];
  const [first = "", second = ""] = phrase.split(" ");
  expect(second).not.toBe("");
  const count = (text: string) => listLibrary(store, { text }).total;

  expect(count(`${first} ${second}`)).toBeGreaterThan(0);
  expect(count(`"${phrase}"`)).toBeGreaterThan(0);
  expect(count(`"${phrase}"`)).toBeLessThanOrEqual(count(`${first} ${second}`));
  expect(count(`${first} zzqqxxnothingholdsthis`)).toBe(0);
  expect(count(`"${second} ${first} zzqq"`)).toBe(0);
});

test.each(POST_FEATURES)(
  "the %s filter lists exactly the posts that have it",
  (feature) => {
    const { store, bookmarks } = everyBookmark();
    const expected = bookmarks.filter(HAS[feature]);

    const page = everything(store, { features: [feature] });

    expect(idsOf(page.items)).toEqual(
      expected.map((bookmark) => bookmark.postId),
    );
    expect(page.total).toBe(expected.length);
    expect(getLibraryFacets(store).features[feature]).toBe(expected.length);
  },
);

test("the fixtures exercise every feature filter", () => {
  const { store } = everyBookmark();
  const { features } = getLibraryFacets(store);

  for (const feature of POST_FEATURES) {
    // The fixtures hold no X Article. That filter is covered by its
    // definition above, on an empty set, and by core's own tests.
    if (feature === "article") continue;
    expect(features[feature], feature).toBeGreaterThan(0);
  }
});

test("features combine: a post has to have every one asked for", () => {
  const { store, bookmarks } = everyBookmark();

  const both = everything(store, { features: ["media", "link"] });

  expect(idsOf(both.items)).toEqual(
    bookmarks
      .filter((bookmark) => HAS.media(bookmark) && HAS.link(bookmark))
      .map((bookmark) => bookmark.postId),
  );
});

test("the language filter splits the library into English, Turkish and the rest", () => {
  const { store, bookmarks } = everyBookmark();
  const languageOf = (bookmark: Bookmark) =>
    bookmark.lang === "en" || bookmark.lang === "tr" ? bookmark.lang : "other";
  const facets = getLibraryFacets(store);

  let sum = 0;
  for (const language of LIBRARY_LANGUAGES) {
    const page = everything(store, { language });
    expect(page.bookmarks.every((b) => languageOf(b) === language)).toBe(true);
    expect(page.total).toBe(
      bookmarks.filter((bookmark) => languageOf(bookmark) === language).length,
    );
    expect(facets.languages[language]).toBe(page.total);
    sum += page.total;
  }
  expect(sum).toBe(bookmarks.length);
});

test("a count for one group ignores that group's own choice, and respects every other", () => {
  const { store } = everyBookmark();
  const open = getLibraryFacets(store, { features: ["media"] });

  const chosen = getLibraryFacets(store, {
    features: ["media"],
    language: "en",
  });

  // Choosing English leaves the other languages' counts standing...
  expect(chosen.languages).toEqual(open.languages);
  // ...and narrows everything else to English posts with media.
  expect(chosen.total).toBe(open.languages.en);
  expect(chosen.features.media).toBe(chosen.total);
  expect(chosen.librarySize).toBe(open.librarySize);
});

test("a time range lists what was saved in it, start included and end excluded", () => {
  const { store, bookmarks } = everyBookmark();
  const times = bookmarks.map((bookmark) => bookmark.bookmarkedAt.getTime());
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  const count = (query: LibraryQuery) => listLibrary(store, query).total;

  expect(
    count({ savedFrom: new Date(oldest), savedBefore: new Date(newest + 1) }),
  ).toBe(times.length);
  expect(
    count({ savedFrom: new Date(oldest), savedBefore: new Date(newest) }),
  ).toBe(times.filter((time) => time < newest).length);
  expect(count({ savedFrom: new Date(newest + 1) })).toBe(0);
});

test("the years offered are the years something was saved in, newest first, and add up", () => {
  const { store, total } = everyBookmark();

  const { savedYears } = getLibraryFacets(store);

  expect(savedYears.map(({ year }) => year)).toEqual(
    [...savedYears.map(({ year }) => year)].sort((a, b) => b - a),
  );
  expect(savedYears.reduce((sum, { count }) => sum + count, 0)).toBe(total);
  for (const { year, count } of savedYears) {
    expect(
      listLibrary(store, {
        savedFrom: new Date(year, 0, 1),
        savedBefore: new Date(year + 1, 0, 1),
      }).total,
    ).toBe(count);
  }
});

test("an author's bookmarks are listed by the author's id, and the author is named", () => {
  const { store, bookmarks } = everyBookmark();
  const [author] = bookmarks;
  if (author === undefined) throw new Error("The fixtures hold no bookmark.");

  const page = everything(store, { authorId: author.authorId });

  expect(idsOf(page.items)).toEqual(
    bookmarks
      .filter((bookmark) => bookmark.authorId === author.authorId)
      .map((bookmark) => bookmark.postId),
  );
  expect(getLibraryFacets(store, { authorId: author.authorId }).author).toEqual(
    {
      id: author.authorId,
      handle: author.authorHandle,
      name: author.authorName,
    },
  );
  expect(getLibraryFacets(store, { authorId: "1" }).author).toBeNull();
});

test("a post X withholds is not in the list, and is listed by id when asked for", () => {
  const { store, bookmarks } = everyBookmark();
  const withheld = listParseIssues(store)
    .filter((issue) => issue.kind === "post-unavailable")
    .map((issue) => issue.postId);
  expect(withheld.length).toBeGreaterThan(0);

  const page = everything(store, { standing: "withheld" });

  expect(
    page.items.map((item) => (item.kind === "withheld" ? item.postId : null)),
  ).toEqual([...withheld].sort().reverse());
  expect(page.total).toBe(withheld.length);
  expect(getLibraryFacets(store).standings.withheld).toBe(withheld.length);
  expect(getLibraryFacets(store, { standing: "withheld" })).toMatchObject({
    total: withheld.length,
    standings: { withheld: withheld.length },
  });
  for (const postId of withheld) {
    expect(bookmarks.map((bookmark) => bookmark.postId)).not.toContain(postId);
  }
});

test("a withheld post has nothing to search or filter by, so any other condition leaves it out", () => {
  const { store } = everyBookmark();

  for (const query of [
    { text: "a" },
    { features: ["media"] as const },
    { language: "other" as const },
    { savedFrom: new Date(0) },
    { authorId: "1" },
  ]) {
    const page = listLibrary(store, { ...query, standing: "withheld" });
    expect(page.items.filter((item) => item.kind === "withheld")).toEqual([]);
    expect(page.total).toBe(0);
    expect(
      getLibraryFacets(store, { ...query, standing: "withheld" }).total,
    ).toBe(0);
  }
});

test("a post X withholds after the library captured it stays a bookmark, marked, and leads the withheld", () => {
  const store = openTempStore();
  const early = new Date("2026-10-05T09:00:00.000Z");
  const later = new Date("2026-10-06T09:00:00.000Z");
  // The ids X withholds in the fixture, read from a library of its own.
  const scratch = openTempStore();
  storeCapture(scratch, bookmarksFixture("withheld-posts"));
  parsePendingCaptures(scratch);
  const [kept = "", never = ""] = idsOf(
    everything(scratch, { standing: "withheld" }).items,
  );
  expect(never).not.toBe("");
  // The library read one of them from an earlier capture.
  upsertBookmark(store, {
    postId: kept,
    authorId: "1",
    authorHandle: "author",
    authorName: "Author",
    text: "what it said",
    postedAt: new Date("2026-01-01T00:00:00.000Z"),
    captureId: storeCapture(store, "{}", "Bookmarks", { receivedAt: early }),
  });
  expect(listLibrary(store, { standing: "withheld" }).total).toBe(0);

  storeCapture(store, bookmarksFixture("withheld-posts"), "Bookmarks", {
    receivedAt: later,
  });
  parsePendingCaptures(store);

  const page = listLibrary(store, { standing: "withheld" });
  expect(page.items).toEqual([
    {
      kind: "bookmark",
      bookmark: expect.objectContaining({
        postId: kept,
        text: "what it said",
        withheldOnXAt: later,
      }),
    },
    { kind: "withheld", postId: never },
  ]);
  expect(page.total).toBe(2);
  expect(idsOf(listLibrary(store).items)).toContain(kept);
  expect(getLibraryFacets(store).standings.withheld).toBe(2);
  // Its text is still found, and still counted among the withheld.
  expect(idsOf(listLibrary(store, { text: "said" }).items)).toEqual([kept]);
  expect(getLibraryFacets(store, { text: "said" }).standings.withheld).toBe(1);

  // A page that ends with the bookmarks leaves the rest for the next.
  const first = listLibrary(store, { standing: "withheld" }, { limit: 1 });
  expect(idsOf(first.items)).toEqual([kept]);
  expect(first.nextCursor).toBe("w:0");
  const second = listLibrary(
    store,
    { standing: "withheld" },
    { limit: 1, after: first.nextCursor },
  );
  expect(second).toMatchObject({
    items: [{ kind: "withheld", postId: never }],
    nextCursor: null,
    total: 2,
  });
});

test("a bookmark removed on X leaves the list, and is kept under its own filter with the time", () => {
  const { store, bookmarks, total } = everyBookmark();
  const [removed] = bookmarks;
  if (removed === undefined) throw new Error("The fixtures hold no bookmark.");
  expect(getLibraryFacets(store).standings.removed).toBe(0);
  const removedAt = new Date(removed.lastSeenAt.getTime() + 60_000);

  storeCapture(
    store,
    readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json"),
    "DeleteBookmark",
    {
      receivedAt: removedAt,
      requestBody: JSON.stringify({ variables: { tweet_id: removed.postId } }),
    },
  );
  parsePendingCaptures(store);

  const listed = everything(store);
  expect(listed.total).toBe(total - 1);
  expect(idsOf(listed.items)).not.toContain(removed.postId);
  const kept = listLibrary(store, { standing: "removed" });
  expect(bookmarksOf(kept.items)).toEqual([
    { ...removed, removedOnXAt: removedAt },
  ]);
  expect(kept.total).toBe(1);
  const facets = getLibraryFacets(store);
  expect(facets.standings.removed).toBe(1);
  expect(facets.librarySize).toBe(total - 1);
  expect(facets.librarySize).toBe(summariseLibrary(store).bookmarks);
  // The other filters apply to the removed as to any bookmark.
  expect(
    listLibrary(store, { standing: "removed", authorId: removed.authorId })
      .total,
  ).toBe(1);
  expect(listLibrary(store, { standing: "removed", authorId: "1" }).total).toBe(
    0,
  );
  // And choosing "removed" leaves the count of the withheld standing.
  expect(getLibraryFacets(store, { standing: "removed" }).standings).toEqual(
    facets.standings,
  );
});

test("a page is at most the size asked for, within core's limit", () => {
  const { store, total } = everyBookmark();

  expect(listLibrary(store, {}, { limit: 3 }).items).toHaveLength(3);
  expect(listLibrary(store, {}, { limit: 0 }).items).toHaveLength(1);
  expect(listLibrary(store, {}, { limit: 100_000 }).items).toHaveLength(
    Math.min(MAX_PAGE_SIZE, total),
  );
});

test("a cursor is taken only by the kind of list that gave it out", () => {
  const { store } = everyBookmark();
  const text = commonWord(store);
  const list = listLibrary(store, {}, { limit: 2 }).nextCursor;
  const search = listLibrary(store, { text }, { limit: 2 }).nextCursor;
  expect(list).not.toBeNull();
  expect(search).not.toBeNull();

  for (const [query, after] of [
    [{}, search],
    [{}, "w:0"],
    [{ text }, list],
    [{ text }, "w:0"],
    [{ standing: "withheld", text }, "w:0"],
    [{ standing: "withheld" }, "w:x"],
    [{}, "nonsense"],
  ] as const) {
    expect(() => listLibrary(store, query, { after })).toThrow(RangeError);
  }
});

test("the status is a problem when a capture was not understood, and says how many", () => {
  const store = openFixtureLibrary();
  expect(getLibraryStatus(store, BACKUPS_WELL).level).toBe("ok");

  storeCapture(store, '{"data":{"not":"a bookmarks timeline"}}');
  parsePendingCaptures(store);

  const status = getLibraryStatus(store, BACKUPS_WELL);
  expect(status.level).toBe("problem");
  expect(status.parsing.captures.failed).toBe(1);
  // The bookmarks already read are still listed.
  expect(listLibrary(store).total).toBe(status.parsing.bookmarks);
});

test("the status asks for attention while a capture is waiting to be parsed", () => {
  const store = openFixtureLibrary();

  storeCapture(store, bookmarksFixture("text-posts"));

  const status = getLibraryStatus(store, BACKUPS_WELL);
  expect(status.level).toBe("attention");
  expect(status.parsing.captures.pending).toBe(1);
  expect(status.captures.count).toBeGreaterThan(1);
  expect(status.captures.lastReceivedAt).toBeInstanceOf(Date);
});

test("the status is a problem while the library is not being backed up, whatever else is well", () => {
  const store = openFixtureLibrary();
  const at = new Date("2026-10-12T09:00:00.000Z");

  for (const backups of [
    {
      ...BACKUPS_WELL,
      lastAttempt: { at, outcome: "failed" as const, reason: "no room" },
    },
    { ...BACKUPS_WELL, unreadable: "not a directory" },
  ]) {
    expect(getLibraryStatus(store, backups)).toMatchObject({
      level: "problem",
      backups,
    });
  }
  for (const outcome of ["written", "unchanged", "recent", "empty"] as const) {
    expect(
      getLibraryStatus(store, {
        ...BACKUPS_WELL,
        lastAttempt: { at, outcome },
      }).level,
    ).toBe("ok");
  }
});

// --- What a bookmark is filed under ------------------------------------------

const postIds = (bookmarks: Bookmark[]) =>
  bookmarks.map(({ postId }) => postId).sort();

test("before anything is classified, nothing is filed, every bookmark is unclassified, and no filter of it finds a thing", () => {
  const { store, bookmarks } = everyBookmark();

  const facets = getLibraryFacets(store);

  expect(facets.anyFiled).toBe(false);
  expect(facets.notClassified).toBe(bookmarks.length);
  expect(facets.categories.map(({ count }) => count)).toEqual(
    facets.categories.map(() => 0),
  );
  expect(facets.formats.map(({ count }) => count)).toEqual(
    facets.formats.map(() => 0),
  );
  expect(facets.other).toEqual({ little: 0, enough: 0 });
  expect(facets.tags).toEqual([]);
  expect(everything(store, { category: "web-dev" }).total).toBe(0);
  expect(everything(store, { category: NOT_CLASSIFIED }).total).toBe(
    bookmarks.length,
  );
});

test("a category lists what is filed under it, the owner's word included, and the counts beside it are what each would leave", () => {
  const { store, bookmarks, classified, filedByOwner } = openFiledLibrary();
  const facets = getLibraryFacets(store);
  const under = (category: string | null) =>
    bookmarks.filter(({ labels }) => labels.category === category);

  expect(facets.anyFiled).toBe(true);
  // Every category of the taxonomy but "other", in its order, counted.
  expect(facets.categories.map(({ id }) => id)).not.toContain("other");
  for (const { id, count } of facets.categories) {
    expect(count, id).toBe(under(id).length);
    expect(postIds(everything(store, { category: id }).bookmarks)).toEqual(
      postIds(under(id)),
    );
  }
  expect(under("web-dev")).toHaveLength(2);
  expect(postIds(under("life"))).toEqual([filedByOwner.postId]);
  // What is filed under none yet, the owner's or the classifier's.
  expect(facets.notClassified).toBe(bookmarks.length - classified.length - 1);
  expect(
    postIds(everything(store, { category: NOT_CLASSIFIED }).bookmarks),
  ).toEqual(postIds(under(null)));
  expect(
    facets.categories.reduce((sum, { count }) => sum + count, 0) +
      facets.other.little +
      facets.other.enough +
      facets.notClassified,
  ).toBe(bookmarks.length);
});

test("the two reasons a bookmark is under other are counted and listed apart", () => {
  const { store, classified } = openFiledLibrary();
  const [, , , little, enough] = classified;

  expect(getLibraryFacets(store).other).toEqual({ little: 1, enough: 1 });
  expect(
    idsOf(
      everything(store, { category: "other", otherReason: "little" }).items,
    ),
  ).toEqual([little?.postId]);
  expect(
    idsOf(
      everything(store, { category: "other", otherReason: "enough" }).items,
    ),
  ).toEqual([enough?.postId]);
  expect(everything(store, { category: "other" }).total).toBe(2);
  // The reason is asked only of "other": beside another category it is not a filter.
  expect(
    everything(store, { category: "web-dev", otherReason: "little" }).total,
  ).toBe(2);
  // A bookmark the owner files is no longer there for want of text.
  expect(little?.labels.tooLittleText).toBe(true);
  expect(enough?.labels.tooLittleText).toBe(false);
});

test("a count for the categories sets the chosen category and its reason aside, and respects every other filter", () => {
  const { store } = openFiledLibrary();
  const open = getLibraryFacets(store);

  for (const query of [
    { category: "web-dev" },
    { category: "other", otherReason: "little" },
    { category: NOT_CLASSIFIED },
  ] satisfies LibraryQuery[]) {
    const chosen = getLibraryFacets(store, query);
    expect(chosen.categories).toEqual(open.categories);
    expect(chosen.other).toEqual(open.other);
    expect(chosen.notClassified).toBe(open.notClassified);
    expect(chosen.total).toBe(everything(store, query).total);
  }
  // Another filter narrows them like everything else.
  const tagged = getLibraryFacets(store, { tags: ["react"] });
  expect(tagged.categories.find(({ id }) => id === "web-dev")?.count).toBe(2);
  expect(tagged.categories.find(({ id }) => id === "design")?.count).toBe(0);
  expect(tagged.notClassified).toBe(0);
});

test("formats and tags filter and count like every other filter, and compose with a category, a feature and a search", () => {
  const { store, bookmarks, classified } = openFiledLibrary();
  const facets = getLibraryFacets(store);

  for (const { id, count } of facets.formats) {
    const of = bookmarks.filter(({ labels }) => labels.format === id);
    expect(count, id).toBe(of.length);
    expect(postIds(everything(store, { format: id }).bookmarks)).toEqual(
      postIds(of),
    );
  }
  expect(facets.formats.find(({ id }) => id === "unclear")?.count).toBe(2);

  // The tags among the matches, most bookmarks first.
  expect(facets.tags[0]).toEqual({ tag: "react", count: 2 });
  for (const { tag, count } of facets.tags) {
    const having = bookmarks.filter(({ labels }) => labels.tags.includes(tag));
    expect(count, tag).toBe(having.length);
    expect(postIds(everything(store, { tags: [tag] }).bookmarks)).toEqual(
      postIds(having),
    );
  }
  // Every tag asked for has to be there.
  expect(idsOf(everything(store, { tags: ["react", "nextjs"] }).items)).toEqual(
    [classified[0]?.postId],
  );
  expect(getLibraryFacets(store, { tags: ["react", "nextjs"] }).tags).toEqual([
    { tag: "nextjs", count: 1 },
    { tag: "react", count: 1 },
  ]);

  // With a category, a format and a tag together.
  const narrow: LibraryQuery = {
    category: "web-dev",
    format: "tip",
    tags: ["react"],
  };
  expect(idsOf(everything(store, narrow).items)).toEqual([
    classified[1]?.postId,
  ]);
  // With a feature of the post, and with a search: each must hold as well.
  const first = classified[0];
  if (first === undefined) throw new Error("Nothing is classified.");
  for (const feature of POST_FEATURES) {
    const both = everything(store, {
      category: "web-dev",
      features: [feature],
    }).bookmarks;
    expect(postIds(both)).toEqual(
      postIds(
        bookmarks.filter(
          (bookmark) =>
            bookmark.labels.category === "web-dev" && HAS[feature](bookmark),
        ),
      ),
    );
  }
  const found = everything(store, {
    text: `@${first.authorHandle}`,
    category: "web-dev",
  });
  expect(found.total).toBeGreaterThan(0);
  for (const bookmark of found.bookmarks) {
    expect(bookmark.labels.category).toBe("web-dev");
  }
  expect(
    getLibraryFacets(store, {
      text: `@${first.authorHandle}`,
      category: "web-dev",
    }).total,
  ).toBe(found.total);
});

test("a tag may be written another way, and a text that is no tag matches nothing and is named", () => {
  const { store, classified } = openFiledLibrary();

  // "next.js" is another way of writing the tag, in any case.
  expect(readTags(store, ["Next.js", "nextjs", "REACT"])).toEqual({
    known: ["nextjs", "react"],
    unknown: [],
  });
  expect(idsOf(everything(store, { tags: ["Next.js"] }).items)).toEqual([
    classified[0]?.postId,
  ]);
  expect(getLibraryFacets(store, { tags: ["Next.js"] }).chosenTags).toEqual([
    "nextjs",
  ]);

  const query: LibraryQuery = { tags: ["react", "no-such-tag"] };
  expect(everything(store, query)).toMatchObject({ total: 0, items: [] });
  expect(getLibraryFacets(store, query)).toMatchObject({
    total: 0,
    chosenTags: ["react"],
    unknownTags: ["no-such-tag"],
  });
});

test("the bookmarks a tag was proposed for are listed by its name", () => {
  const { store, classified } = openFiledLibrary();
  const proposedFor = (name: string) =>
    postIds(everything(store, { proposedTag: name }).bookmarks);

  expect(proposedFor("server-actions")).toEqual(
    postIds(classified.slice(0, 2)),
  );
  expect(proposedFor("Server Actions")).toEqual(
    postIds(classified.slice(0, 2)),
  );
  expect(proposedFor("server-action")).toEqual([classified[2]?.postId]);
  expect(proposedFor("never-proposed")).toEqual([]);
});

test("a post X withholds, which the library never held, is filed under nothing and matches no filter of it", () => {
  const { store } = openFiledLibrary();
  const held = (query: LibraryQuery) =>
    everything(store, { standing: "withheld", ...query }).items.filter(
      (item) => item.kind === "withheld",
    );

  expect(held({}).length).toBeGreaterThan(0);
  for (const query of [
    { category: "web-dev" },
    { category: NOT_CLASSIFIED },
    { format: "guide" },
    { tags: ["react"] },
    { proposedTag: "server-actions" },
  ] satisfies LibraryQuery[]) {
    expect(held(query)).toEqual([]);
  }
});

test("the choices a row's menus offer are the taxonomy's and the vocabulary's own", () => {
  const { store } = openFiledLibrary();

  const choices = labelChoices(store);

  expect(choices.categories.map(({ id }) => id)).toContain("web-dev");
  expect(choices.categories.at(-1)).toMatchObject({
    id: "other",
    label: "Other",
  });
  expect(choices.formats.map(({ id }) => id)).toContain("unclear");
  for (const { label, definition } of [
    ...choices.categories,
    ...choices.formats,
  ]) {
    expect(label).toMatch(/\S/);
    expect(definition).toMatch(/\S/);
  }
  expect(choices.tags.map(({ tag }) => tag)).toEqual(
    choices.tags.map(({ tag }) => tag).toSorted(),
  );
  expect(choices.tags.find(({ tag }) => tag === "nextjs")?.aliases).toEqual([
    "next.js",
  ]);
});
