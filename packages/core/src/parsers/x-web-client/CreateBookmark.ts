/**
 * Parses a `CreateBookmark` response of X's web client: X's confirmation
 * that the post named in the request was bookmarked.
 */
import { mutationParser } from "./mutation.ts";

export const parseCreateBookmark = mutationParser(
  "tweet_bookmark_put",
  "bookmarked",
);
