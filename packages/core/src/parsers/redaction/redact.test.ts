import { expect, test } from "vitest";
import { parseBookmarks } from "../x-web-client/Bookmarks.ts";
import { createRedactor } from "./redact.ts";
import { INVENTED, inventedCapture } from "./sample.ts";

function at(json: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, step) => (value as Record<string, unknown> | undefined)?.[step],
      json,
    );
}

const ENTRY = "data.bookmark_timeline_v2.timeline.instructions.0.entries.0";
const POST = `${ENTRY}.content.itemContent.tweet_results.result`;

function redacted(seed?: number): unknown {
  return createRedactor(seed).redact(structuredClone(inventedCapture));
}

test("nothing that identifies a post, its author or its links survives redaction", () => {
  const text = JSON.stringify(redacted());

  for (const real of [
    INVENTED.postId,
    INVENTED.authorId,
    INVENTED.handle,
    INVENTED.handle.toLowerCase(),
    INVENTED.mentioned,
    INVENTED.name,
    "AbCdEf1234",
    "ZyXwVu9876",
    INVENTED.site,
    "a-post",
    "about-me",
    "Secret",
    "café",
    "read this",
    "Some Friend",
    "Somephone",
    "Qw3rTy",
    "GsEcReTiMaGe",
    "1790000000000000001",
    "55500011122",
    "HBaAgLDRn4yXzzQAAA",
    "1861891119789912064",
    "48213",
    "1234",
    "1920",
    "Apr 08",
    "2015",
    '"tr"',
    Buffer.from(`User:${INVENTED.authorId}`).toString("base64"),
  ]) {
    expect(text, real).not.toContain(real);
  }
});

test("structure survives: field names, type names, flags, and the shape of every value", () => {
  const out = redacted();
  const shapeOf = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(shapeOf)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, shapeOf(item)]),
          )
        : typeof value;

  expect(shapeOf(out)).toEqual(shapeOf(inventedCapture));
  expect(at(out, `${POST}.__typename`)).toBe("Tweet");
  expect(at(out, `${ENTRY}.content.entryType`)).toBe("TimelineTimelineItem");
  expect(at(out, `${POST}.views.state`)).toBe("EnabledWithCount");
  expect(at(out, `${POST}.legacy.extended_entities.media.0.type`)).toBe(
    "photo",
  );
  expect(at(out, `${POST}.legacy.bookmarked`)).toBe(true);
  expect(at(out, `${POST}.legacy.lang`)).toBe("en");
});

test("a text keeps its length and its offsets, so every entity still sits where its indices say", () => {
  const legacy = at(redacted(), `${POST}.legacy`);
  const text = Array.from(String(at(legacy, "full_text")));

  expect(text).toHaveLength(Array.from(INVENTED.text).length);
  const slice = (path: string) => {
    const [start, end] = at(legacy, `${path}.indices`) as [number, number];
    return text.slice(start, end).join("");
  };
  expect(slice("entities.urls.0")).toBe(at(legacy, "entities.urls.0.url"));
  expect(slice("extended_entities.media.0")).toBe(
    at(legacy, "extended_entities.media.0.url"),
  );
  expect(slice("entities.user_mentions.0")).toBe(
    `@${at(legacy, "entities.user_mentions.0.screen_name")}`,
  );
  expect(slice("entities.hashtags.0")).toBe(
    `#${at(legacy, "entities.hashtags.0.text")}`,
  );
  // The escape and the two-unit character keep their places too.
  expect(text.slice(29, 34).join("")).toBe("&amp;");
  expect(text[17]).toBe("\u{1F516}");
  expect(at(legacy, "display_text_range")).toEqual([12, 71]);
});

test("the same real value becomes the same invented one wherever it appears", () => {
  const out = redacted();
  const postId = at(out, `${POST}.rest_id`);
  const handle = String(
    at(out, `${POST}.core.user_results.result.core.screen_name`),
  );
  const authorId = String(at(out, `${POST}.core.user_results.result.rest_id`));

  expect(postId).toMatch(/^[1-9][0-9]{18}$/);
  expect(at(out, `${POST}.legacy.id_str`)).toBe(postId);
  expect(at(out, `${ENTRY}.entryId`)).toBe(`tweet-${postId}`);
  expect(at(out, `${POST}.legacy.user_id_str`)).toBe(authorId);
  expect(
    Buffer.from(
      String(at(out, `${POST}.core.user_results.result.id`)),
      "base64",
    ).toString(),
  ).toBe(`User:${authorId}`);
  expect(handle).toMatch(/^[a-z]{12}$/);
  expect(at(out, `${POST}.legacy.extended_entities.media.0.expanded_url`)).toBe(
    `https://x.com/${handle}/status/${postId}/photo/1`,
  );
  expect(at(out, `${POST}.legacy.in_reply_to_screen_name`)).toBe(
    at(out, `${POST}.legacy.entities.user_mentions.0.screen_name`),
  );
});

test("links keep X's own hosts and path words, and lose everything else", () => {
  const out = redacted();

  expect(at(out, `${POST}.core.user_results.result.avatar.image_url`)).toMatch(
    /^https:\/\/pbs\.twimg\.com\/profile_images\/[0-9]{19}\/[A-Za-z0-9]{6}_normal\.jpg$/,
  );
  expect(
    at(out, `${POST}.legacy.extended_entities.media.0.media_url_https`),
  ).toMatch(/^https:\/\/pbs\.twimg\.com\/media\/[A-Za-z]{12}\.jpg$/);
  expect(at(out, `${POST}.legacy.entities.urls.0.expanded_url`)).toMatch(
    /^https:\/\/site1\.example\/[a-z]-[a-z]{4}\/[a-z]{5}-[a-z]{2}\?[a-z]{3}=42$/,
  );
  expect(at(out, `${POST}.legacy.entities.urls.0.display_url`)).toMatch(
    /^site1\.example\/[a-z]-[a-z]{4}…$/,
  );
  expect(at(out, `${POST}.legacy.entities.urls.0.url`)).toMatch(
    /^https:\/\/t\.co\/[A-Za-z0-9]{10}$/,
  );
  expect(at(out, `${POST}.source`)).toBe(
    '<a href="https://example.com" rel="nofollow">Example Client</a>',
  );
});

test("times are invented, with each sort index still decoding to a time after every post's", () => {
  const out = redacted();
  const posted = String(at(out, `${POST}.legacy.created_at`));
  const entries = at(
    out,
    "data.bookmark_timeline_v2.timeline.instructions.0.entries",
  ) as { entryId: string; sortIndex: string }[];
  const bookmarkedAt = entries.map(({ sortIndex }) =>
    Number(BigInt(sortIndex) >> 20n),
  );

  expect(posted).toMatch(/^Thu Jan 01 0\d:00:00 \+0000 2026$/);
  expect(bookmarkedAt).toEqual([
    Date.UTC(2026, 4, 31, 23),
    Date.UTC(2026, 4, 31, 22),
  ]);
  expect(entries[1]?.entryId).toBe(`cursor-bottom-${entries[1]?.sortIndex}`);
});

test("a redacted response parses exactly as the real one does, shape for shape", () => {
  const real = parseBookmarks(JSON.stringify(inventedCapture));
  const fake = parseBookmarks(JSON.stringify(redacted()));
  // Every text and every number by its type alone; everything else as it is.
  const shape = (parsed: unknown) =>
    JSON.parse(
      JSON.stringify(parsed, (_, value) =>
        ["string", "number"].includes(typeof value) ? typeof value : value,
      ),
    );

  expect(real).toMatchObject({
    outcome: "parsed",
    entries: [
      {
        kind: "bookmark",
        warnings: [],
        bookmark: {
          text: `caf\u00e9 \u{1F600} read this & that https://${INVENTED.site}/a-post/about-me?ref=42 #Secret`,
          media: [{ type: "photo" }],
        },
      },
    ],
  });
  expect(shape(fake)).toEqual(shape(real));
});

test("redaction is repeatable, and depends on its seed alone", () => {
  expect(redacted(7)).toEqual(redacted(7));
  expect(redacted(7)).not.toEqual(redacted(8));
});

test("a text that only starts with a link is redacted as text, link by link", () => {
  const out = createRedactor().redact({
    description: "https://t.co/AbCdEf1234\nhttps://t.co/ZyXwVu9876 and more",
  });

  expect(at(out, "description")).toMatch(
    /^https:\/\/t\.co\/[A-Za-z0-9]{10}.https:\/\/t\.co\/[A-Za-z0-9]{10}[a-z ]{9}$/,
  );
  expect(JSON.stringify(out)).not.toMatch(/AbCdEf1234|ZyXwVu9876/);
});

test("a field name that could be data stops the redaction", () => {
  expect(() =>
    createRedactor().redact({ users: { "44196397001": { name: "x" } } }),
  ).toThrow(/does not look like a name from X's schema/);
});
