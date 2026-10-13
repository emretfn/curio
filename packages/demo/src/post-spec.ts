/**
 * How a demo post is written down: the post itself, and beside it what a
 * classifier would have answered for it. The files under `posts/` are lists
 * of these.
 *
 * The category, format and tags here are data about invented posts, as a
 * test's sample answers are. They are typed by core's taxonomy, so a
 * category or format that leaves it fails the typecheck here, and each is
 * checked again against the taxonomy and the vocabulary when the demo is
 * built, by `recordClassification`.
 */
import type { CategoryId, FormatId } from "@curio/core";
import type { AuthorKey } from "./authors.ts";
import type { DemoMedia } from "./timeline.ts";

export interface PostSpec {
  by: AuthorKey;
  /** As its author wrote it. A link is written out in full, on a `.example` name. */
  text: string;
  category: CategoryId;
  format: FormatId;
  tags: readonly string[];
  /** Tags the classifier suggested beyond the vocabulary. */
  proposed?: readonly string[];
  /** Filed under "other" because the stored text is too little to tell. */
  tooLittleText?: true;
  /** X's language code for the text. English unless said. */
  lang?: "tr" | "und";
  media?: readonly DemoMedia[];
  /** The preview of the last link in the text. */
  card?: { title: string; description: string };
  article?: { title: string; preview: string };
  /** The post it quotes, or `withheld` for one X no longer sends. */
  quote?: { by: AuthorKey; text: string; media?: readonly DemoMedia[] };
  quoteWithheld?: true;
  /** The author whose post this one answers. */
  replyTo?: AuthorKey;
  /**
   * When it was saved: in the week the demo's digest is of, in the days
   * since, or, unless said, somewhere in the months before.
   */
  saved?: "digest-week" | "since";
  /** A name other parts of the demo point at this post by. */
  key?: string;
}

type More = Omit<PostSpec, "by" | "text" | "category" | "format" | "tags">;

/** One post, written in the order it reads: who, what, and how it is filed. */
export function post(
  by: AuthorKey,
  text: string,
  category: CategoryId,
  format: FormatId,
  tags: readonly string[] = [],
  more: More = {},
): PostSpec {
  return { by, text, category, format, tags, ...more };
}

/** A photo, with the description its author gave it, if any. */
export const photo = (
  alt: string | null = null,
  width = 1600,
  height = 1000,
): DemoMedia => ({ type: "photo", alt, width, height });

/** A video of `seconds`, with its description, if any. */
export const video = (
  seconds: number,
  alt: string | null = null,
): DemoMedia => ({
  type: "video",
  alt,
  width: 1920,
  height: 1080,
  durationMs: seconds * 1000,
});

export const gif = (alt: string | null = null): DemoMedia => ({
  type: "animated_gif",
  alt,
  width: 800,
  height: 600,
});
