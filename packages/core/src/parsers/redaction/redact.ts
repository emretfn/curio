/**
 * Turns a real response into a fixture that can be committed: the structure
 * X sent, with everything personal replaced by invented values.
 *
 * It works by default-deny. Every string and every number is replaced unless
 * a rule below says it is structure. What is kept as it was:
 *
 * - field names;
 * - values of the fields in `ENUM_FIELDS`, which hold X's own type names and
 *   enumerated constants, when they look like an identifier;
 * - booleans and null;
 * - text offsets (`indices`, `display_text_range` and the like), numbers
 *   below 10, and digit strings shorter than four digits.
 *
 * Replacement keeps what a parser depends on. The same real id, handle, link
 * or path always becomes the same invented one, so cross-references inside a
 * response still agree. Text keeps its length in code points, its `t.co`
 * links, `@handles`, `#tags`, HTML escapes and non-BMP characters in place,
 * so every offset still points at what it pointed at; all other characters
 * are overwritten with a fixed filler, which keeps no word of the original
 * and not its word lengths either.
 *
 * Invented values are drawn from a seeded sequence. None is computed from
 * the value it replaces, so an invented id cannot be tested against a guess
 * at the real one. The output is a pure function of the input, the seed and
 * the order of calls, so running the build again over the same captures
 * gives the same files.
 */

const FILLER =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ";
/** Stands in for every character outside the Basic Multilingual Plane, which are two UTF-16 units and one code point. */
const ASTRAL = "\u{1F516}";

/** Fields that hold X's type names and enumerated constants. */
const ENUM_FIELDS: ReadonlySet<string> = new Set([
  "__typename",
  "entryType",
  "itemType",
  "tweetDisplayType",
  "cursorType",
  "type",
  "state",
  "resize",
  "content_type",
  "richtext_types",
  "userLabelType",
  "userLabelDisplayType",
  "urlType",
  "professional_type",
  "verified_type",
  "profile_image_shape",
  "status",
  "visualStyle",
  "iconType",
  "footerIconType",
  "icon_name",
  "action",
  "cta_type",
  "translator_type",
  "parody_commentary_fan_label",
  "ai_generated_detection_source",
  "scribe_key",
  // The name of a card binding, such as `title` or `thumbnail_image_original`.
  "key",
  // What X answers to a bookmark mutation: `Done`.
  "tweet_bookmark_put",
  "tweet_bookmark_delete",
]);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_/+.-]{0,47}$/;

/** Card layout names seen so far. Others are replaced. */
const CARD_NAMES: ReadonlySet<string> = new Set([
  "summary",
  "summary_large_image",
  "player",
  "unified_card",
]);
/** A card layout named after an account: an id, then one of X's words, as in `<id>:broadcast`. */
const OWNED_CARD_NAME = /^([0-9]+):([a-z_]+)$/;

/** Fields holding a language code. All become `en`, which says nothing about the reader. */
const LANGUAGE_FIELDS: ReadonlySet<string> = new Set([
  "lang",
  "language",
  "source_language",
  "destination_language",
  "profile_description_language",
]);

/** Fields holding a handle without its `@`. */
const HANDLE_FIELDS: ReadonlySet<string> = new Set([
  "screen_name",
  "in_reply_to_screen_name",
]);

/** Number fields that are positions in a text, which stay valid because text keeps its length. */
const OFFSET_FIELDS: ReadonlySet<string> = new Set([
  "indices",
  "display_text_range",
  "from_index",
  "to_index",
  "fromIndex",
  "toIndex",
]);

/** X's own hosts. Any other host is replaced. */
const X_HOSTS: ReadonlySet<string> = new Set([
  "t.co",
  "x.com",
  "twitter.com",
  "pic.x.com",
  "pic.twitter.com",
  "pbs.twimg.com",
  "video.twimg.com",
  "abs.twimg.com",
]);

/** Fixed parts of the paths X serves posts and media under. Any other path segment is replaced. */
const PATH_WORDS: ReadonlySet<string> = new Set([
  "i",
  "web",
  "status",
  "article",
  "photo",
  "video",
  "media",
  "profile_images",
  "profile_banners",
  "ext_tw_video",
  "ext_tw_video_thumb",
  "amplify_video",
  "amplify_video_thumb",
  "tweet_video",
  "tweet_video_thumb",
  "card_img",
  "vid",
  "avc1",
  "pl",
  "pu",
  "img",
]);
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "mp4",
  "m3u8",
]);
/** Query parameters of X's media URLs, and the values of each that are X's constants. */
const QUERY_VALUES: Record<string, ReadonlySet<string>> = {
  tag: new Set(),
  format: FILE_EXTENSIONS,
  name: new Set(["orig", "large", "medium", "small", "thumb"]),
};

const TWITTER_DATE =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} \+0000 \d{4}$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const HOUR_MS = 3_600_000;
/** Invented post and account times count up from here, an hour apart. */
const FIRST_CREATED_MS = Date.UTC(2026, 0, 1);
/** Invented bookmark times count down from here, so each falls after every invented post time. */
const LAST_BOOKMARKED_MS = Date.UTC(2026, 5, 1);

const DIGITS = "0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();

/** A small deterministic generator (mulberry32). Not for secrets: for repeatable invented values. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function twitterDate(ms: number): string {
  const date = new Date(ms);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000 ${date.getUTCFullYear()}`;
}

/** `User:123`, `NoteTweet:123` and the like, which X sends base64-encoded as an object's `id`. */
function decodeGlobalId(value: string): [type: string, id: string] | undefined {
  if (!/^[A-Za-z0-9+/]{8,}={0,2}$/.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64").toString("latin1");
  const match = /^([A-Za-z]+):([0-9]+)$/.exec(decoded);
  return match?.[1] !== undefined && match[2] !== undefined
    ? [match[1], match[2]]
    : undefined;
}

export interface Redactor {
  /** Returns a redacted copy of a parsed response. Later calls continue the same mapping. */
  redact(payload: unknown): unknown;
}

/**
 * `avoid` holds values that no invented value may equal: every value of the
 * real captures, when building fixtures. An invented id or handle is random,
 * and among enough real ones it would now and then coincide with one.
 */
export function createRedactor(
  seed = 1,
  avoid: ReadonlySet<string> = new Set(),
): Redactor {
  const random = generator(seed);
  const pick = (alphabet: string) =>
    alphabet[Math.floor(random() * alphabet.length)] ?? "";
  const mappings = new Map<string, Map<string, string>>();
  /** The invented value for a real one, made on first sight and reused after. */
  const mapped = (kind: string, real: string, invent: () => string): string => {
    let ofKind = mappings.get(kind);
    if (ofKind === undefined) {
      ofKind = new Map();
      mappings.set(kind, ofKind);
    }
    let invented = ofKind.get(real);
    if (invented === undefined) {
      // Drawn again while it is a real value. Short values are let through:
      // a count of a few digits equals some real count and identifies nothing.
      // An inventor with one fixed answer is left to the leak check.
      for (let attempt = 0; attempt < 100; attempt++) {
        invented = invent();
        if (invented.length < 4 || !avoid.has(invented)) break;
      }
      ofKind.set(real, invented ?? real);
    }
    return invented ?? real;
  };
  let createdTimes = 0;
  let sortIndexes = 0;

  /** Replaces each character with a random one of its class: digit, lower or upper case letter. */
  const scramble = (real: string): string =>
    mapped("token", real, () =>
      Array.from(real, (character) =>
        DIGITS.includes(character)
          ? pick(DIGITS)
          : LOWER.includes(character)
            ? pick(LOWER)
            : UPPER.includes(character)
              ? pick(UPPER)
              : /[\p{L}\p{N}]/u.test(character)
                ? pick(LOWER)
                : character,
      ).join(""),
    );
  const digits = (real: string): string =>
    real.length < 4
      ? real
      : mapped(
          "digits",
          real,
          () =>
            pick(DIGITS.slice(1)) +
            Array.from({ length: real.length - 1 }, () => pick(DIGITS)).join(
              "",
            ),
        );
  const handle = (real: string): string =>
    mapped("handle", real.toLowerCase(), () =>
      Array.from(real, () => pick(LOWER)).join(""),
    );
  const hashtag = (real: string): string =>
    mapped("hashtag", real.toLowerCase(), () =>
      Array.from(real, () => pick(LOWER)).join(""),
    );
  const host = (real: string): string =>
    X_HOSTS.has(real.toLowerCase())
      ? real.toLowerCase()
      : mapped(
          "host",
          real.toLowerCase(),
          () => `site${(mappings.get("host")?.size ?? 0) + 1}.example`,
        );
  /** A `t.co` redirect, keeping its length: text offsets depend on it. */
  const shortLink = (real: string): string =>
    mapped("t.co", real, () => {
      const cut = real.lastIndexOf("/") + 1;
      return (
        real.slice(0, cut) +
        Array.from(real.slice(cut), () => pick(LOWER + UPPER + DIGITS)).join("")
      );
    });

  function pathSegment(segment: string, isHandle: boolean): string {
    if (PATH_WORDS.has(segment)) return segment;
    if (/^[0-9]+$/.test(segment)) return digits(segment);
    if (isHandle) return handle(segment);
    const dot = segment.lastIndexOf(".");
    const extension = dot === -1 ? "" : segment.slice(dot + 1).toLowerCase();
    const [stem, suffix] = FILE_EXTENSIONS.has(extension)
      ? [segment.slice(0, dot), segment.slice(dot)]
      : [segment, ""];
    // `_normal` marks the size of a profile image, and other sizes are named
    // by swapping it.
    return stem.endsWith("_normal")
      ? `${scramble(stem.slice(0, -"_normal".length))}_normal${suffix}`
      : `${scramble(stem)}${suffix}`;
  }

  function url(real: string): string {
    let parsed: URL;
    try {
      parsed = new URL(real);
    } catch {
      return freeText(real);
    }
    if (/^https?:\/\/t\.co\/[A-Za-z0-9]+$/.test(real)) return shortLink(real);
    const onX = ["x.com", "twitter.com"].includes(parsed.hostname);
    const segments = parsed.pathname
      .split("/")
      .map((segment, index) =>
        segment === "" ? "" : pathSegment(segment, onX && index === 1),
      );
    const query = [...parsed.searchParams]
      .map(([name, value]) =>
        QUERY_VALUES[name]?.has(value)
          ? `${name}=${value}`
          : `${Object.hasOwn(QUERY_VALUES, name) ? name : scramble(name)}=${/^[0-9]+$/.test(value) ? digits(value) : scramble(value)}`,
      )
      .join("&");
    return `${parsed.protocol}//${host(parsed.hostname)}${segments.join("/")}${query === "" ? "" : `?${query}`}`;
  }

  const TEXT_TOKEN =
    /https:\/\/t\.co\/[A-Za-z0-9]+|@[A-Za-z0-9_]{1,15}|#[\p{L}\p{N}_]+|&(?:amp|lt|gt);/gu;

  /**
   * Overwrites a text with filler, code point for code point, leaving in
   * place the tokens that offsets and parsers refer to.
   */
  function freeText(real: string): string {
    let position = 0;
    let redacted = "";
    const fill = (gap: string) => {
      for (const character of gap) {
        redacted +=
          (character.codePointAt(0) ?? 0) > 0xffff
            ? ASTRAL
            : FILLER[position % FILLER.length];
        position += 1;
      }
    };
    let consumed = 0;
    for (const match of real.matchAll(TEXT_TOKEN)) {
      fill(real.slice(consumed, match.index));
      const token = match[0];
      const replacement = token.startsWith("https://")
        ? shortLink(token)
        : token.startsWith("@")
          ? `@${handle(token.slice(1))}`
          : token.startsWith("#")
            ? `#${hashtag(token.slice(1))}`
            : token;
      redacted += replacement;
      position += Array.from(token).length;
      consumed = match.index + token.length;
    }
    fill(real.slice(consumed));
    return redacted;
  }

  function text(real: string, key: string, trail: readonly string[]): string {
    if (real === "") return real;
    if (ENUM_FIELDS.has(key) && IDENTIFIER.test(real) && !/\d{4}/.test(real)) {
      return real;
    }
    // The layout name of a card sits beside its bindings.
    if (key === "name" && trail.at(-1) === "legacy") {
      if (CARD_NAMES.has(real)) return real;
      const owned = OWNED_CARD_NAME.exec(real);
      if (owned?.[1] !== undefined) return `${digits(owned[1])}:${owned[2]}`;
    }
    if (LANGUAGE_FIELDS.has(key)) return "en";
    if (HANDLE_FIELDS.has(key)) return handle(real);
    if (key === "text" && trail.includes("hashtags")) return hashtag(real);
    if (key === "source") {
      return '<a href="https://example.com" rel="nofollow">Example Client</a>';
    }
    if (/^[0-9]+$/.test(real)) return digits(real);
    if (TWITTER_DATE.test(real)) {
      createdTimes += 1;
      return twitterDate(FIRST_CREATED_MS + createdTimes * HOUR_MS);
    }
    // One link and nothing else. Text that merely starts with a link is text.
    if (/^https?:\/\/\S+$/.test(real)) return url(real);
    const globalId = decodeGlobalId(real);
    if (globalId !== undefined) {
      return Buffer.from(`${globalId[0]}:${digits(globalId[1])}`).toString(
        "base64",
      );
    }
    // A media key (`3_1234…`) and an entry id (`tweet-1234…`): a fixed prefix and an id.
    const prefixed =
      /^([0-9]{1,2}_|tweet-|cursor-top-|cursor-bottom-)([0-9]+)$/.exec(real);
    if (prefixed?.[1] !== undefined && prefixed[2] !== undefined) {
      return prefixed[1] + digits(prefixed[2]);
    }
    // A bare host (`example.com`), and a host with a path as X displays links.
    const displayed = /^((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(\/\S*)?$/.exec(real);
    if (displayed?.[1] !== undefined) {
      const rest = displayed[2] ?? "";
      return host(displayed[1]) + rest.replace(/[^/…]+/g, scramble);
    }
    // Opaque tokens, such as a paging cursor: no spaces, and not prose.
    if (/^[A-Za-z0-9+/=_-]{12,}$/.test(real)) return scramble(real);
    return freeText(real);
  }

  function number(real: number, key: string): number {
    if (OFFSET_FIELDS.has(key) || Math.abs(real) < 10) return real;
    if (!Number.isInteger(real)) return Math.round(random() * 1000) / 100;
    const length = String(Math.abs(real)).length;
    const invented = Number(
      mapped(
        "number",
        String(Math.abs(real)),
        () =>
          pick(DIGITS.slice(1)) +
          Array.from({ length: length - 1 }, () => pick(DIGITS)).join(""),
      ),
    );
    return real < 0 ? -invented : invented;
  }

  function walk(real: unknown, key: string, trail: readonly string[]): unknown {
    if (typeof real === "string") return text(real, key, trail);
    if (typeof real === "number") return number(real, key);
    if (Array.isArray(real)) return real.map((item) => walk(item, key, trail));
    if (typeof real === "object" && real !== null) {
      return Object.fromEntries(
        Object.entries(real).map(([name, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /\d{4}/.test(name)) {
            throw new Error(
              `A field name at ${[...trail, key].join(".")} does not look like a name from X's schema, so it may be data. Teach the redactor about this shape before building a fixture from it.`,
            );
          }
          return [name, walk(value, name, [...trail, key])];
        }),
      );
    }
    return real;
  }

  /**
   * Gives every `sortIndex` of a response an invented value before anything
   * else is replaced, so that they keep their order and, read as a bookmark
   * time, stay later than every invented post time.
   */
  function assignSortIndexes(payload: unknown): void {
    const found: string[] = [];
    const collect = (value: unknown, key: string) => {
      if (key === "sortIndex" && typeof value === "string") found.push(value);
      else if (Array.isArray(value))
        for (const item of value) collect(item, key);
      else if (typeof value === "object" && value !== null) {
        for (const [name, item] of Object.entries(value)) collect(item, name);
      }
    };
    collect(payload, "");
    const descending = found
      .filter((value) => /^[0-9]+$/.test(value))
      .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1));
    for (const real of descending) {
      mapped("digits", real, () => {
        sortIndexes += 1;
        const bookmarked = BigInt(LAST_BOOKMARKED_MS - sortIndexes * HOUR_MS);
        return String(
          (bookmarked << 20n) | BigInt(Math.floor(random() * 2 ** 20)),
        );
      });
    }
  }

  return {
    redact(payload) {
      assignSortIndexes(payload);
      return walk(payload, "", []);
    },
  };
}
