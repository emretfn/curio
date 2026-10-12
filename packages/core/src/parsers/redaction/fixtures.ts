/**
 * Which entries of the real captures become fixtures. Each fixture is a real
 * response cut down to the entries that show one family of shapes, then
 * redacted. An entry is chosen by what it shows, never by which post it is:
 * for each pick, the first entry in replay order that matches.
 */
import { createRedactor } from "./redact.ts";

/** Reads into an untyped JSON value. Undefined as soon as a step is missing. */
function at(value: unknown, ...steps: (string | number)[]): unknown {
  let current = value;
  for (const step of steps) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

function list(value: unknown, ...steps: (string | number)[]): unknown[] {
  const found = at(value, ...steps);
  return Array.isArray(found) ? found : [];
}

const has = (value: unknown, ...steps: (string | number)[]) =>
  at(value, ...steps) !== undefined;

/** The post of a timeline entry, taken out of its visibility wrapper when it has one. */
function postOf(entry: unknown): unknown {
  const result = at(entry, "content", "itemContent", "tweet_results", "result");
  return at(result, "__typename") === "TweetWithVisibilityResults"
    ? at(result, "tweet")
    : result;
}

const fullText = (post: unknown) =>
  String(at(post, "legacy", "full_text") ?? "");
const media = (post: unknown) =>
  list(post, "legacy", "extended_entities", "media");
const links = (post: unknown) => list(post, "legacy", "entities", "urls");
const quoted = (post: unknown) => at(post, "quoted_status_result", "result");
const note = (post: unknown) =>
  at(post, "note_tweet", "note_tweet_results", "result");
const isReply = (post: unknown) =>
  has(post, "legacy", "in_reply_to_status_id_str");
const hasCard = (post: unknown) => has(post, "card", "legacy");
const cardName = (post: unknown) => at(post, "card", "legacy", "name");
const isQuote = (post: unknown) =>
  at(post, "legacy", "is_quote_status") === true;
const cardBindings = (post: unknown) =>
  list(post, "card", "legacy", "binding_values").map((binding) =>
    at(binding, "key"),
  );

/** Whether a link sits after a character outside the Basic Multilingual Plane, where UTF-16 offsets and code point offsets part. */
function hasLinkAfterAstral(post: unknown): boolean {
  const text = fullText(post);
  return links(post).some((link) => {
    const start = Number(at(link, "indices", 0));
    return text.slice(start, start + 8) !== "https://";
  });
}

type Shape = (post: unknown, entry: unknown) => boolean;

/** A shape variant: something a response can look like that a parser has to handle. */
interface Variant {
  label: string;
  matches: Shape;
}

const wrapped: Shape = (_, entry) =>
  at(
    entry,
    "content",
    "itemContent",
    "tweet_results",
    "result",
    "__typename",
  ) === "TweetWithVisibilityResults";
const plain: Shape = (post) =>
  media(post).length === 0 &&
  links(post).length === 0 &&
  !has(post, "card") &&
  !has(post, "note_tweet") &&
  !has(post, "article") &&
  !isQuote(post) &&
  !isReply(post);

/**
 * The variants counted in the census, which says how much of each the real
 * captures hold. The fixtures below pick from these and from combinations.
 */
export const VARIANTS: readonly Variant[] = [
  { label: "text only", matches: plain },
  { label: "reply", matches: isReply },
  {
    label: "reply whose leading @handles are outside the displayed text",
    matches: (post) => Number(at(post, "legacy", "display_text_range", 0)) > 0,
  },
  {
    label: "HTML-escaped character in the text",
    matches: (post) => /&(amp|lt|gt);/.test(fullText(post)),
  },
  { label: "link after a non-BMP character", matches: hasLinkAfterAstral },
  {
    label: "edited post",
    matches: (post) => has(post, "edit_control", "edit_control_initial"),
  },
  { label: "media", matches: (post) => media(post).length > 0 },
  {
    label: "photo",
    matches: (post) => media(post).some((item) => at(item, "type") === "photo"),
  },
  {
    label: "video",
    matches: (post) => media(post).some((item) => at(item, "type") === "video"),
  },
  {
    label: "animated GIF",
    matches: (post) =>
      media(post).some((item) => at(item, "type") === "animated_gif"),
  },
  { label: "several media", matches: (post) => media(post).length > 1 },
  {
    label:
      "media first posted by someone else, its link inside the displayed text",
    matches: (post) =>
      media(post).some((item) => has(item, "source_status_id_str")) &&
      list(post, "legacy", "entities", "media").some(
        (item) =>
          Number(at(item, "indices", 0)) <
          Number(at(post, "legacy", "display_text_range", 1)),
      ),
  },
  {
    label: "media with alt text",
    matches: (post) => media(post).some((item) => has(item, "ext_alt_text")),
  },
  {
    label: "long-form text (note_tweet)",
    matches: (post) => has(post, "note_tweet"),
  },
  {
    label: "long-form text with rich text marks",
    matches: (post) => has(note(post), "richtext"),
  },
  {
    label: "link",
    matches: (post) =>
      links(post).length > 0 ||
      list(note(post), "entity_set", "urls").length > 0,
  },
  { label: "link card", matches: hasCard },
  {
    label: "link card: summary_large_image",
    matches: (post) => cardName(post) === "summary_large_image",
  },
  {
    label: "link card: player",
    matches: (post) => cardName(post) === "player",
  },
  {
    label: "link card: summary",
    matches: (post) => cardName(post) === "summary",
  },
  {
    label: "link card without an image",
    matches: (post) =>
      hasCard(post) &&
      !cardBindings(post).some((key) =>
        String(key).endsWith("_image_original"),
      ),
  },
  {
    label: "card: unified_card",
    matches: (post) => cardName(post) === "unified_card",
  },
  {
    label: "card: live broadcast",
    matches: (post) => String(cardName(post)).endsWith(":broadcast"),
  },
  {
    label: "card that is only an id",
    matches: (post) =>
      has(post, "card") && !hasCard(post) && !has(post, "article"),
  },
  { label: "X Article", matches: (post) => has(post, "article") },
  { label: "quoted post", matches: isQuote },
  {
    label: "quoted post, available",
    matches: (post) => at(quoted(post), "__typename") === "Tweet",
  },
  {
    label: "quoted post, unavailable",
    matches: (post) =>
      isQuote(post) && at(quoted(post), "__typename") !== "Tweet",
  },
  {
    label: "quoted post, unavailable: TweetUnavailable",
    matches: (post) => at(quoted(post), "__typename") === "TweetUnavailable",
  },
  {
    label: "quoted post, unavailable: TweetTombstone",
    matches: (post) => at(quoted(post), "__typename") === "TweetTombstone",
  },
  {
    label: "quoted post, unavailable: no result",
    matches: (post) => isQuote(post) && quoted(post) === undefined,
  },
  {
    label: "quoted post that itself quotes",
    matches: (post) => has(quoted(post), "quotedRefResult"),
  },
  {
    label: "quoted post with media",
    matches: (post) => media(quoted(post)).length > 0,
  },
  {
    label: "quoted post with long-form text",
    matches: (post) => has(quoted(post), "note_tweet"),
  },
  {
    label: "quoted post with an X Article",
    matches: (post) => has(quoted(post), "article"),
  },
  {
    label: "visibility wrapper (TweetWithVisibilityResults)",
    matches: wrapped,
  },
  {
    label: "community note (birdwatch_pivot)",
    matches: (post) => has(post, "birdwatch_pivot"),
  },
  {
    label: "post without a view count",
    matches: (post) => has(post, "views") && !has(post, "views", "count"),
  },
  {
    label: "post X withholds (tombstone, unavailable or no result)",
    matches: (post, entry) =>
      !wrapped(post, entry) && at(post, "__typename") !== "Tweet",
  },
  {
    label: "post X withholds: TweetTombstone",
    matches: (post) => at(post, "__typename") === "TweetTombstone",
  },
  {
    label: "post X withholds: TweetUnavailable",
    matches: (post) => at(post, "__typename") === "TweetUnavailable",
  },
  {
    label: "post X withholds: no result",
    matches: (post) => post === undefined,
  },
];

const variant = (label: string): Shape => {
  const found = VARIANTS.find((candidate) => candidate.label === label);
  if (found === undefined)
    throw new Error(`No variant is labelled "${label}".`);
  return found.matches;
};
const all =
  (...shapes: Shape[]): Shape =>
  (post, entry) =>
    shapes.every((shape) => shape(post, entry));
const not =
  (shape: Shape): Shape =>
  (post, entry) =>
    !shape(post, entry);

interface FixtureSpec {
  /** File name after the capture date, saying what the fixture shows. */
  shows: string;
  picks: Shape[];
}

const BOOKMARKS_FIXTURES: readonly FixtureSpec[] = [
  {
    shows: "text-posts",
    picks: [
      all(
        plain,
        not(variant("HTML-escaped character in the text")),
        not(wrapped),
      ),
      variant("reply whose leading @handles are outside the displayed text"),
      all(
        variant("HTML-escaped character in the text"),
        not(variant("long-form text (note_tweet)")),
      ),
      all(
        variant("link after a non-BMP character"),
        not(variant("long-form text (note_tweet)")),
      ),
      variant("edited post"),
    ],
  },
  {
    shows: "media",
    picks: [
      (post) =>
        media(post).length === 1 && at(media(post)[0], "type") === "photo",
      variant("media with alt text"),
      (post) => media(post).length === 4,
      all(
        variant("video"),
        not(variant("long-form text (note_tweet)")),
        not(isQuote),
      ),
    ],
  },
  {
    shows: "long-posts",
    picks: [
      all(
        variant("long-form text with rich text marks"),
        (post) => list(note(post), "entity_set", "urls").length > 0,
      ),
      all(
        variant("long-form text (note_tweet)"),
        not(variant("long-form text with rich text marks")),
        not(isQuote),
      ),
      all(variant("long-form text (note_tweet)"), hasCard),
      (post) => at(post, "note_tweet", "is_expandable") === false,
    ],
  },
  {
    shows: "links-and-cards",
    picks: [
      all(
        variant("link card: summary_large_image"),
        not(variant("long-form text (note_tweet)")),
        not(isQuote),
        not(isReply),
      ),
      variant("link card: player"),
      variant("card that is only an id"),
      all(hasCard, (post) => links(post).length > 1),
      variant("X Article"),
    ],
  },
  {
    shows: "quoted-posts",
    picks: [
      all(
        variant("quoted post, available"),
        (post) =>
          media(quoted(post)).length === 0 &&
          !has(quoted(post), "note_tweet") &&
          !has(quoted(post), "card"),
      ),
      variant("quoted post, unavailable"),
      variant("quoted post that itself quotes"),
      all(
        variant("quoted post with media"),
        variant("quoted post with long-form text"),
      ),
      variant("quoted post with an X Article"),
    ],
  },
  { shows: "visibility-wrapper", picks: [wrapped] },
  {
    shows: "summary-cards",
    picks: [
      all(
        variant("link card: summary"),
        not(variant("link card without an image")),
      ),
      all(variant("link card: summary"), variant("link card without an image")),
    ],
  },
  {
    shows: "cards-not-read-yet",
    picks: [variant("card: unified_card"), variant("card: live broadcast")],
  },
  { shows: "animated-gif", picks: [variant("animated GIF")] },
  {
    shows: "shared-media",
    picks: [
      variant(
        "media first posted by someone else, its link inside the displayed text",
      ),
    ],
  },
  { shows: "no-view-count", picks: [variant("post without a view count")] },
  {
    shows: "withheld-posts",
    picks: [
      variant("post X withholds: TweetTombstone"),
      variant("post X withholds: no result"),
      variant("quoted post, unavailable: TweetTombstone"),
      variant("quoted post, unavailable: no result"),
    ],
  },
];

export interface CapturedResponse {
  operation: string;
  payload: string;
  /** The body of the request that produced the response, when it had one. */
  requestBody?: string | null;
  receivedAt: Date;
}

/**
 * The mutations a fixture is made of. A mutation's response says only that
 * it was done and its request names the post, so each becomes two files: the
 * response, and beside it the request body as `<name>.request.json`.
 */
const MUTATIONS = ["CreateBookmark", "DeleteBookmark"] as const;

export interface BuiltFixture {
  /** Path under the fixtures directory, such as `x-web-client/Bookmarks/2026-10-12-media.json`. */
  path: string;
  text: string;
}

const ENTRIES = [
  "data",
  "bookmark_timeline_v2",
  "timeline",
  "instructions",
  0,
  "entries",
] as const;
const isCursor = (entry: unknown) =>
  at(entry, "content", "entryType") === "TimelineTimelineCursor";

/** A stable seed from a fixture's name, so that each fixture's invented values depend on nothing else. */
function seedOf(name: string): number {
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
  }
  return hash >>> 0;
}

/** Adds every string and number of a JSON value, as text, to `values`. */
function collectValues(json: unknown, values: Set<string>): void {
  if (typeof json === "string" || typeof json === "number") {
    values.add(String(json));
  } else if (typeof json === "object" && json !== null) {
    for (const item of Object.values(json)) collectValues(item, values);
  }
}

/**
 * Builds every fixture from the stored captures, given oldest first, and
 * counts how many entries of each variant they hold. Throws when the
 * captures lack an entry a fixture needs.
 */
export function buildFixtures(captures: readonly CapturedResponse[]): {
  fixtures: BuiltFixture[];
  census: { label: string; count: number }[];
  posts: number;
} {
  const pages = captures
    .filter(({ operation }) => operation === "Bookmarks")
    .map((capture) => ({
      capture,
      json: JSON.parse(capture.payload) as unknown,
    }));
  const mutations = MUTATIONS.flatMap((operation) => {
    const capture = captures.find(
      (candidate) =>
        candidate.operation === operation &&
        typeof candidate.requestBody === "string",
    );
    return capture === undefined
      ? []
      : [
          {
            capture,
            response: JSON.parse(capture.payload) as unknown,
            request: JSON.parse(capture.requestBody ?? "") as unknown,
          },
        ];
  });
  // No invented value may equal a real one, from any capture.
  const real = new Set<string>();
  for (const { json } of pages) collectValues(json, real);
  for (const { request } of mutations) collectValues(request, real);
  const nameOf = (capture: CapturedResponse, shows: string) =>
    `${capture.receivedAt.toISOString().slice(0, 10)}-${shows}`;
  const textOf = (redacted: unknown) =>
    `${JSON.stringify(redacted, null, 2)}\n`;
  const serialise = (
    operation: string,
    shows: string,
    capture: CapturedResponse,
    json: unknown,
  ): BuiltFixture => {
    const name = `${nameOf(capture, shows)}.json`;
    const redacted = createRedactor(seedOf(name), real).redact(json);
    return {
      path: `x-web-client/${operation}/${name}`,
      text: textOf(redacted),
    };
  };

  const entries = pages.flatMap((page) =>
    list(page.json, ...ENTRIES)
      .filter((entry) => !isCursor(entry))
      .map((entry) => ({ entry, post: postOf(entry), page })),
  );

  const fixtures = BOOKMARKS_FIXTURES.map(({ shows, picks }) => {
    const chosen: (typeof entries)[number][] = [];
    for (const [index, pick] of picks.entries()) {
      const found = entries.find(
        (candidate) =>
          !chosen.includes(candidate) && pick(candidate.post, candidate.entry),
      );
      if (found === undefined) {
        throw new Error(
          `No captured entry matches pick ${index + 1} of the "${shows}" fixture.`,
        );
      }
      chosen.push(found);
    }
    const [first] = chosen;
    if (first === undefined)
      throw new Error(`The "${shows}" fixture picks nothing.`);
    // The page of the first pick is the envelope: its own cursors stay, and
    // the picked entries take the place of its twenty, in timeline order.
    const page = structuredClone(first.page.json);
    const kept = chosen
      .map(({ entry }) => entry)
      .sort((a, b) =>
        BigInt(String(at(a, "sortIndex"))) < BigInt(String(at(b, "sortIndex")))
          ? 1
          : -1,
      );
    const instruction = at(page, ...ENTRIES.slice(0, -1)) as {
      entries: unknown[];
    };
    instruction.entries = [...kept, ...instruction.entries.filter(isCursor)];
    return serialise("Bookmarks", shows, first.page.capture, page);
  });

  // The page X sends past the last bookmark: cursors and nothing else.
  const lastPage = pages.find(({ json }) => {
    const listed = list(json, ...ENTRIES);
    return listed.length > 0 && listed.every(isCursor);
  });
  if (lastPage !== undefined) {
    fixtures.push(
      serialise("Bookmarks", "end-of-list", lastPage.capture, lastPage.json),
    );
  }

  const folders = captures.find(
    ({ operation }) => operation === "BookmarkFoldersSlice",
  );
  if (folders !== undefined) {
    fixtures.push(
      serialise(
        "BookmarkFoldersSlice",
        "no-folders",
        folders,
        JSON.parse(folders.payload),
      ),
    );
  }

  for (const { capture, response, request } of mutations) {
    const name = nameOf(capture, "done");
    // One redactor for the pair, as they are one capture.
    const redactor = createRedactor(seedOf(`${name}.json`), real);
    const directory = `x-web-client/${capture.operation}`;
    fixtures.push(
      {
        path: `${directory}/${name}.json`,
        text: textOf(redactor.redact(response)),
      },
      {
        path: `${directory}/${name}.request.json`,
        text: textOf(redactor.redact(request)),
      },
    );
  }

  return {
    fixtures,
    census: VARIANTS.map(({ label, matches }) => ({
      label,
      count: entries.filter(({ post, entry }) => matches(post, entry)).length,
    })),
    posts: entries.length,
  };
}
