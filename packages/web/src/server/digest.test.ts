import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Bookmark,
  finishDigestRun,
  insertRawCapture,
  latestWeekEnded,
  listBookmarks,
  parseCapture,
  recordClassification,
  type Store,
  startDigestRun,
  summariseWeek,
  type Week,
  weekAfter,
  weekBefore,
  weekOf,
} from "@curio/core";
import { openTempStore, readFixture } from "@curio/core/testing";
import { expect, test } from "vitest";
import { getDigestPage } from "./digest.ts";
import { digestHref, LIBRARY_LINKS, parseDigestWeek } from "./digest-params.ts";
import { bookmarksFixture, storeCapture } from "./library-testing.ts";

const NOW = new Date(2026, 9, 13, 10);

/** A library of the fixtures' posts, and the week most of them were saved in. */
function library(): { store: Store; week: Week; inWeek: Bookmark[] } {
  const store = openTempStore();
  for (const name of [
    "text-posts",
    "long-posts",
    "quoted-posts",
    "media",
  ] as const) {
    parseCapture(store, storeCapture(store, bookmarksFixture(name)));
  }
  const all = listBookmarks(store, { limit: 100 }).bookmarks;
  const counts = new Map<string, number>();
  for (const bookmark of all) {
    const { key } = weekOf(bookmark.bookmarkedAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key] = [...counts].toSorted((a, b) => b[1] - a[1])[0] ?? [];
  const inWeek = all.filter(
    (bookmark) => weekOf(bookmark.bookmarkedAt).key === key,
  );
  const [first] = inWeek;
  if (first === undefined || inWeek.length < 4) {
    throw new Error("The fixtures hold no week of four bookmarks.");
  }
  return { store, week: weekOf(first.bookmarkedAt), inWeek };
}

const file = (
  store: Store,
  postId: string,
  category: string,
  parts: { little?: boolean; proposed?: string[]; tags?: string[] } = {},
) =>
  recordClassification(store, {
    postId,
    category,
    format: "guide",
    tags: parts.tags ?? [],
    tooLittleText: parts.little === true,
    proposedTags: parts.proposed ?? [],
    instructionsVersion: 1,
    model: "a-model",
  });

test("the address names a week by any of its days, and anything else is the week that last ended", () => {
  const latest = latestWeekEnded(NOW);

  expect(parseDigestWeek({ week: "2026-10-05" }, NOW).key).toBe("2026-10-05");
  expect(parseDigestWeek({ week: "2026-10-08" }, NOW).key).toBe("2026-10-05");
  expect(parseDigestWeek({ week: ["2026-09-30", "2026-01-01"] }, NOW).key).toBe(
    "2026-09-28",
  );
  for (const week of [
    undefined,
    "",
    "last",
    "2026-02-30",
    "2026-13-01",
    "1999-01-04",
    "2026-10-05T00:00",
    "2026-10-05' OR 1=1",
  ]) {
    expect(parseDigestWeek({ week }, NOW), String(week)).toEqual(latest);
  }
  expect(latest.key).toBe("2026-10-05");
  expect(digestHref(latest)).toBe("/digest?week=2026-10-05");
});

test("the links into the library carry core's own filters by core's own names", () => {
  expect(LIBRARY_LINKS.fittedNoCategory("other")).toBe(
    "/?cat=other&text=enough",
  );
  expect(LIBRARY_LINKS.proposedTag("drizzle")).toBe("/?proposed=drizzle");
  expect(LIBRARY_LINKS.proposedTag("a b&c")).toBe("/?proposed=a+b%26c");
  expect(LIBRARY_LINKS.category("web-dev")).toBe("/?cat=web-dev");
  expect(LIBRARY_LINKS.format("guide")).toBe("/?fmt=guide");
  expect(LIBRARY_LINKS.tag("nextjs")).toBe("/?tag=nextjs");
});

test("a week's page holds its counts, its posts newest first, and the weeks either side", () => {
  const { store, week, inWeek } = library();

  const page = getDigestPage(store, week, NOW);

  expect(page.week).toEqual(week);
  expect(page.running).toBe(false);
  expect(page.previous).toEqual(weekBefore(week));
  expect(page.next).toEqual(weekAfter(week));
  expect(page.summary).toEqual(summariseWeek(store, week));
  expect(page.summary.bookmarks).toBe(inWeek.length);
  expect(page.posts.map(({ view }) => view.id)).toEqual(
    inWeek.map(({ postId }) => postId),
  );
  expect(page.posts.map(({ savedOn }) => savedOn)).toEqual(
    inWeek.map(({ bookmarkedAt }) => bookmarkedAt),
  );
  expect(page.written).toBeNull();
  expect(page.enoughForSummary).toBe(true);
  expect(page.classifiedInLibrary).toBe(0);
  expect(page.weeks.find((entry) => entry.week.key === week.key)).toMatchObject(
    { bookmarks: inWeek.length, written: false },
  );
  // No view sent to the browser carries an avatar's address (X-9).
  expect(JSON.stringify(page.posts)).not.toMatch(/profile_images|avatar/i);
});

test("a week that has not ended is running, and there is no week after one that has not begun", () => {
  const { store } = library();
  const current = weekOf(NOW);

  const page = getDigestPage(store, current, NOW);

  expect(page.running).toBe(true);
  expect(page.next).toBeNull();
  expect(page.summary.bookmarks).toBe(0);
  expect(page.posts).toEqual([]);
  expect(page.enoughForSummary).toBe(false);
  expect(getDigestPage(store, weekBefore(current), NOW).next).toEqual(current);
});

test("the suggestions are the week's bookmarks that fitted no category, and the tags proposed more than once", () => {
  const { store, week, inWeek } = library();
  const [a, b, c, d] = inWeek.map(({ postId }) => postId);
  if (!a || !b || !c || !d) throw new Error("Too few bookmarks.");
  file(store, a, "web-dev", { proposed: ["drizzle"], tags: ["react"] });
  file(store, b, "web-dev", { proposed: ["drizzle"] });
  file(store, c, "other", { proposed: ["made-once"] });
  file(store, d, "other", { little: true });

  const { suggestions, classifiedInLibrary, summary } = getDigestPage(
    store,
    week,
    NOW,
  );

  expect(classifiedInLibrary).toBe(4);
  expect(summary.other).toEqual({
    bookmarks: 2,
    tooLittleText: 1,
    noneOfTheAbove: 1,
  });
  expect(suggestions.unfittedThisWeek).toBe(1);
  expect(suggestions.unfittedInLibrary).toBe(1);
  expect(suggestions.unfitted).toMatchObject([{ id: c, listed: true }]);
  expect(suggestions.proposalsWaiting).toBe(1);
  expect(suggestions.proposedOnce).toBe(1);
  expect(suggestions.proposals).toMatchObject([
    { proposal: "drizzle", bookmarks: 2 },
  ]);
  // Another week sees the same proposals, and no bookmark of this one.
  const before = getDigestPage(store, weekBefore(week), NOW).suggestions;
  expect(before.unfittedThisWeek).toBe(0);
  expect(before.unfittedInLibrary).toBe(1);
  expect(before.proposalsWaiting).toBe(1);
});

function write(store: Store, week: Week, postIds: string[]) {
  const [a = "", b = ""] = postIds;
  const run = startDigestRun(store, {
    week,
    startedBy: "owner",
    model: "a-model",
    instructionsVersion: 1,
    bookmarksInWeek: postIds.length,
    postIds,
    capUsd: 0.5,
  });
  return finishDigestRun(store, run.id, {
    outcome: "written",
    text: {
      overview: "An overview of the week.",
      themes: [{ title: "A theme", summary: "On two posts.", postIds: [a, b] }],
      worthRevisiting: [{ postId: b, why: "It is the fullest." }],
    },
    inputTokens: 1000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 500,
    costUsd: 0.014,
    unansweredRequests: 0,
    now: new Date(2026, 9, 12, 21),
  });
}

test("a written digest is shown with the bookmarks it points at, each leading to its post on the page", () => {
  const { store, week, inWeek } = library();
  const ids = inWeek.map(({ postId }) => postId);
  const [a = "", b = ""] = ids;
  write(store, week, ids);

  const { written, weeks } = getDigestPage(store, week, NOW);

  expect(written).toMatchObject({
    overview: "An overview of the week.",
    themes: [
      {
        title: "A theme",
        summary: "On two posts.",
        posts: [
          { id: a, listed: true },
          { id: b, listed: true },
        ],
      },
    ],
    worthRevisiting: [
      { post: { id: b, listed: true }, why: "It is the fullest." },
    ],
    writtenAt: new Date(2026, 9, 12, 21),
    model: "a-model",
    from: ids.length,
    inWeekThen: ids.length,
    savedSince: 0,
  });
  const reference = written?.themes[0]?.posts[0];
  expect(reference?.author).toBe(inWeek[0]?.authorName);
  expect(reference?.opening.length).toBeLessThanOrEqual(111);
  expect(weeks.find((entry) => entry.week.key === week.key)?.written).toBe(
    true,
  );
});

test("a bookmark saved after the digest was written is counted as not in it, and one removed since is still named", () => {
  const { store, week, inWeek } = library();
  const ids = inWeek.map(({ postId }) => postId);
  // Written when the week held one bookmark fewer.
  write(store, week, ids.slice(0, -1));
  const [removed = ""] = ids;
  const capture = insertRawCapture(store, {
    source: "x-web-client",
    operation: "DeleteBookmark",
    payload: readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json"),
    requestBody: JSON.stringify({ variables: { tweet_id: removed } }),
  });
  parseCapture(store, capture.id);

  const page = getDigestPage(store, week, NOW);

  expect(page.summary).toMatchObject({
    bookmarks: ids.length - 1,
    removedOnX: 1,
  });
  expect(page.posts.map(({ view }) => view.id)).not.toContain(removed);
  expect(page.written?.themes[0]?.posts[0]).toMatchObject({
    id: removed,
    listed: false,
    removedOnX: true,
  });
  // One left the week and one joined it: the count alone says neither.
  expect(page.written?.savedSince).toBe(0);
  expect(page.written?.from).toBe(ids.length - 1);
});

test("the digest's own modules read through core, never write, and never ask for a digest to be written", () => {
  const sources = [
    "server/digest.ts",
    "server/digest-params.ts",
    "app/digest/page.tsx",
    ...readdirSync(join(import.meta.dirname, "../components/digest")).map(
      (name) => `components/digest/${name}`,
    ),
  ].map((path) => ({
    path,
    source: readFileSync(join(import.meta.dirname, "..", path), "utf8"),
  }));

  for (const { path, source } of sources) {
    // The tagger is the one package that calls Claude, and one module of
    // the app may load it: the tagging passes. The digest is not it.
    expect(source, path).not.toMatch(/@curio\/tagger/);
    expect(source, path).not.toMatch(
      /startDigestRun|finishDigestRun|writeDigest|\bfetch\b|"use server"/,
    );
    // What a model wrote goes into the page as text.
    expect(source, path).not.toMatch(/dangerouslySetInnerHTML/);
  }
  const data = sources.find(({ path }) => path === "server/digest.ts")?.source;
  expect(data).toMatch(/from "\.\/core\.ts"/);
});

test("a post the summary points at beyond what the page lists is said to be further down, not removed", () => {
  const { store, week, inWeek } = library();
  const ids = inWeek.map(({ postId }) => postId);
  // The summary points at the week's two oldest posts.
  write(store, week, ids.toReversed());

  // The page lists the week's latest two, which are not those.
  const page = getDigestPage(store, week, NOW, 2);

  expect(page.posts.map(({ view }) => view.id)).toEqual(ids.slice(0, 2));
  const pointedAt = [
    ...(page.written?.themes.flatMap(({ posts }) => posts) ?? []),
    ...(page.written?.worthRevisiting.map(({ post }) => post) ?? []),
  ];
  expect(pointedAt.length).toBeGreaterThan(0);
  const beyond = pointedAt.filter(({ listed }) => !listed);
  expect(beyond.length).toBeGreaterThan(0);
  for (const reference of pointedAt) {
    expect(reference.listed).toBe(ids.slice(0, 2).includes(reference.id));
    // None of them was removed on X, listed or not.
    expect(reference.removedOnX).toBe(false);
  }
});
