import { type Bookmark, isXOwnedHost, MAX_PAGE_SIZE } from "@x-bookmarks/core";
import { expect, test } from "vitest";
import { type LibraryBookmark, listLibrary } from "../server/library.ts";
import { openFixtureLibrary } from "../server/library-testing.ts";
import {
  describeMedia,
  initialsOf,
  type MarkedLine,
  type MediaView,
  type PostBody,
  type PostView,
  textPieces,
  toItemView,
} from "./post-view.ts";
import { X_MEDIA_HOSTS } from "./x-media-policy.ts";

function fixtureViews() {
  const items = listLibrary(
    openFixtureLibrary(),
    {},
    { limit: MAX_PAGE_SIZE },
  ).items;
  const bookmarks = items.filter(
    (item): item is LibraryBookmark => item.kind === "bookmark",
  );
  return bookmarks.map((item) => ({
    item,
    view: toItemView(item) as PostView,
  }));
}

const postView = (bookmark: Bookmark, terms: string[] = []) =>
  toItemView({ kind: "bookmark", bookmark }, terms) as PostView;

const markedIn = (line: MarkedLine | PostBody["text"] | null) =>
  (line ?? []).filter((piece) => piece.kind === "mark").map((p) => p.text);

const link = (url: string, displayUrl: string, shortUrl = "") => ({
  url,
  displayUrl,
  shortUrl,
});

test("a link in a post's text becomes a link, shown by its short name", () => {
  expect(
    textPieces("Read https://example.com/a/long/path now", [
      link("https://example.com/a/long/path", "example.com/a/long…"),
    ]),
  ).toEqual([
    { kind: "text", text: "Read " },
    {
      kind: "link",
      href: "https://example.com/a/long/path",
      label: "example.com/a/long…",
    },
    { kind: "text", text: " now" },
  ]);
});

test("an address that is not HTTP or HTTPS never becomes a link", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "not a url",
  ]) {
    expect(textPieces(`before ${url} after`, [link(url, "click me")])).toEqual([
      { kind: "text", text: `before ${url} after` },
    ]);
  }
});

test("a dropped link leaves the text, with the space before it", () => {
  const article = link(
    "https://example.com/article/77",
    "example.com/article/77",
  );

  expect(
    textPieces("Part one. https://example.com/article/77", [], article),
  ).toEqual([{ kind: "text", text: "Part one." }]);
  expect(textPieces("https://example.com/article/77", [], article)).toEqual([]);
});

test("media is described in whole phrases", () => {
  const media = (...kinds: MediaView["kind"][]): MediaView[] =>
    kinds.map((kind) => ({
      kind,
      alt: null,
      duration: null,
      aspectRatio: null,
      imageSrc: null,
      videoSrc: null,
    }));

  expect(describeMedia(media())).toBeNull();
  expect(describeMedia(media("photo"))).toBe("1 photo");
  expect(describeMedia(media("photo", "photo", "video"))).toBe(
    "2 photos and 1 video",
  );
  expect(describeMedia(media("gif", "video", "photo", "gif"))).toBe(
    "1 photo, 1 video, and 2 GIFs",
  );
});

test.each([
  ["Ada Lovelace", "ada", "AL"],
  ["özcan çelik", "oc", "ÖÇ"],
  ["🔥 Single", "s", "S"],
  ["one two three", "o", "OT"],
  ["🔥🔥", "handle", "H"],
])(
  "the initials of %s are shown in place of a picture",
  (name, handle, initials) => {
    expect(initialsOf(name, handle)).toBe(initials);
  },
);

test("every fixture bookmark becomes a view with its text, author and both times", () => {
  const views = fixtureViews();
  expect(views.length).toBeGreaterThan(20);

  for (const { item, view } of views) {
    const { bookmark } = item;
    expect(view.kind).toBe("post");
    expect(view.id).toBe(bookmark.postId);
    expect(view.author).toMatchObject({
      id: bookmark.authorId,
      name: bookmark.authorName,
      handle: bookmark.authorHandle,
    });
    expect(view.posted.iso).toBe(bookmark.postedAt.toISOString());
    expect(view.saved.iso).toBe(bookmark.bookmarkedAt.toISOString());
    expect(view.savedBy).toBe(
      bookmark.estimatedBookmarkedAt === null ? "first-seen" : "estimate",
    );
    expect(view.url).toContain(`/status/${bookmark.postId}`);
    // Nothing of the text is lost when its links are cut out of it.
    const shown = view.text
      .map((piece) => (piece.kind === "text" ? piece.text : ""))
      .join("");
    // Nothing is marked when nothing was searched for.
    expect(markedIn(view.text)).toEqual([]);
    expect(view.further).toBeNull();
    for (const word of bookmark.text
      .split(/\s+/)
      .filter((w) => /^\p{L}+$/u.test(w))) {
      expect(shown).toContain(word);
    }
  }
});

test("no view carries an avatar's address: avatars are never loaded", () => {
  const views = fixtureViews();
  const avatars = views
    .map(({ item }) => item.bookmark.authorAvatarUrl)
    .filter((url) => url !== null);
  expect(avatars.length).toBeGreaterThan(0);

  const sent = JSON.stringify(views.map(({ view }) => view));
  for (const avatar of avatars) expect(sent).not.toContain(avatar);
  expect(sent).not.toContain("profile_images");
});

test("the only X-hosted addresses a view offers to load are media on X's two media hosts", () => {
  const sources: { src: string; host: string }[] = [];
  const collect = (src: string | null, host: string) => {
    if (src !== null) sources.push({ src, host });
  };
  for (const { view } of fixtureViews()) {
    const bodies = [view, ...(view.quoted?.available ? [view.quoted] : [])];
    for (const body of bodies) {
      for (const media of body.media) {
        collect(media.imageSrc, X_MEDIA_HOSTS.image);
        collect(media.videoSrc, X_MEDIA_HOSTS.video);
      }
      collect(body.card?.imageSrc ?? null, X_MEDIA_HOSTS.image);
      collect(body.article?.coverSrc ?? null, X_MEDIA_HOSTS.image);
    }
  }

  expect(sources.length).toBeGreaterThan(5);
  for (const { src, host } of sources) {
    const url = new URL(src);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(host);
    expect(isXOwnedHost(url.hostname)).toBe(true);
  }
});

test("a quoted post X withholds is shown as unavailable, by its id", () => {
  const withheld = fixtureViews().find(
    ({ item }) => item.bookmark.quoted?.available === false,
  );
  if (withheld === undefined) {
    throw new Error("The fixtures hold no withheld quoted post.");
  }

  expect(withheld.view.quoted).toEqual({
    available: false,
    id: withheld.item.bookmark.quoted?.postId,
    url: expect.stringContaining(
      `/status/${withheld.item.bookmark.quoted?.postId}`,
    ),
  });
});

test("a post X withholds, which the library never held, is a note with its id", () => {
  expect(toItemView({ kind: "withheld", postId: "20" })).toEqual({
    kind: "withheld",
    id: "20",
    url: expect.stringContaining("/status/20"),
  });
});

test("a bookmark removed on X, or withheld after it was captured, says so", () => {
  const [first] = fixtureViews();
  if (first === undefined) throw new Error("The fixtures hold no bookmark.");
  const removedAt = new Date("2026-10-01T10:00:00Z");

  const view = postView({
    ...first.item.bookmark,
    removedOnXAt: removedAt,
    withheldOnXAt: removedAt,
  });

  expect(view.removed?.iso).toBe(removedAt.toISOString());
  expect(view.withheld).toBe(true);
  expect(first.view.removed).toBeNull();
  expect(first.view.withheld).toBe(false);
});

test("the saved time says what it rests on: X's confirmation, X's order, or the library's first sight", () => {
  const [first] = fixtureViews();
  if (first === undefined) throw new Error("The fixtures hold no bookmark.");
  const { bookmark } = first.item;
  const observed = new Date(bookmark.firstSeenAt.getTime() + 1000);

  expect(
    postView({
      ...bookmark,
      observedBookmarkedAt: observed,
      bookmarkedAt: observed,
    }),
  ).toMatchObject({
    savedBy: "observed",
    saved: { iso: observed.toISOString() },
  });
  expect(
    postView({
      ...bookmark,
      estimatedBookmarkedAt: null,
      observedBookmarkedAt: null,
      bookmarkedAt: bookmark.firstSeenAt,
    }).savedBy,
  ).toBe("first-seen");
});

test("what a search found is marked where the post shows it, as core's search finds it", () => {
  const [first] = fixtureViews();
  if (first === undefined) throw new Error("The fixtures hold no bookmark.");
  const view = postView(
    {
      ...first.item.bookmark,
      text: "Işık hızında agents https://example.com/agent done",
      links: [
        {
          url: "https://example.com/agent",
          shortUrl: "",
          displayUrl: "example.com/agent",
        },
      ],
      card: {
        url: "https://example.com/agent",
        title: "The Agent Handbook",
        description: "Nothing of note",
        domain: "example.com",
        imageUrl: null,
        name: "summary",
      },
      article: null,
      quoted: null,
    },
    ["isik", "agent"],
  );

  expect(view.text).toEqual([
    { kind: "mark", text: "Işık" },
    { kind: "text", text: " hızında " },
    { kind: "mark", text: "agent" },
    { kind: "text", text: "s " },
    {
      kind: "link",
      href: "https://example.com/agent",
      label: "example.com/agent",
    },
    { kind: "text", text: " done" },
  ]);
  expect(markedIn(view.card?.title ?? null)).toEqual(["Agent"]);
  expect(view.card?.description).toEqual([
    { kind: "text", text: "Nothing of note" },
  ]);
});

test("a match below where a shortened post is cut is quoted beside it, and one above is not", () => {
  const [first] = fixtureViews();
  if (first === undefined) throw new Error("The fixtures hold no bookmark.");
  const long = (text: string) =>
    postView({ ...first.item.bookmark, text, links: [], article: null }, [
      "needle",
    ]);

  const below = long(
    `${"hay ".repeat(400)}the needle is here ${"hay ".repeat(50)}`,
  );
  expect(below.collapsible).toBe(true);
  expect(markedIn(below.further)).toEqual(["needle"]);
  expect(
    (below.further ?? []).map((piece) => piece.text).join("").length,
  ).toBeLessThan(200);

  expect(long(`the needle is here ${"hay ".repeat(400)}`).further).toBeNull();
  expect(long(`${"hay ".repeat(400)}no match`).further).toBeNull();
  expect(long("a short needle").further).toBeNull();
});

test("long text is offered shortened, with its length in words", () => {
  const views = fixtureViews();
  const long = views.filter(({ view }) => view.collapsible);
  const short = views.filter(({ view }) => !view.collapsible);

  expect(long.length).toBeGreaterThan(0);
  expect(short.length).toBeGreaterThan(0);
  for (const { item, view } of long) {
    expect([...item.bookmark.text].length).toBeGreaterThan(280);
    expect(view.wordCount).toMatch(/^[0-9,]+$/);
  }
});
