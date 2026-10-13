/**
 * `@curio/core`, loaded by Node at run time instead of being bundled.
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
 * "@curio/core" is fine: they are erased.
 */
export const {
  acceptTagProposal,
  addTag,
  addTagAlias,
  backupStore,
  correctBookmark,
  dismissTagProposal,
  excerpt,
  getBookmark,
  getDigest,
  getVocabulary,
  insertRawCaptureOnce,
  lastDayOf,
  latestWeekEnded,
  listBookmarks,
  listParseIssues,
  listSnapshots,
  listTagProposals,
  listTags,
  listWeeks,
  listWithheldPosts,
  markMatches,
  MAX_PAGE_SIZE,
  MAX_TAG_PROPOSALS,
  mergeTags,
  MIN_DIGEST_BOOKMARKS,
  OTHER_CATEGORY,
  openStore,
  parsePendingCaptures,
  removeTagAlias,
  renameTag,
  reparseAllCaptures,
  resolveTag,
  retireTag,
  searchBookmarks,
  summariseLibrary,
  summariseMatches,
  summariseParsing,
  summariseRawCaptures,
  summariseTagging,
  summariseWeek,
  TAXONOMY,
  UNCLEAR_FORMAT,
  weekAfter,
  weekBefore,
  weekOf,
}: typeof import("@curio/core") = await import(
  /* turbopackIgnore: true */ "@curio/core"
);
