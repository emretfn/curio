/**
 * A library item as the screen shows it: plain, serialisable data made on the
 * server from a bookmark, with every date already written out, every link
 * already checked, every media address already passed through the media
 * policy, and what a search found already marked, by core, as core's search
 * finds it. The components render it and decide nothing.
 *
 * Dates are formatted here, once, in the server's time zone and in English,
 * so that the server's markup and the browser's agree.
 */
import type { Bookmark, PostContent, PostMedia, QuotedPost } from "@curio/core";
import { excerpt, markMatches } from "../server/core.ts";
import type { LibraryItem } from "../server/library.ts";
import { clock } from "./clock.ts";
import { postUrlOnX, safeHref } from "./x-links.ts";
import { xMediaUrl } from "./x-media-policy.ts";

export interface TimeView {
  /** For `<time dateTime>`. */
  iso: string;
  /** `12 Oct 2026`. */
  label: string;
  /** `Monday 12 October 2026 at 20:24`. */
  full: string;
}

/**
 * A stretch of a post's text: words, words a search found, or a link
 * written out in it.
 */
export type TextPiece =
  | { kind: "text"; text: string }
  | { kind: "mark"; text: string }
  | { kind: "link"; href: string; label: string };

/** A line of plain text, cut where a search found something in it. */
export type MarkedLine = Exclude<TextPiece, { kind: "link" }>[];

export interface AuthorView {
  id: string;
  name: string;
  handle: string;
  /** The name and the handle as shown, cut where a search found something in them. */
  nameLine: MarkedLine;
  handleLine: MarkedLine;
  verified: boolean;
  /** Shown in place of the picture, which is never loaded. */
  initials: string;
  /** 0 to 359, steady per author, so the same person is the same colour. */
  hue: number;
}

export interface MediaView {
  kind: "photo" | "video" | "gif";
  alt: string | null;
  /** The description as shown under a placeholder, cut where a search found something in it. */
  altLine: MarkedLine | null;
  /** `1:05`, for a video. */
  duration: string | null;
  /** Width over height of the original, when the capture has both. */
  aspectRatio: number | null;
  /** The photo, or the poster frame, when the address passes the media policy. */
  imageSrc: string | null;
  videoSrc: string | null;
}

export interface CardView {
  href: string | null;
  domain: MarkedLine | null;
  title: MarkedLine | null;
  description: MarkedLine | null;
  imageSrc: string | null;
}

export interface ArticleView {
  /** The article itself on X, when the post links to it. */
  href: string | null;
  title: MarkedLine;
  preview: MarkedLine;
  coverSrc: string | null;
}

/** What a post and a quoted post have in common. */
export interface PostBody {
  id: string;
  /** The post on X, for the owner to open. */
  url: string | null;
  author: AuthorView;
  /** A language tag for `lang`, when X named a real language. */
  lang: string | null;
  replyingTo: string | null;
  text: TextPiece[];
  /** Whether the text is long enough to be shown shortened first. */
  collapsible: boolean;
  /** How many words the text has, written out, when it is shortened. */
  wordCount: string;
  /**
   * For a search result whose shortened text does not reach what the search
   * found: a few words either side of it, so the row says why it is one.
   */
  further: MarkedLine | null;
  posted: TimeView;
  media: MediaView[];
  /** `2 photos and 1 video`. */
  mediaSummary: string | null;
  card: CardView | null;
  article: ArticleView | null;
}

export type QuotedView =
  | ({ available: true } & PostBody)
  | { available: false; id: string; url: string | null };

/**
 * What a bookmark is filed under, as the row shows it and its menus change
 * it. Ids of the taxonomy and tags of the vocabulary: the names a person
 * reads come from `LabelChoices`, which the page holds once for every row.
 */
export interface LabelsView {
  /** Null for a bookmark neither the classifier nor the owner has filed. */
  category: string | null;
  format: string | null;
  tags: string[];
  /** Under "other" because the stored text was too little to tell. */
  tooLittleText: boolean;
  /** Which parts are the owner's own word. */
  corrected: { category: boolean; format: boolean; tags: boolean };
  /** What the classifier said, where it has: what a part goes back to when the owner hands it back. */
  classifier: { category: string; format: string; tags: string[] } | null;
}

export interface PostView extends PostBody {
  kind: "post";
  labels: LabelsView;
  saved: TimeView;
  /**
   * What the saved time rests on: X confirming the bookmark as it was made,
   * the order of the bookmarks on X, or only when the library first saw it.
   */
  savedBy: "observed" | "estimate" | "first-seen";
  /** The month it was saved in, which the list is grouped by. */
  month: { key: string; label: string };
  quoted: QuotedView | null;
  counts: {
    likes: string | null;
    reposts: string | null;
    views: string | null;
  };
  /** When the owner removed the bookmark on X, if a capture showed it. */
  removed: TimeView | null;
  /** X no longer sends this post; the library still has its copy. */
  withheld: boolean;
}

/** A bookmark whose post X withholds and the library never held. */
export interface WithheldView {
  kind: "withheld";
  id: string;
  url: string | null;
}

export type ItemView = PostView | WithheldView;

const LOCALE = "en-GB";
const dayFormat = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const fullFormat = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const monthFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "long",
  year: "numeric",
});
const countFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const wholeFormat = new Intl.NumberFormat("en");
const listFormat = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});
const plural = new Intl.PluralRules("en");
/** Words as each script counts them: Chinese and Japanese have no spaces to split on. */
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function countWords(text: string): number {
  let words = 0;
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike) words += 1;
  }
  return words;
}

export function timeView(at: Date): TimeView {
  return {
    iso: at.toISOString(),
    label: dayFormat.format(at),
    full: fullFormat.format(at),
  };
}

export function formatWhole(value: number): string {
  return wholeFormat.format(value);
}

const compact = (value: number | null): string | null =>
  value === null ? null : countFormat.format(value);

const MEDIA_NOUNS = {
  photo: { one: "photo", other: "photos" },
  video: { one: "video", other: "videos" },
  gif: { one: "GIF", other: "GIFs" },
} as const;

/** `2 photos and 1 video`, or null when there is no media. */
export function describeMedia(media: readonly MediaView[]): string | null {
  const parts: string[] = [];
  for (const kind of ["photo", "video", "gif"] as const) {
    const count = media.filter((item) => item.kind === kind).length;
    if (count === 0) continue;
    const noun =
      MEDIA_NOUNS[kind][plural.select(count) === "one" ? "one" : "other"];
    parts.push(`${wholeFormat.format(count)} ${noun}`);
  }
  return parts.length === 0 ? null : listFormat.format(parts);
}

function duration(milliseconds: number | null): string | null {
  return milliseconds === null || milliseconds <= 0
    ? null
    : clock(Math.round(milliseconds / 1000));
}

function mediaView(media: PostMedia, terms: readonly string[]): MediaView {
  const alt = media.altText?.trim() ?? "";
  return {
    kind: media.type === "animated_gif" ? "gif" : media.type,
    alt: alt === "" ? null : alt,
    altLine: alt === "" ? null : marked(alt, terms),
    duration: media.type === "video" ? duration(media.durationMs) : null,
    aspectRatio:
      media.width !== null && media.height !== null && media.height > 0
        ? media.width / media.height
        : null,
    imageSrc: xMediaUrl(media.imageUrl, "image"),
    videoSrc:
      media.type === "photo" ? null : xMediaUrl(media.videoUrl, "video"),
  };
}

/** The first letters of a name's first two words, for the avatar's place. */
export function initialsOf(name: string, handle: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => [...word].find((letter) => /\p{L}|\p{N}/u.test(letter)))
    .filter((letter) => letter !== undefined);
  const letters = words.slice(0, 2).join("");
  return (letters === "" ? handle.slice(0, 1) : letters).toLocaleUpperCase(
    "en",
  );
}

function hueOf(id: string): number {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) % 360;
  }
  return hash;
}

function authorView(post: PostContent, terms: readonly string[]): AuthorView {
  return {
    id: post.authorId,
    name: post.authorName,
    handle: post.authorHandle,
    nameLine: marked(post.authorName, terms),
    handleLine: marked(post.authorHandle, terms),
    verified: post.authorVerified,
    initials: initialsOf(post.authorName, post.authorHandle),
    hue: hueOf(post.authorId),
  };
}

/** X's own codes for "no language": undetermined, no words, media only. */
const LANGUAGE_TAG = /^[a-z]{2,3}$/;
const NOT_A_LANGUAGE = new Set([
  "und",
  "zxx",
  "qme",
  "qam",
  "qht",
  "qst",
  "art",
]);

function languageTag(lang: string | null): string | null {
  return lang !== null && LANGUAGE_TAG.test(lang) && !NOT_A_LANGUAGE.has(lang)
    ? lang
    : null;
}

/**
 * A post's text cut at its links. The text has each link written out in
 * full; it is shown by the shorter name X displays, and leads where the
 * post's author pointed it.
 */
export function textPieces(
  text: string,
  links: PostContent["links"],
  /** A link to leave out of the text altogether. */
  dropped?: PostContent["links"][number],
): TextPiece[] {
  const found: {
    from: number;
    to: number;
    /** Null for the dropped link. */
    href: string | null;
    label: string;
  }[] = [];
  for (const link of dropped === undefined ? links : [...links, dropped]) {
    const href = link === dropped ? null : safeHref(link.url);
    if (href === null && link !== dropped) continue;
    for (const written of new Set([link.url, link.shortUrl])) {
      if (written === "") continue;
      let from = text.indexOf(written);
      while (from !== -1) {
        found.push({
          from,
          to: from + written.length,
          href,
          label: link.displayUrl === "" ? written : link.displayUrl,
        });
        from = text.indexOf(written, from + written.length);
      }
    }
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to);
  const pieces: TextPiece[] = [];
  let position = 0;
  for (const link of found) {
    if (link.from < position) continue;
    if (link.from > position) {
      pieces.push({ kind: "text", text: text.slice(position, link.from) });
    }
    if (link.href !== null) {
      pieces.push({ kind: "link", href: link.href, label: link.label });
    }
    position = link.to;
  }
  if (position < text.length) {
    pieces.push({ kind: "text", text: text.slice(position) });
  }
  // Where a link was dropped from the end, so is the space before it.
  const last = pieces.at(-1);
  if (last?.kind === "text") {
    last.text = last.text.trimEnd();
    if (last.text === "") pieces.pop();
  }
  return pieces;
}

/** A text as pieces, marked where the search's terms are found in it. */
function marked(text: string, terms: readonly string[]): MarkedLine {
  return markMatches(text, terms).map((piece) => ({
    kind: piece.marked ? "mark" : "text",
    text: piece.text,
  }));
}

const shownText = (piece: TextPiece) =>
  piece.kind === "link" ? piece.label : piece.text;

/** How much of a text is on show while it is shortened, and how much is quoted from further down. */
const FURTHER_DOWN_CHARACTERS = 180;

function furtherDown(
  pieces: readonly TextPiece[],
  terms: readonly string[],
  shown: number,
): MarkedLine | null {
  let position = 0;
  for (const piece of pieces) {
    if (piece.kind === "mark") break;
    position += shownText(piece).length;
  }
  const text = pieces.map(shownText).join("");
  if (position <= shown || position >= text.length) return null;
  return marked(
    excerpt(text.replace(/\s+/g, " "), FURTHER_DOWN_CHARACTERS, terms),
    terms,
  );
}

function postBody(
  post: PostContent,
  shortenAbove: { characters: number; lines: number; shown: number },
  terms: readonly string[],
): PostBody {
  const media = post.media.map((item) => mediaView(item, terms));
  // A post with an article names it by a link that holds the article's id.
  // The preview below the text stands for that link, so the text drops it.
  const articleId = post.article?.id;
  const articleLink =
    articleId === undefined || articleId === ""
      ? undefined
      : post.links.find((link) => link.url.includes(articleId));
  const characters = [...post.text].length;
  const lines = post.text.split("\n").length;
  const collapsible =
    characters > shortenAbove.characters || lines > shortenAbove.lines;
  const text = textPieces(
    post.text,
    post.links.filter((link) => link !== articleLink),
    articleLink,
  ).flatMap((piece): TextPiece[] =>
    piece.kind === "text" ? marked(piece.text, terms) : [piece],
  );
  return {
    id: post.postId,
    url: postUrlOnX(post.postId, post.authorHandle),
    author: authorView(post, terms),
    lang: languageTag(post.lang),
    replyingTo: post.inReplyToHandle,
    text,
    collapsible,
    wordCount: collapsible ? wholeFormat.format(countWords(post.text)) : "",
    further: collapsible ? furtherDown(text, terms, shortenAbove.shown) : null,
    posted: timeView(post.postedAt),
    media,
    mediaSummary: describeMedia(media),
    card:
      post.card === null
        ? null
        : {
            href: safeHref(post.card.url),
            domain:
              post.card.domain === null || post.card.domain === ""
                ? null
                : marked(post.card.domain, terms),
            title:
              post.card.title === null ? null : marked(post.card.title, terms),
            description:
              post.card.description === null || post.card.description === ""
                ? null
                : marked(post.card.description, terms),
            imageSrc: xMediaUrl(post.card.imageUrl, "image"),
          },
    article:
      post.article === null
        ? null
        : {
            href: safeHref(articleLink?.url),
            title: marked(post.article.title, terms),
            preview: marked(post.article.previewText, terms),
            coverSrc: xMediaUrl(post.article.coverImageUrl, "image"),
          },
  };
}

/**
 * A post is shown whole up to about a screenful of text, and shortened
 * beyond, to roughly the first `shown` characters.
 */
const SHORTEN_POST_ABOVE = { characters: 700, lines: 12, shown: 520 };
const SHORTEN_QUOTE_ABOVE = { characters: 320, lines: 6, shown: 240 };

function quotedView(
  quoted: QuotedPost | null,
  terms: readonly string[],
): QuotedView | null {
  if (quoted === null) return null;
  if (!quoted.available) {
    return {
      available: false,
      id: quoted.postId,
      url: postUrlOnX(quoted.postId),
    };
  }
  return { available: true, ...postBody(quoted, SHORTEN_QUOTE_ABOVE, terms) };
}

/** What a bookmark is filed under, for its row. */
export function labelsView({ labels }: Bookmark): LabelsView {
  const { classification } = labels;
  return {
    category: labels.category,
    format: labels.format,
    tags: labels.tags,
    tooLittleText: labels.tooLittleText,
    corrected: labels.corrected,
    classifier:
      classification === null
        ? null
        : {
            category: classification.category,
            format: classification.format,
            tags: classification.tags,
          },
  };
}

/** Which of the three times core's bookmark time is. See `Bookmark.bookmarkedAt`. */
function savedBy(bookmark: Bookmark): PostView["savedBy"] {
  const saved = bookmark.bookmarkedAt.getTime();
  return saved === bookmark.observedBookmarkedAt?.getTime()
    ? "observed"
    : saved === bookmark.estimatedBookmarkedAt?.getTime()
      ? "estimate"
      : "first-seen";
}

/**
 * The view of one item. `terms` are what a search looked for, as
 * `listLibrary` returns them, and are marked wherever the item shows them.
 */
export function toItemView(
  item: LibraryItem,
  terms: readonly string[] = [],
): ItemView {
  if (item.kind === "withheld") {
    return { kind: "withheld", id: item.postId, url: postUrlOnX(item.postId) };
  }
  const { bookmark } = item;
  const savedAt = bookmark.bookmarkedAt;
  const month = `${savedAt.getFullYear()}-${String(savedAt.getMonth() + 1).padStart(2, "0")}`;
  return {
    kind: "post",
    ...postBody(bookmark, SHORTEN_POST_ABOVE, terms),
    labels: labelsView(bookmark),
    saved: timeView(savedAt),
    savedBy: savedBy(bookmark),
    month: { key: month, label: monthFormat.format(savedAt) },
    quoted: quotedView(bookmark.quoted, terms),
    counts: {
      likes: compact(bookmark.likeCount),
      reposts: compact(bookmark.repostCount),
      views: compact(bookmark.viewCount),
    },
    removed:
      bookmark.removedOnXAt === null ? null : timeView(bookmark.removedOnXAt),
    withheld: bookmark.withheldOnXAt !== null,
  };
}
