/**
 * What of a bookmark is sent to the classifier. This file is the whole
 * list: `ClassifierInput` is the object that becomes the message, and
 * nothing of a bookmark reaches the API that is not a field of it.
 *
 * Sent: the post's text, X's language code for it, whether it is a reply,
 * the kind and the author's description of each attached picture or video,
 * the title, description and site of its link card, the title and opening
 * of its X Article, and the same parts of the post it quotes.
 *
 * Not sent: the post's id and address, who wrote it (ids, handles, names,
 * avatars), when it was posted or bookmarked, how many liked or reposted
 * it, the handle it replies to, and every stored URL field: links, card
 * targets and media files. The text is sent as its author wrote it, so a
 * handle or a link the author typed into it is part of it.
 *
 * Nothing is fetched to add to this (X-2): what a capture lacks, the
 * classifier is told is absent.
 */
import {
  type Bookmark,
  type PostContent,
  type QuotedPost,
  visibleText,
} from "@curio/core";

interface PostParts {
  text: string;
  /** Present and true when `text` is the opening of a longer text. */
  text_cut?: true;
  language?: string;
  media?: { type: "photo" | "video" | "gif"; description?: string }[];
  link_card?: { title?: string; description?: string; site?: string };
  article?: { title: string; opening?: string };
}

export interface ClassifierInput extends PostParts {
  is_reply?: true;
  quoted_post?: PostParts | { unavailable: true };
}

/**
 * The most of a post's own text, and of a quoted post's, that is sent.
 * What a post is about is said in its opening, and a bound on the text is a
 * bound on what one request can cost. Seven of the first 1,448 bookmarks
 * are longer.
 */
export const MAX_TEXT_CHARACTERS = 4000;
export const MAX_QUOTED_TEXT_CHARACTERS = 1500;
/** The most of any title, description or media description that is sent. X's own are shorter. */
const MAX_PART_CHARACTERS = 500;

/**
 * How much of each part of a post is sent, in characters. The fields are
 * the same for everyone who sends a bookmark; only how long each may be is
 * the sender's to say, and never longer than the classifier's own.
 */
export interface TextLimits {
  /** The post's own text. */
  text: number;
  /** The text of the post it quotes. */
  quotedText: number;
  /** Any title, description or media description. */
  part: number;
}

/** What the classifier sends: the most that is ever sent of a post. */
export const CLASSIFIER_LIMITS: TextLimits = {
  text: MAX_TEXT_CHARACTERS,
  quotedText: MAX_QUOTED_TEXT_CHARACTERS,
  part: MAX_PART_CHARACTERS,
};

/** X's codes for "no language found": nothing to tell the classifier. */
const NO_LANGUAGE = new Set(["und", "zxx", "qme", "qht", "qam", "qst", "art"]);

/** Cut by code point, so that no character is split. */
function cut(text: string, limit: number): { text: string; wasCut: boolean } {
  const clean = visibleText(text).trim();
  if (clean.length <= limit) return { text: clean, wasCut: false };
  const points = [...clean];
  return points.length <= limit
    ? { text: clean, wasCut: false }
    : { text: points.slice(0, limit).join(""), wasCut: true };
}

const partWithin =
  (limit: number) =>
  (text: string | null | undefined): string | undefined => {
    const shown = cut(text ?? "", limit).text;
    return shown === "" ? undefined : shown;
  };

/** `T` with each key that may hold undefined made a key that may be absent. */
type Present<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

/** The object without the keys that hold nothing. */
function present<T extends object>(value: T): Present<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Present<T>;
}

function partsOf(
  post: PostContent,
  limit: number,
  partLimit: number,
): PostParts {
  const part = partWithin(partLimit);
  const { text, wasCut } = cut(post.text, limit);
  const card =
    post.card === null
      ? {}
      : present({
          title: part(post.card.title),
          description: part(post.card.description),
          site: part(post.card.domain),
        });
  return present({
    text,
    text_cut: wasCut ? (true as const) : undefined,
    language:
      post.lang === null || NO_LANGUAGE.has(post.lang) ? undefined : post.lang,
    media:
      post.media.length === 0
        ? undefined
        : post.media.map((item) =>
            present({
              type: item.type === "animated_gif" ? ("gif" as const) : item.type,
              description: part(item.altText),
            }),
          ),
    link_card: Object.keys(card).length === 0 ? undefined : card,
    article:
      post.article === null
        ? undefined
        : present({
            title: cut(post.article.title, partLimit).text,
            opening: part(post.article.previewText),
          }),
  });
}

function quotedParts(
  quoted: QuotedPost | null,
  limits: TextLimits,
): ClassifierInput["quoted_post"] {
  if (quoted === null) return undefined;
  return quoted.available
    ? partsOf(quoted, limits.quotedText, limits.part)
    : { unavailable: true };
}

/**
 * What is sent of a bookmark: to the classifier, and with shorter `limits`
 * to the writer of the weekly digest. This function is the one place a
 * bookmark becomes something that leaves this computer, so both send the
 * same fields and nothing else. A limit above the classifier's is refused.
 */
export function classifierInput(
  bookmark: Bookmark,
  limits: TextLimits = CLASSIFIER_LIMITS,
): ClassifierInput {
  for (const name of ["text", "quotedText", "part"] as const) {
    if (
      !Number.isInteger(limits[name]) ||
      limits[name] < 1 ||
      limits[name] > CLASSIFIER_LIMITS[name]
    ) {
      throw new RangeError(
        `No more of a post is sent than the classifier sends: ${name} is from 1 to ${CLASSIFIER_LIMITS[name]} characters.`,
      );
    }
  }
  return present({
    ...partsOf(bookmark, limits.text, limits.part),
    is_reply: bookmark.inReplyToPostId === null ? undefined : (true as const),
    quoted_post: quotedParts(bookmark.quoted, limits),
  });
}

/** Whether any text of the input was cut to its limit. */
export function wasCut(input: ClassifierInput): boolean {
  return (
    input.text_cut === true ||
    (input.quoted_post !== undefined &&
      "text_cut" in input.quoted_post &&
      input.quoted_post.text_cut === true)
  );
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;
const lettersIn = (text: string | undefined) =>
  text?.match(LETTER_OR_DIGIT)?.length ?? 0;

/** Addresses, handles and hashtags: text that names where or whom, and seldom what. */
const POINTERS = /https?:\/\/\S+|(?<![\p{L}\p{N}_])[@#][\p{L}\p{N}_]+/gu;

function wordsOf(parts: PostParts, pointers: boolean): number {
  return (
    lettersIn(pointers ? parts.text : parts.text.replace(POINTERS, " ")) +
    lettersIn(parts.link_card?.title) +
    lettersIn(parts.link_card?.description) +
    lettersIn(parts.article?.title) +
    lettersIn(parts.article?.opening) +
    (parts.media ?? []).reduce(
      (sum, item) => sum + lettersIn(item.description),
      0,
    )
  );
}

function measure(input: ClassifierInput, pointers: boolean): number {
  const quoted = input.quoted_post;
  return (
    wordsOf(input, pointers) +
    (quoted === undefined || "unavailable" in quoted
      ? 0
      : wordsOf(quoted, pointers))
  );
}

/**
 * Below this many letters and digits in everything there is to send, links
 * included, a bookmark is not sent at all: there is nothing in it for a
 * model to read, and it is filed as "too little text" where it stands.
 */
export const MIN_CHARACTERS_TO_SEND = 12;

/**
 * Below this many letters and digits of words, with addresses, handles and
 * hashtags left out, a bookmark is thin: it is sent, and the classifier is
 * likely to say it holds too little. Counted for the plan of a run, so that
 * the share filed under "other" is no surprise.
 */
export const THIN_CHARACTERS = 60;

/** How much there is to go on: enough, little, or nothing worth sending. */
export function substanceOf(
  input: ClassifierInput,
): "enough" | "thin" | "none" {
  if (measure(input, true) < MIN_CHARACTERS_TO_SEND) return "none";
  return measure(input, false) < THIN_CHARACTERS ? "thin" : "enough";
}

/**
 * The message for a bookmark: its input as one JSON document. Inside JSON a
 * post's text is a string, which it cannot end, so no post can pass itself
 * off as part of the message's structure or as a second message.
 */
export function messageOf(input: ClassifierInput): string {
  return JSON.stringify(input);
}
