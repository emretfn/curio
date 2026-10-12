import type { CaptureSource } from "../raw-captures.ts";
import type { CaptureParser } from "./parsed.ts";
import { parseBookmarkFoldersSlice } from "./x-web-client/BookmarkFoldersSlice.ts";
import { parseBookmarks } from "./x-web-client/Bookmarks.ts";

/**
 * Raised by one whenever any parser's output for the same payload changes,
 * so that stored results can be told from current ones. After raising it,
 * run a full re-parse (`pnpm reparse`).
 */
export const PARSER_VERSION = 2;

/**
 * The parser for each `(source, operation)` pair that has one. A pair that is
 * absent has no parser yet: its captures are stored and recorded as such,
 * and are parsed by a later re-parse once a parser exists.
 *
 * Deliberately absent, until a real sample of each exists: the folder
 * timeline (`BookmarkFolderTimeline`), the mutations (`CreateBookmark`,
 * `DeleteBookmark`), and everything from the official API (`x-api-v2`).
 */
const PARSERS: Record<CaptureSource, Record<string, CaptureParser>> = {
  "x-web-client": {
    Bookmarks: parseBookmarks,
    BookmarkFoldersSlice: parseBookmarkFoldersSlice,
  },
  "x-api-v2": {},
};

export function parserFor(
  source: CaptureSource,
  operation: string,
): CaptureParser | undefined {
  const forSource = PARSERS[source];
  return Object.hasOwn(forSource, operation) ? forSource[operation] : undefined;
}
