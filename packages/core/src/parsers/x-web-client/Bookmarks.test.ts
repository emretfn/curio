import { globSync } from "node:fs";
import { expect, test } from "vitest";
import { readFixture } from "../../testing/fixtures.ts";
import type { ParsedBookmark, ParsedEntry } from "../parsed.ts";
import { parseBookmarks } from "./Bookmarks.ts";

const ENTRIES = "data.bookmark_timeline_v2.timeline.instructions.0.entries";
const POST = "content.itemContent.tweet_results.result";

function fixture(shows: string): string {
  return readFixture(`x-web-client/Bookmarks/2026-10-12-${shows}.json`);
}

/** Follows a dotted path into untyped JSON. */
function at(json: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, step) => (value as Record<string, unknown> | undefined)?.[step],
      json,
    );
}

/** The fixture's own entries, as X sent them, for comparing a parse against. */
function rawEntries(shows: string): unknown[] {
  return at(JSON.parse(fixture(shows)), ENTRIES) as unknown[];
}

/**
 * A fixture with one value changed, the way X changes a response: a field
 * renamed away (`undefined` removes it), retyped, or given a new variant.
 */
function changed(shows: string, path: string, value: unknown): string {
  const json: unknown = JSON.parse(fixture(shows));
  const steps = path.split(".");
  const last = steps.pop() ?? "";
  const parent = steps.reduce<unknown>(
    (value, step) => (value as Record<string, unknown>)[step],
    json,
  ) as Record<string, unknown>;
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return JSON.stringify(json);
}

function entriesOf(payload: string): ParsedEntry[] {
  const parsed = parseBookmarks(payload);
  if (parsed.outcome !== "parsed") {
    throw new Error(`Expected a parsed capture, got ${JSON.stringify(parsed)}`);
  }
  return parsed.entries;
}

function bookmarksOf(payload: string): ParsedBookmark[] {
  return entriesOf(payload).flatMap((entry) =>
    entry.kind === "bookmark" ? [entry.bookmark] : [],
  );
}

/** The post of a raw entry: what sits under `tweet_results.result`, or inside its visibility wrapper. */
function rawPost(shows: string, index: number): unknown {
  const result = at(rawEntries(shows)[index], POST);
  return at(result, "tweet") ?? result;
}

/** A value of a raw entry's post, as text: what a parse of it is compared with. */
function rawValue(shows: string, index: number, path: string): string {
  const value = at(rawPost(shows, index), path);
  expect(value, `${shows}[${index}].${path}`).toBeTypeOf("string");
  return String(value);
}

/** The one bookmark of a fixture that matches, so a test names a shape and not a position. */
function theBookmark(
  shows: string,
  matches: (bookmark: ParsedBookmark) => boolean,
): ParsedBookmark {
  const found = bookmarksOf(fixture(shows)).filter(matches);
  expect(found).toHaveLength(1);
  return found[0] as ParsedBookmark;
}

/** Fixtures of shapes that are stored with a part left empty, by design, until a parser reads that part. */
const NOT_FULLY_READ = ["2026-10-12-cards-not-read-yet.json"];

test("every fixture parses whole: each post becomes a bookmark or a withheld post, with nothing failed and nothing left empty", () => {
  const names = globSync("*.json", {
    cwd: new URL("../fixtures/x-web-client/Bookmarks/", import.meta.url),
  }).filter((name) => !NOT_FULLY_READ.includes(name));
  expect(names.length).toBeGreaterThanOrEqual(11);

  for (const name of names) {
    const payload = readFixture(`x-web-client/Bookmarks/${name}`);
    const parsed = parseBookmarks(payload);
    const posts = (at(JSON.parse(payload), ENTRIES) as unknown[]).filter(
      (entry) => at(entry, "content.entryType") === "TimelineTimelineItem",
    );

    expect(parsed, name).toMatchObject({ outcome: "parsed", warnings: [] });
    const entries = entriesOf(payload);
    expect(entries, name).toHaveLength(posts.length);
    for (const entry of entries) {
      expect(entry.kind, name).not.toBe("failed");
      if (entry.kind === "bookmark") expect(entry.warnings, name).toEqual([]);
    }
  }
});

test("a post is read with its author, time, engagement and place in the timeline", () => {
  const entry = entriesOf(fixture("text-posts"))[3];
  const author = "core.user_results.result";

  expect(entry).toEqual({
    kind: "bookmark",
    index: 3,
    path: "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[3]",
    entryId: `tweet-${rawValue("text-posts", 3, "rest_id")}`,
    postId: rawValue("text-posts", 3, "rest_id"),
    warnings: [],
    bookmark: {
      postId: rawValue("text-posts", 3, "rest_id"),
      authorId: rawValue("text-posts", 3, `${author}.rest_id`),
      authorHandle: rawValue("text-posts", 3, `${author}.core.screen_name`),
      authorName: "lorem ipsum d\u{1F516}lor",
      authorAvatarUrl: rawValue("text-posts", 3, `${author}.avatar.image_url`),
      authorVerified: true,
      text: expect.stringMatching(/^lorem ipsum dolor sit amet consectetur a@/),
      postedAt: new Date("2026-01-01T11:00:00.000Z"),
      lang: "en",
      conversationId: rawValue("text-posts", 3, "rest_id"),
      inReplyToPostId: null,
      inReplyToHandle: null,
      media: [],
      links: [],
      card: null,
      article: null,
      quoted: null,
      likeCount: at(rawPost("text-posts", 3), "legacy.favorite_count"),
      repostCount: at(rawPost("text-posts", 3), "legacy.retweet_count"),
      replyCount: at(rawPost("text-posts", 3), "legacy.reply_count"),
      quoteCount: at(rawPost("text-posts", 3), "legacy.quote_count"),
      bookmarkCount: at(rawPost("text-posts", 3), "legacy.bookmark_count"),
      viewCount: Number(rawValue("text-posts", 3, "views.count")),
      sortIndex: at(rawEntries("text-posts")[3], "sortIndex"),
    },
  });
  expect(entry).toMatchObject({
    bookmark: {
      postId: expect.stringMatching(/^[0-9]{19}$/),
      authorAvatarUrl: expect.stringMatching(
        /^https:\/\/pbs\.twimg\.com\/profile_images\/\d+\/\w+_normal\.jpg$/,
      ),
      likeCount: expect.any(Number),
      viewCount: expect.any(Number),
      sortIndex: expect.stringMatching(/^[0-9]{19}$/),
    },
  });
});

test("the timeline's cursors are not bookmarks, and the page past the last bookmark is an empty page, not a failure", () => {
  const lastPage = rawEntries("end-of-list");
  expect(lastPage.map((entry) => at(entry, "content.entryType"))).toEqual([
    "TimelineTimelineCursor",
    "TimelineTimelineCursor",
  ]);

  expect(parseBookmarks(fixture("end-of-list"))).toEqual({
    outcome: "parsed",
    entries: [],
    warnings: [],
  });
  expect(entriesOf(fixture("text-posts"))).toHaveLength(5);
  expect(rawEntries("text-posts")).toHaveLength(7);
});

test("a reply's text starts where X starts displaying it, after the handles it answers", () => {
  const answered = rawValue("text-posts", 1, "legacy.in_reply_to_screen_name");
  const [start, end] = at(
    rawPost("text-posts", 1),
    "legacy.display_text_range",
  ) as [number, number];
  const fullText = rawValue("text-posts", 1, "legacy.full_text");
  expect(fullText.startsWith(`@${answered}`)).toBe(true);
  expect(start).toBe(answered.length + 2);

  const reply = theBookmark(
    "text-posts",
    (bookmark) => bookmark.inReplyToPostId !== null,
  );

  expect(reply).toMatchObject({
    inReplyToPostId: rawValue(
      "text-posts",
      1,
      "legacy.in_reply_to_status_id_str",
    ),
    inReplyToHandle: answered,
    conversationId: rawValue("text-posts", 1, "legacy.conversation_id_str"),
  });
  expect(reply.conversationId).not.toBe(reply.postId);
  expect(reply.text).not.toContain("@");
  // The displayed part, with its one link written out.
  expect(reply.text).toBe(
    fullText
      .slice(start, end)
      .replace(/https:\/\/t\.co\/\w+/, reply.links[0]?.url ?? ""),
  );
  expect(reply.text).toMatch(
    /^psum dolor sit amet consectetur adipiscing elithttps:\/\/site6\.example\//,
  );
});

test("the characters X escapes in a post's text are restored", () => {
  const raw = rawValue("text-posts", 0, "legacy.full_text");
  expect(raw).toContain("labore e&amp;ore magna");

  const [bookmark] = bookmarksOf(fixture("text-posts"));

  expect(bookmark?.text).toContain("labore e&ore magna");
  expect(bookmark?.text).not.toMatch(/&(amp|lt|gt);/);
});

test("links are written out in full, also after characters that take two UTF-16 units", () => {
  const link = at(rawPost("text-posts", 2), "legacy.entities.urls.0") as {
    url: string;
    expanded_url: string;
    display_url: string;
    indices: [number, number];
  };
  const fullText = rawValue("text-posts", 2, "legacy.full_text");
  // The offsets count code points; read as UTF-16 offsets they miss the link.
  expect(fullText.slice(...link.indices)).not.toBe(link.url);
  expect(
    Array.from(fullText)
      .slice(...link.indices)
      .join(""),
  ).toBe(link.url);

  const bookmark = bookmarksOf(fixture("text-posts"))[2];

  expect(bookmark?.links).toEqual([
    {
      url: link.expanded_url,
      shortUrl: link.url,
      displayUrl: link.display_url,
    },
  ]);
  expect(link.expanded_url).toMatch(/^https:\/\/site7\.example\//);
  expect(bookmark?.text.endsWith(` d${link.expanded_url}`)).toBe(true);
  expect(bookmark?.text).toContain("\u{1F516}");
  expect(bookmark?.text).not.toContain("t.co");
});

test("the link X appends for a post's own media is not part of its text", () => {
  const raw = rawValue("media", 1, "legacy.full_text");
  expect(raw).toMatch(/ ?https:\/\/t\.co\/\w+$/);

  for (const bookmark of bookmarksOf(fixture("media"))) {
    expect(bookmark.media.length).toBeGreaterThan(0);
    expect(bookmark.text).not.toContain("https://t.co/");
  }
});

test("the link to media first posted by someone else sits inside the displayed range, and is still not text", () => {
  const post = rawPost("shared-media", 0);
  const media = at(post, "legacy.entities.media.0") as {
    url: string;
    indices: [number, number];
    source_status_id_str: string;
  };
  const [, end] = at(post, "legacy.display_text_range") as [number, number];
  expect(media.source_status_id_str).toMatch(/^[0-9]+$/);
  expect(media.indices[1]).toBe(end);

  const [shared] = bookmarksOf(fixture("shared-media"));

  expect(shared?.media).toMatchObject([{ type: "video" }]);
  expect(shared?.text).not.toContain("https://t.co/");
  expect(Array.from(shared?.text ?? "")).toHaveLength(media.indices[0]);

  // With the space X puts before such a link, which the redacted text lacks.
  const json = JSON.parse(fixture("shared-media"));
  const legacy =
    json.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content
      .itemContent.tweet_results.result.legacy;
  legacy.full_text = `caf\u00e9 &amp; more ${media.url}`;
  legacy.display_text_range = [0, 39];
  expect(bookmarksOf(JSON.stringify(json))[0]?.text).toBe("caf\u00e9 & more");
});

/** A media item of a raw post, as the parser should read it when it is a photo. */
function rawPhoto(shows: string, index: number, item: number) {
  const media = at(
    rawPost(shows, index),
    `legacy.extended_entities.media.${item}`,
  ) as {
    media_url_https: string;
    original_info: { width: number; height: number };
    ext_alt_text?: string;
  };
  return {
    type: "photo",
    imageUrl: media.media_url_https,
    width: media.original_info.width,
    height: media.original_info.height,
    altText: media.ext_alt_text ?? null,
    videoUrl: null,
    durationMs: null,
  };
}

test("a photo is read with its size and the description its author gave it", () => {
  const described = theBookmark("media", (bookmark) =>
    bookmark.media.some((item) => item.altText !== null),
  );

  expect(described.media).toEqual([rawPhoto("media", 2, 0)]);
  expect(described.media[0]).toMatchObject({
    imageUrl: expect.stringMatching(
      /^https:\/\/pbs\.twimg\.com\/media\/[\w-]+\.png$/,
    ),
    width: expect.any(Number),
    altText: "lorem ipsum dol",
  });
});

test("every photo of a post with several is kept, in order", () => {
  const four = theBookmark("media", (bookmark) => bookmark.media.length === 4);

  expect(four.media).toEqual(
    [0, 1, 2, 3].map((item) => rawPhoto("media", 3, item)),
  );
  expect(new Set(four.media.map(({ imageUrl }) => imageUrl)).size).toBe(4);
});

test("a video is read as its poster frame, its length, and its MP4 at the highest bitrate", () => {
  const media = at(rawPost("media", 0), "legacy.extended_entities.media.0") as {
    media_url_https: string;
    video_info: {
      duration_millis: number;
      variants: { bitrate?: number; content_type: string; url: string }[];
    };
  };
  const mp4s = media.video_info.variants.filter(
    ({ content_type }) => content_type === "video/mp4",
  );
  expect(mp4s.length).toBeGreaterThan(1);
  expect(media.video_info.variants.length).toBeGreaterThan(mp4s.length);
  const best = mp4s.reduce((a, b) =>
    (b.bitrate ?? 0) > (a.bitrate ?? 0) ? b : a,
  );

  const video = theBookmark("media", (bookmark) =>
    bookmark.media.some((item) => item.type === "video"),
  );

  expect(video.media).toEqual([
    {
      ...rawPhoto("media", 0, 0),
      type: "video",
      videoUrl: best.url,
      durationMs: media.video_info.duration_millis,
    },
  ]);
  expect(video.media[0]?.videoUrl).toMatch(
    /^https:\/\/video\.twimg\.com\/amplify_video\/\d+\/vid\/avc1\/.+\.mp4\?tag=\d+$/,
  );
});

test("an animated GIF is read as its poster frame and its MP4, and has no length", () => {
  const media = at(
    rawPost("animated-gif", 0),
    "legacy.extended_entities.media.0",
  ) as {
    video_info: { variants: { url: string }[]; duration_millis?: number };
  };
  expect(media.video_info.duration_millis).toBeUndefined();
  expect(media.video_info.variants).toHaveLength(1);

  const [gif] = bookmarksOf(fixture("animated-gif"));

  expect(gif?.media).toEqual([
    {
      ...rawPhoto("animated-gif", 0, 0),
      type: "animated_gif",
      videoUrl: media.video_info.variants[0]?.url,
      durationMs: null,
    },
  ]);
});

test("a long-form post is read in full, from note_tweet and not from the excerpt beside it", () => {
  const bookmarks = bookmarksOf(fixture("long-posts"));
  expect(bookmarks).toHaveLength(4);

  for (const [index, bookmark] of bookmarks.entries()) {
    const note = at(
      rawPost("long-posts", index),
      "note_tweet.note_tweet_results.result",
    );
    const links = at(note, "entity_set.urls") as { url: string }[];

    // The whole note: the same text once each link is put back in its short form.
    const shortened = bookmark.links.reduce(
      (body, link) => body.replaceAll(link.url, link.shortUrl),
      bookmark.text,
    );
    expect(shortened).toBe(at(note, "text"));
    expect(bookmark.links.map(({ shortUrl }) => shortUrl)).toEqual(
      links.map(({ url }) => url),
    );
    expect(bookmark.text).not.toContain("https://t.co/");
  }
  expect(Array.from(bookmarks[1]?.text ?? "")).toHaveLength(1833);
  expect(rawValue("long-posts", 1, "legacy.full_text").length).toBeLessThan(
    400,
  );
});

test("a long-form post's link card is matched to a link that only its full text names", () => {
  const post = rawPost("long-posts", 3);
  const noteLink = at(
    post,
    "note_tweet.note_tweet_results.result.entity_set.urls.0",
  ) as {
    url: string;
    expanded_url: string;
    display_url: string;
  };
  expect(at(post, "legacy.entities.urls")).toBeUndefined();
  expect(at(post, "card.rest_id")).toBe(noteLink.url);

  const withCard = theBookmark(
    "long-posts",
    (bookmark) => bookmark.card !== null,
  );

  expect(withCard.card?.url).toBe(noteLink.expanded_url);
  expect(withCard.links).toEqual([
    {
      url: noteLink.expanded_url,
      shortUrl: noteLink.url,
      displayUrl: noteLink.display_url,
    },
  ]);
});

/** The string a card's binding holds, in the raw fixture. */
function rawBinding(shows: string, index: number, key: string): unknown {
  const bindings = at(rawPost(shows, index), "card.legacy.binding_values") as {
    key: string;
    value: { string_value?: string; image_value?: { url: string } };
  }[];
  const { value } = bindings.find((binding) => binding.key === key) ?? {};
  return value?.string_value ?? value?.image_value?.url;
}

test("a link card is read with where it leads, its title, description, site and image", () => {
  const bookmarks = bookmarksOf(fixture("links-and-cards"));

  expect(bookmarks.map(({ card }) => card?.name ?? null)).toEqual([
    null,
    "summary_large_image",
    "player",
    null,
    "summary_large_image",
  ]);
  expect(bookmarks[1]?.card).toEqual({
    name: "summary_large_image",
    url: bookmarks[1]?.links[0]?.url,
    title:
      "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labo",
    description:
      "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt",
    domain: "site4.example",
    imageUrl: rawBinding("links-and-cards", 1, "thumbnail_image_original"),
  });
  expect(bookmarks[1]?.card?.url).toMatch(/^https:\/\/site4\.example\//);
  expect(bookmarks[1]?.card?.imageUrl).toMatch(
    /^https:\/\/pbs\.twimg\.com\/card_img\/\d+\/\w+\?format=jpg&name=orig$/,
  );
  expect(bookmarks[2]?.card).toEqual({
    name: "player",
    url: bookmarks[2]?.links[0]?.url,
    title: rawBinding("links-and-cards", 2, "title"),
    description: rawBinding("links-and-cards", 2, "description"),
    domain: "site9.example",
    imageUrl: rawBinding("links-and-cards", 2, "player_image_original"),
  });
  // Of a post's two links, the card belongs to the one it names.
  expect(bookmarks[4]?.links).toHaveLength(2);
  expect(bookmarks[4]?.card?.url).toBe(bookmarks[4]?.links[0]?.url);
  expect(rawBinding("links-and-cards", 4, "card_url")).toBe(
    bookmarks[4]?.links[0]?.shortUrl,
  );
});

test("a small link card is read like a large one, with or without an image", () => {
  const [withImage, withoutImage] = bookmarksOf(fixture("summary-cards"));
  expect(
    rawBinding("summary-cards", 1, "thumbnail_image_original"),
  ).toBeUndefined();

  expect(withImage?.card).toEqual({
    name: "summary",
    url: withImage?.links[0]?.url,
    title: rawBinding("summary-cards", 0, "title"),
    description: rawBinding("summary-cards", 0, "description"),
    domain: rawBinding("summary-cards", 0, "domain"),
    imageUrl: rawBinding("summary-cards", 0, "thumbnail_image_original"),
  });
  expect(withImage?.card?.imageUrl).toMatch(
    /^https:\/\/pbs\.twimg\.com\/card_img\//,
  );
  expect(withoutImage?.card).toMatchObject({
    name: "summary",
    url: withoutImage?.links[0]?.url,
    title: expect.stringMatching(/^lorem ipsum/),
    imageUrl: null,
  });
});

test("a card layout no parser reads yet leaves the card empty and says which layout it was", () => {
  const entries = entriesOf(fixture("cards-not-read-yet"));
  const names = [0, 1].map((index) =>
    rawValue("cards-not-read-yet", index, "card.legacy.name"),
  );
  expect(names).toEqual([
    expect.stringMatching(/^[0-9]+:broadcast$/),
    "unified_card",
  ]);

  expect(entries).toMatchObject([
    {
      kind: "bookmark",
      bookmark: { card: null, links: [{ shortUrl: expect.any(String) }] },
      warnings: [
        {
          code: "unknown-variant",
          path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].${POST}.card.legacy.name`,
          // An id inside a layout's name is not repeated.
          detail:
            'expected one of summary, summary_large_image, player; found "#:broadcast"',
        },
      ],
    },
    {
      kind: "bookmark",
      bookmark: { card: null },
      warnings: [
        {
          code: "unknown-variant",
          path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.card.legacy.name`,
          detail:
            'expected one of summary, summary_large_image, player; found "unified_card"',
        },
      ],
    },
  ]);
});

test("a card that X sends as an id alone reads as no card, without complaint", () => {
  expect(
    Object.keys(at(rawPost("links-and-cards", 0), "card") as object),
  ).toEqual(["rest_id"]);

  const [entry] = entriesOf(fixture("links-and-cards"));

  expect(entry).toMatchObject({
    kind: "bookmark",
    warnings: [],
    bookmark: { card: null },
  });
});

test("an X Article is read as its title and excerpt, which is all the timeline carries", () => {
  const raw = "article.article_results.result";
  const id = rawValue("links-and-cards", 3, `${raw}.rest_id`);

  const article = theBookmark(
    "links-and-cards",
    (bookmark) => bookmark.article !== null,
  );

  expect(article).toMatchObject({
    text: `https://x.com/i/article/${id}`,
    card: null,
    article: {
      id,
      title: "lorem ipsum dolor sit amet consectetur adipisc",
      previewText: expect.stringMatching(/^lorem ipsum dolor sit amet/),
      coverImageUrl: rawValue(
        "links-and-cards",
        3,
        `${raw}.cover_media.media_info.original_img_url`,
      ),
    },
  });
  expect(Array.from(article.article?.previewText ?? "")).toHaveLength(199);
});

test("a post without a view count, as old posts are sent, has none", () => {
  expect(at(rawPost("no-view-count", 0), "views")).toEqual({
    state: "Enabled",
  });

  const [entry] = entriesOf(fixture("no-view-count"));

  expect(entry).toMatchObject({
    kind: "bookmark",
    warnings: [],
    bookmark: { viewCount: null, likeCount: expect.any(Number) },
  });
});

test("a quoted post is read like any post, one level deep", () => {
  const quotedOf = (index: number, path: string) =>
    rawValue("quoted-posts", index, `quoted_status_result.result.${path}`);
  const [quoteOfQuote, plain, , , withArticle] = bookmarksOf(
    fixture("quoted-posts"),
  );

  expect(plain?.quoted).toMatchObject({
    available: true,
    postId: quotedOf(1, "rest_id"),
    authorId: quotedOf(1, "core.user_results.result.rest_id"),
    authorHandle: quotedOf(1, "core.user_results.result.core.screen_name"),
    postedAt: new Date("2026-01-01T10:00:00.000Z"),
    links: [{ shortUrl: expect.stringContaining("https://t.co/") }],
    media: [],
    quotedPostId: null,
  });
  expect(plain?.quoted?.postId).toBe(
    rawValue("quoted-posts", 1, "legacy.quoted_status_id_str"),
  );
  expect(plain?.quoted).not.toHaveProperty("quoted");
  // The post two levels down is in the payload in full, and kept as an id.
  expect(quoteOfQuote?.quoted).toMatchObject({
    available: true,
    postId: quotedOf(0, "rest_id"),
    quotedPostId: quotedOf(0, "nested_quoted_tweet_results.result.rest_id"),
    media: [{ type: "video" }],
  });
  expect(withArticle?.quoted).toMatchObject({
    available: true,
    text: `lorem ip>dolor sit amet chttps://x.com/i/article/${quotedOf(4, "article.article_results.result.rest_id")}`,
    article: { id: quotedOf(4, "article.article_results.result.rest_id") },
  });
});

test.each([
  [
    "an unavailable marker",
    "quoted-posts",
    3,
    { __typename: "TweetUnavailable" },
  ],
  ["a tombstone", "withheld-posts", 2, { __typename: "TweetTombstone" }],
  ["nothing", "withheld-posts", 1, undefined],
])(
  "a quoted post X replaced with %s is kept by its id, and the bookmark is kept whole",
  (_, shows, index, placeholder) => {
    const holder = at(rawPost(shows, index), "quoted_status_result");
    if (placeholder === undefined) expect(holder).toEqual({});
    else expect(at(holder, "result")).toMatchObject(placeholder);

    const entry = entriesOf(fixture(shows))[index];

    expect(entry).toMatchObject({
      kind: "bookmark",
      warnings: [],
      bookmark: {
        postId: rawValue(shows, index, "rest_id"),
        quoted: {
          available: false,
          postId: rawValue(shows, index, "legacy.quoted_status_id_str"),
        },
      },
    });
  },
);

test("a bookmark whose post X withholds is reported by the id in its entry, with what X sent instead", () => {
  const raws = rawEntries("withheld-posts");
  expect(at(raws[0], `${POST}.__typename`)).toBe("TweetTombstone");
  expect(at(raws[3], "content.itemContent.tweet_results")).toEqual({});

  const entries = entriesOf(fixture("withheld-posts"));

  expect(entries.map(({ kind }) => kind)).toEqual([
    "unavailable",
    "bookmark",
    "bookmark",
    "unavailable",
  ]);
  expect(entries[0]).toEqual({
    kind: "unavailable",
    index: 0,
    path: "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[0]",
    entryId: at(raws[0], "entryId"),
    postId: String(at(raws[0], "entryId")).replace("tweet-", ""),
    withheldAt: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].${POST}`,
    detail: "X sent a TweetTombstone",
  });
  expect(entries[3]).toMatchObject({
    kind: "unavailable",
    postId: String(at(raws[3], "entryId")).replace("tweet-", ""),
    detail: "no result was sent",
  });
});

test("a post inside a visibility wrapper is read as the post it wraps", () => {
  const [raw] = rawEntries("visibility-wrapper");
  expect(at(raw, `${POST}.__typename`)).toBe("TweetWithVisibilityResults");
  expect(at(raw, `${POST}.rest_id`)).toBeUndefined();

  const [entry] = entriesOf(fixture("visibility-wrapper"));

  expect(entry).toMatchObject({
    kind: "bookmark",
    entryId: `tweet-${rawValue("visibility-wrapper", 0, "rest_id")}`,
    warnings: [],
    bookmark: {
      postId: rawValue("visibility-wrapper", 0, "rest_id"),
      authorHandle: rawValue(
        "visibility-wrapper",
        0,
        "core.user_results.result.core.screen_name",
      ),
      media: [{ type: "photo" }, { type: "photo" }],
    },
  });
});

// --- When X changes a shape ------------------------------------------------

test("a payload that is not JSON, or not a bookmarks timeline, fails as a whole and says where", () => {
  expect(parseBookmarks("<html>Rate limit exceeded</html>")).toEqual({
    outcome: "failed",
    issue: { code: "not-json", path: "$", detail: "the payload is not JSON" },
  });
  expect(
    parseBookmarks('{"errors":[{"message":"Over capacity","code":130}]}'),
  ).toEqual({
    outcome: "failed",
    issue: {
      code: "missing-field",
      path: "$.data",
      detail: "the field is absent; its parent has fields: errors",
    },
  });
});

test("a renamed field fails the capture with the names now beside where it was", () => {
  const json = JSON.parse(fixture("text-posts"));
  json.data.bookmark_timeline_v3 = json.data.bookmark_timeline_v2;
  delete json.data.bookmark_timeline_v2;

  expect(parseBookmarks(JSON.stringify(json))).toEqual({
    outcome: "failed",
    issue: {
      code: "missing-field",
      path: "$.data.bookmark_timeline_v2",
      detail:
        "the field is absent; its parent has fields: bookmark_timeline_v3",
    },
  });
});

test.each([
  [
    "an entry of a kind not seen before",
    "content.entryType",
    "TimelineTimelineModule",
    {
      code: "unknown-variant",
      path: "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].content.entryType",
      detail:
        'expected one of TimelineTimelineItem, TimelineTimelineCursor; found "TimelineTimelineModule"',
    },
  ],
  [
    "a result of a type not seen before",
    `${POST}.__typename`,
    "TweetPreview",
    {
      code: "unknown-variant",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.__typename`,
      detail:
        'expected one of Tweet, TweetWithVisibilityResults, TweetTombstone, TweetUnavailable; found "TweetPreview"',
    },
  ],
  [
    "the text moved elsewhere",
    `${POST}.legacy.full_text`,
    undefined,
    {
      code: "missing-field",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.legacy.full_text`,
      detail: expect.stringMatching(
        /^the field is absent; its parent has fields: .*\bcreated_at\b.*\bid_str\b/,
      ),
    },
  ],
  [
    "the author replaced by a placeholder",
    `${POST}.core.user_results.result`,
    { __typename: "UserUnavailable" },
    {
      code: "unknown-variant",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.core.user_results.result.__typename`,
      detail: 'expected one of User; found "UserUnavailable"',
    },
  ],
  [
    "the post id sent as a number, which cannot hold it",
    `${POST}.rest_id`,
    9.982854896622834e18,
    {
      code: "wrong-type",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.rest_id`,
      detail: "expected string, found number",
    },
  ],
  [
    "a time in another format",
    `${POST}.legacy.created_at`,
    "2026-01-01T06:00:00.000Z",
    {
      code: "invalid-value",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.legacy.created_at`,
      detail: "expected a time written like Wed Oct 10 20:19:24 +0000 2018",
    },
  ],
  [
    "a display range that no longer fits the text",
    `${POST}.legacy.display_text_range`,
    [0, 5000],
    {
      code: "invalid-value",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.legacy.display_text_range`,
      detail: "expected a start and an end within the text",
    },
  ],
])(
  "an entry with %s fails alone, says where, and the entries around it are still read",
  (_, path, value, issue) => {
    const entries = entriesOf(
      changed("text-posts", `${ENTRIES}.1.${path}`, value),
    );

    expect(entries.map(({ kind }) => kind)).toEqual([
      "bookmark",
      "failed",
      "bookmark",
      "bookmark",
      "bookmark",
    ]);
    expect(entries[1]).toEqual({
      kind: "failed",
      index: 1,
      path: "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1]",
      entryId: `tweet-${rawValue("text-posts", 1, "rest_id")}`,
      postId: rawValue("text-posts", 1, "rest_id"),
      issue,
    });
  },
);

test.each([
  ["a tombstone", { __typename: "TweetTombstone" }, "X sent a TweetTombstone"],
  [
    "an unavailable marker",
    { __typename: "TweetUnavailable" },
    "X sent a TweetUnavailable",
  ],
  ["no result at all", undefined, "no result was sent"],
])(
  "a bookmark whose post X replaced with %s is reported as withheld, by the id in its entry",
  (_, result, detail) => {
    const entries = entriesOf(
      changed("text-posts", `${ENTRIES}.1.${POST}`, result),
    );

    expect(entries[1]).toEqual({
      kind: "unavailable",
      index: 1,
      path: "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1]",
      entryId: `tweet-${rawValue("text-posts", 1, "rest_id")}`,
      postId: rawValue("text-posts", 1, "rest_id"),
      withheldAt: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}`,
      detail,
    });
    expect(entries.filter(({ kind }) => kind === "bookmark")).toHaveLength(4);
  },
);

test.each([
  [
    "media of a new type",
    "media",
    `${ENTRIES}.0.${POST}.legacy.extended_entities.media.0.type`,
    "audio_space",
    { media: [] },
    {
      code: "unknown-variant",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].${POST}.legacy.extended_entities.media[0].type`,
      detail: 'expected one of photo, video, animated_gif; found "audio_space"',
    },
  ],
  [
    "a video without an MP4",
    "media",
    `${ENTRIES}.0.${POST}.legacy.extended_entities.media.0.video_info.variants`,
    [{ content_type: "application/x-mpegURL", url: "https://example.com/v" }],
    { media: [] },
    {
      code: "invalid-value",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].${POST}.legacy.extended_entities.media[0].video_info.variants`,
      detail: "expected at least one video/mp4",
    },
  ],
  [
    "a card layout not seen before",
    "links-and-cards",
    `${ENTRIES}.1.${POST}.card.legacy.name`,
    "poll4choice_text_only",
    { card: null },
    {
      code: "unknown-variant",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.card.legacy.name`,
      detail:
        'expected one of summary, summary_large_image, player; found "poll4choice_text_only"',
    },
  ],
  [
    "a count that is no longer a number",
    "links-and-cards",
    `${ENTRIES}.1.${POST}.legacy.favorite_count`,
    "1.2K",
    {
      likeCount: null,
      repostCount: null,
      replyCount: null,
      quoteCount: null,
      bookmarkCount: null,
    },
    {
      code: "wrong-type",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.legacy.favorite_count`,
      detail: "expected number, found string",
    },
  ],
  [
    "an article without its title",
    "links-and-cards",
    `${ENTRIES}.3.${POST}.article.article_results.result.title`,
    undefined,
    { article: null },
    {
      code: "missing-field",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[3].${POST}.article.article_results.result.title`,
      detail: expect.stringContaining("preview_text"),
    },
  ],
  [
    "a quoted post of a type not seen before",
    "quoted-posts",
    `${ENTRIES}.1.${POST}.quoted_status_result.result.__typename`,
    "TweetPreview",
    { quoted: null },
    {
      code: "unknown-variant",
      path: `$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].${POST}.quoted_status_result.result.__typename`,
      detail: expect.stringContaining('found "TweetPreview"'),
    },
  ],
  [
    "a sort index that is not a number in a string",
    "quoted-posts",
    `${ENTRIES}.1.sortIndex`,
    1.8667391680520233e18,
    { sortIndex: null },
    {
      code: "wrong-type",
      path: "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1].sortIndex",
      detail: "expected string, found number",
    },
  ],
])(
  "a post with %s is still a bookmark, with that part left empty and a warning saying where",
  (_, shows, path, value, empty, issue) => {
    const index = Number(path.slice(ENTRIES.length + 1).split(".")[0]);
    const untouched = entriesOf(fixture(shows))[index];

    const entry = entriesOf(changed(shows, path, value))[index];

    expect(entry).toMatchObject({ kind: "bookmark", warnings: [issue] });
    if (entry?.kind !== "bookmark" || untouched?.kind !== "bookmark") {
      throw new Error("expected bookmarks");
    }
    expect(entry.bookmark).toEqual({ ...untouched.bookmark, ...empty });
  },
);

test("an instruction of a kind not seen before is reported, and the entries beside it are still read", () => {
  const json = JSON.parse(fixture("text-posts"));
  json.data.bookmark_timeline_v2.timeline.instructions.unshift({
    type: "TimelineClearCache",
  });

  const parsed = parseBookmarks(JSON.stringify(json));

  expect(parsed).toMatchObject({
    outcome: "parsed",
    warnings: [
      {
        code: "unknown-variant",
        path: "$.data.bookmark_timeline_v2.timeline.instructions[0].type",
        detail:
          'expected one of TimelineAddEntries; found "TimelineClearCache"',
      },
    ],
  });
  expect(bookmarksOf(JSON.stringify(json))).toHaveLength(5);
});

test("an issue describes structure and never quotes the response", () => {
  const secret = "a private thought, 4111 1111 1111 1111";
  const payloads = [
    changed("text-posts", `${ENTRIES}.1.${POST}.legacy.created_at`, secret),
    changed("text-posts", `${ENTRIES}.1.${POST}.__typename`, secret),
    changed("text-posts", `${ENTRIES}.1.${POST}.rest_id`, secret),
    changed("text-posts", `${ENTRIES}.1.${POST}.legacy`, { [secret]: secret }),
    changed("text-posts", `${ENTRIES}.1.${POST}.legacy.lang`, { [secret]: 1 }),
    changed(
      "media",
      `${ENTRIES}.0.${POST}.legacy.extended_entities.media.0.type`,
      secret,
    ),
    changed("text-posts", "data", { [secret]: secret }),
    `{"data": "${secret}`,
  ];

  for (const payload of payloads) {
    const parsed = parseBookmarks(payload);
    const reported = JSON.stringify(parsed, (key, value) =>
      key === "bookmark" ? undefined : value,
    );

    expect(reported).toMatch(/"code":"/);
    expect(reported).not.toContain("private");
    expect(reported).not.toContain("4111");
  }
});
