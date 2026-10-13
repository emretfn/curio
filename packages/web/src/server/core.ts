/**
 * `@x-bookmarks/core`, loaded by Node at run time instead of being bundled.
 *
 * Next bundles a workspace package that exports TypeScript source, and it
 * does so once per server layer (pages, route handlers), which would give
 * this process several copies of core, each with its own table of open
 * connections: a store opened by one copy is rejected by the next. The
 * `turbopackIgnore` comment leaves the import for Node, which runs core's
 * source directly as everywhere else in this repo, so there is one copy and
 * the native SQLite driver is resolved from core's own dependencies.
 *
 * Import core's functions from here in this package. Importing types from
 * "@x-bookmarks/core" is fine: they are erased.
 */
export const {
  backupStore,
  excerpt,
  getBookmark,
  getDigest,
  insertRawCaptureOnce,
  lastDayOf,
  latestWeekEnded,
  listBookmarks,
  listParseIssues,
  listSnapshots,
  listTagProposals,
  listWeeks,
  listWithheldPosts,
  MAX_PAGE_SIZE,
  MIN_DIGEST_BOOKMARKS,
  markMatches,
  OTHER_CATEGORY,
  openStore,
  parsePendingCaptures,
  reparseAllCaptures,
  searchBookmarks,
  summariseLibrary,
  summariseMatches,
  summariseParsing,
  summariseRawCaptures,
  summariseTagging,
  summariseWeek,
  TAXONOMY,
  weekAfter,
  weekBefore,
  weekOf,
}: typeof import("@x-bookmarks/core") = await import(
  /* turbopackIgnore: true */ "@x-bookmarks/core"
);
