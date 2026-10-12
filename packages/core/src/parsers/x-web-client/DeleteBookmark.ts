/**
 * Parses a `DeleteBookmark` response of X's web client: X's confirmation
 * that the bookmark of the post named in the request was removed.
 */
import { mutationParser } from "./mutation.ts";

export const parseDeleteBookmark = mutationParser(
  "tweet_bookmark_delete",
  "removed",
);
