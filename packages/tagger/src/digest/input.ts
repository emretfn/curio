/**
 * What of a week is sent to the writer of the digest: its bookmarks, each
 * as the classifier's own input and nothing more, with a number.
 *
 * `classifierInput` in `../input.ts` is the one function that turns a
 * bookmark into something that leaves this computer. The digest calls it
 * with shorter limits, so it sends the same fields as the classifier, cut
 * shorter, and can send no field the classifier does not: no id, no author,
 * no time, no count, no stored address. What it adds is `n`, the post's
 * place in this one message, which is how the answer points back at a post;
 * the post's id stays here, in the run's own list.
 *
 * Not sent either: the week's dates, how a bookmark is filed, or anything
 * else of the library.
 */
import { type Bookmark, MIN_DIGEST_BOOKMARKS } from "@curio/core";
import {
  type ClassifierInput,
  classifierInput,
  substanceOf,
  type TextLimits,
  wasCut,
} from "../input.ts";

/**
 * How much of each part of a post the digest sends. A week's posts go in
 * one request, so each is cut shorter than the classifier cuts it: what a
 * post is about is in its opening.
 */
export const DIGEST_TEXT_LIMITS: TextLimits = {
  text: 1200,
  quotedText: 500,
  part: 300,
};

/**
 * The most bookmarks one digest is written from. The heaviest of the
 * library's first 154 weeks held 37; a week beyond this is summarised from
 * its most recent ones, and says so.
 */
export const MAX_DIGEST_BOOKMARKS = 150;

/** Fewer bookmarks than this are not worth a summary: core's own number, which the page goes by too. */
export { MIN_DIGEST_BOOKMARKS };

/** One post of the message: the classifier's input for it, and its number. */
export type DigestPost = { n: number } & ClassifierInput;

/** The whole message. */
export interface DigestInput {
  posts: DigestPost[];
}

/** What the digest sends of one bookmark, before it is numbered. */
export const digestPostOf = (bookmark: Bookmark): ClassifierInput =>
  classifierInput(bookmark, DIGEST_TEXT_LIMITS);

/** Whether there is anything in a post for a model to read. See `substanceOf`. */
export const worthSending = (post: ClassifierInput): boolean =>
  substanceOf(post) !== "none";

export { wasCut };

/** The message for these posts, numbered from 1 in the order given. */
export function digestInput(posts: readonly ClassifierInput[]): DigestInput {
  return { posts: posts.map((post, index) => ({ n: index + 1, ...post })) };
}

/**
 * The message as one JSON document. Inside JSON a post's text is a string,
 * which it cannot end, so no post can pass itself off as part of the
 * message's structure, as another post or as an instruction.
 */
export function digestMessageOf(input: DigestInput): string {
  return JSON.stringify(input);
}
