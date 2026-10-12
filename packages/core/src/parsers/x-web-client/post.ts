/**
 * Reads one post out of a response of X's web client: the object X calls a
 * `Tweet`, as it appears in the bookmarks timeline and, nested, as a quoted
 * post.
 *
 * Two grades of field. Identity, author, text and time are what make a
 * bookmark: when one of them does not read, the whole post fails and nothing
 * is taken from it. Everything else (media, links, card, article, quoted
 * post, counts) is read as strictly, but a part that does not read is left
 * empty and reported as a warning, so one renamed field costs that field and
 * not the bookmark.
 */
import type {
  PostArticle,
  PostCard,
  PostContent,
  PostLink,
  PostMedia,
  QuotedPost,
} from "../../post.ts";
import {
  attempt,
  boolean,
  count,
  descend,
  field,
  id,
  invalid,
  isAbsent,
  items,
  type Node,
  required,
  type ShapeIssue,
  text,
  unknownVariant,
} from "../shape.ts";

/** The type names X gives the object where a post is expected. */
const POST_TYPES = [
  "Tweet",
  "TweetWithVisibilityResults",
  "TweetTombstone",
  "TweetUnavailable",
] as const;

/** A post X withheld: deleted, from a suspended or protected account, or restricted. */
export interface Withheld {
  /** Where X's placeholder sits in the payload. */
  withheldAt: string;
  /** What X sent in place of the post, by type name. */
  detail: string;
}

/**
 * Resolves what sits where a post is expected: the post itself, possibly
 * inside a visibility wrapper, or a placeholder for a post X withholds. An
 * absent result is how X sends a post whose visibility it has limited.
 */
export function resolvePost(
  result: Node,
): { post: Node } | { withheld: Withheld } {
  if (isAbsent(result)) {
    return {
      withheld: { withheldAt: result.path, detail: "no result was sent" },
    };
  }
  const typename = required(result, "__typename");
  switch (typename.value) {
    case "Tweet":
      return { post: result };
    case "TweetWithVisibilityResults":
      return { post: required(result, "tweet") };
    case "TweetTombstone":
    case "TweetUnavailable":
      return {
        withheld: {
          withheldAt: result.path,
          detail: `X sent a ${typename.value}`,
        },
      };
    default:
      return unknownVariant(typename, POST_TYPES);
  }
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const CREATED_AT =
  /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) \+0000 (\d{4})$/;

/** X's post time, written like `Wed Oct 10 20:19:24 +0000 2018`. */
function timestamp(node: Node): Date {
  const match = CREATED_AT.exec(text(node));
  const month = MONTHS.indexOf(match?.[1] ?? "");
  if (match === null || month === -1) {
    throw invalid(node, "a time written like Wed Oct 10 20:19:24 +0000 2018");
  }
  const [day, hour, minute, second, year] = match.slice(2).map(Number);
  return new Date(Date.UTC(Number(year), month, day, hour, minute, second));
}

function readLinks(urls: Node): PostLink[] {
  if (isAbsent(urls)) return [];
  return items(urls).map((link) => ({
    url: text(required(link, "expanded_url")),
    shortUrl: text(required(link, "url")),
    displayUrl: text(required(link, "display_url")),
  }));
}

/** Writes each link out in full where the text holds X's redirect for it. */
function expandLinks(body: string, links: readonly PostLink[]): string {
  return links.reduce(
    (expanded, link) => expanded.replaceAll(link.shortUrl, link.url),
    body,
  );
}

/** X escapes exactly these three characters in a post's `full_text`. */
function unescapeHtml(escaped: string): string {
  return escaped
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * The text of a long-form post. `note_tweet` holds the whole of it, unescaped,
 * while `legacy.full_text` holds only an opening excerpt.
 */
function longFormText(note: Node): { body: string; links: PostLink[] } {
  const result = descend(note, "note_tweet_results", "result");
  const links = readLinks(field(required(result, "entity_set"), "urls"));
  return { body: expandLinks(text(required(result, "text")), links), links };
}

/**
 * The displayed part of `legacy.full_text`. `display_text_range` counts in
 * code points and cuts off what X does not show as text: the `@handles` a
 * reply opens with, and the link to the post's own media at the end.
 *
 * When the media was first posted by someone else, its link sits inside the
 * range. X shows the media in its place, so it is taken out here as well.
 */
function displayedText(
  legacy: Node,
  links: readonly PostLink[],
  mediaLinks: readonly string[],
): string {
  const codePoints = Array.from(text(required(legacy, "full_text")));
  const range = required(legacy, "display_text_range");
  const [start, end, ...extra] = items(range).map(count);
  if (
    start === undefined ||
    end === undefined ||
    extra.length > 0 ||
    start > end ||
    end > codePoints.length
  ) {
    throw invalid(range, "a start and an end within the text");
  }
  const displayed = codePoints.slice(start, end).join("");
  const withoutMedia = mediaLinks.reduce(
    (body, link) => body.replaceAll(link, ""),
    displayed,
  );
  return expandLinks(
    unescapeHtml(
      withoutMedia === displayed ? displayed : withoutMedia.trimEnd(),
    ),
    links,
  );
}

const MEDIA_TYPES = ["photo", "video", "animated_gif"] as const;

function readMedia(media: Node): PostMedia {
  const type = required(media, "type");
  const kind = MEDIA_TYPES.find((known) => known === type.value);
  if (kind === undefined) return unknownVariant(type, MEDIA_TYPES);
  const original = required(media, "original_info");
  const altText = field(media, "ext_alt_text");
  const item: PostMedia = {
    type: kind,
    imageUrl: text(required(media, "media_url_https")),
    width: count(required(original, "width")),
    height: count(required(original, "height")),
    altText: isAbsent(altText) ? null : text(altText),
    videoUrl: null,
    durationMs: null,
  };
  if (kind === "photo") return item;

  const video = required(media, "video_info");
  const variants = required(video, "variants");
  let best: { url: string; bitrate: number } | undefined;
  for (const variant of items(variants)) {
    if (text(required(variant, "content_type")) !== "video/mp4") continue;
    const bitrate = field(variant, "bitrate");
    const candidate = {
      url: text(required(variant, "url")),
      bitrate: isAbsent(bitrate) ? 0 : count(bitrate),
    };
    if (best === undefined || candidate.bitrate > best.bitrate) {
      best = candidate;
    }
  }
  if (best === undefined) throw invalid(variants, "at least one video/mp4");
  const duration = field(video, "duration_millis");
  return {
    ...item,
    videoUrl: best.url,
    durationMs: isAbsent(duration) ? null : count(duration),
  };
}

/**
 * The card layouts read so far, and the binding that holds each one's image.
 * Seen and not read yet, because they are not a title, a site and an image:
 * `unified_card` (its content is JSON inside one binding) and
 * `<id>:broadcast` (a live video).
 */
const CARD_IMAGE_BINDING: Record<string, string> = {
  summary: "thumbnail_image_original",
  summary_large_image: "thumbnail_image_original",
  player: "player_image_original",
};

/**
 * A link card. X also sends a card that is only an id, with no `legacy`
 * content, on article posts and on some links: there is nothing in it to
 * keep, and it reads as no card.
 */
function readCard(card: Node, links: readonly PostLink[]): PostCard | null {
  if (isAbsent(card)) return null;
  const legacy = field(card, "legacy");
  if (isAbsent(legacy)) return null;
  const name = required(legacy, "name");
  const imageBinding = CARD_IMAGE_BINDING[text(name)];
  if (imageBinding === undefined) {
    return unknownVariant(name, Object.keys(CARD_IMAGE_BINDING));
  }
  const bindings = new Map<string, Node>();
  for (const binding of items(required(legacy, "binding_values"))) {
    bindings.set(text(required(binding, "key")), required(binding, "value"));
  }
  const stringOf = (key: string): string | null => {
    const value = bindings.get(key);
    return value === undefined ? null : text(required(value, "string_value"));
  };
  const image = bindings.get(imageBinding);
  const shortUrl = stringOf("card_url") ?? text(required(legacy, "url"));
  return {
    name: text(name),
    url: links.find((link) => link.shortUrl === shortUrl)?.url ?? shortUrl,
    title: stringOf("title"),
    description: stringOf("description"),
    domain: stringOf("domain"),
    imageUrl:
      image === undefined ? null : text(descend(image, "image_value", "url")),
  };
}

function readArticle(article: Node): PostArticle | null {
  if (isAbsent(article)) return null;
  const result = descend(article, "article_results", "result");
  const cover = field(result, "cover_media");
  return {
    id: id(required(result, "rest_id")),
    title: text(required(result, "title")),
    previewText: text(required(result, "preview_text")),
    coverImageUrl: isAbsent(cover)
      ? null
      : text(descend(cover, "media_info", "original_img_url")),
  };
}

/** The post's view count, which X sends as a string and omits for old posts. */
function viewCount(post: Node): number | null {
  const views = field(post, "views");
  if (isAbsent(views)) return null;
  const value = field(views, "count");
  if (isAbsent(value)) return null;
  const viewed = Number(id(value));
  if (!Number.isSafeInteger(viewed)) throw invalid(value, "a countable number");
  return viewed;
}

function optionalId(node: Node): string | null {
  return isAbsent(node) ? null : id(node);
}

function optionalText(node: Node): string | null {
  return isAbsent(node) ? null : text(node);
}

/**
 * Reads a post. `post` is the `Tweet` object itself, already taken out of any
 * wrapper by `resolvePost`. Throws a `ShapeError` when identity, author, text
 * or time do not read; every other mismatch is passed to `warn`.
 */
export function readPost(
  post: Node,
  warn: (issue: ShapeIssue) => void,
): PostContent {
  const secondary = <T>(fallback: T, read: () => T): T => {
    const result = attempt(read);
    if (result.ok) return result.value;
    warn(result.issue);
    return fallback;
  };

  const legacy = required(post, "legacy");
  const postId = id(required(post, "rest_id"));
  const postedAt = timestamp(required(legacy, "created_at"));

  const author = descend(post, "core", "user_results", "result");
  const authorType = required(author, "__typename");
  if (authorType.value !== "User") unknownVariant(authorType, ["User"]);
  const authorId = id(required(author, "rest_id"));
  const authorNames = required(author, "core");
  const authorHandle = text(required(authorNames, "screen_name"));
  const authorName = text(required(authorNames, "name"));

  const legacyLinks = secondary([], () =>
    readLinks(field(required(legacy, "entities"), "urls")),
  );
  const mediaLinks = secondary([], () => {
    const media = field(required(legacy, "entities"), "media");
    return isAbsent(media)
      ? []
      : items(media).map((item) => text(required(item, "url")));
  });
  const note = field(post, "note_tweet");
  const { body, links } = isAbsent(note)
    ? {
        body: displayedText(legacy, legacyLinks, mediaLinks),
        links: legacyLinks,
      }
    : longFormText(note);

  const counts = secondary(null, () => ({
    likeCount: count(required(legacy, "favorite_count")),
    repostCount: count(required(legacy, "retweet_count")),
    replyCount: count(required(legacy, "reply_count")),
    quoteCount: count(required(legacy, "quote_count")),
    bookmarkCount: count(required(legacy, "bookmark_count")),
  }));

  return {
    postId,
    authorId,
    authorHandle,
    authorName,
    authorAvatarUrl: secondary(null, () =>
      text(descend(author, "avatar", "image_url")),
    ),
    authorVerified: secondary(false, () =>
      boolean(required(author, "is_blue_verified")),
    ),
    text: body,
    postedAt,
    lang: secondary(null, () => text(required(legacy, "lang"))),
    conversationId: secondary(null, () =>
      id(required(legacy, "conversation_id_str")),
    ),
    inReplyToPostId: secondary(null, () =>
      optionalId(field(legacy, "in_reply_to_status_id_str")),
    ),
    inReplyToHandle: secondary(null, () =>
      optionalText(field(legacy, "in_reply_to_screen_name")),
    ),
    media: secondary([], () => {
      const extended = field(legacy, "extended_entities");
      return isAbsent(extended)
        ? []
        : items(required(extended, "media")).map(readMedia);
    }),
    links,
    // A card names its link by X's redirect. A long-form post lists its
    // links with the full text, and its excerpt can lack them or carry other
    // redirects for the same links, so both lists are searched.
    card: secondary(null, () =>
      readCard(field(post, "card"), [...links, ...legacyLinks]),
    ),
    article: secondary(null, () => readArticle(field(post, "article"))),
    likeCount: counts?.likeCount ?? null,
    repostCount: counts?.repostCount ?? null,
    replyCount: counts?.replyCount ?? null,
    quoteCount: counts?.quoteCount ?? null,
    bookmarkCount: counts?.bookmarkCount ?? null,
    viewCount: secondary(null, () => viewCount(post)),
  };
}

/**
 * The post that `post` quotes, one level deep, or null when it quotes none.
 * A quoted post X withholds is kept by its id alone.
 */
export function readQuoted(
  post: Node,
  warn: (issue: ShapeIssue) => void,
): QuotedPost | null {
  const legacy = required(post, "legacy");
  if (!boolean(required(legacy, "is_quote_status"))) return null;
  const quotedId = id(required(legacy, "quoted_status_id_str"));
  const holder = field(post, "quoted_status_result");
  const resolved = resolvePost(
    isAbsent(holder) ? holder : field(holder, "result"),
  );
  if ("withheld" in resolved) return { available: false, postId: quotedId };

  // A quote of a quote names the post two levels down by id. Its content is
  // in the payload too (`nested_quoted_tweet_results`), and is not kept.
  return {
    ...readPost(resolved.post, warn),
    available: true,
    quotedPostId: optionalId(
      field(required(resolved.post, "legacy"), "quoted_status_id_str"),
    ),
  };
}
