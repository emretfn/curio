import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 8,
  name: "digests",
  sql: `
-- The written part of the weekly digest: Claude's summary of what was
-- bookmarked in one week. Each row is one attempt at writing one, started
-- by the owner (pnpm digest) or by the schedule the owner installed, and
-- never by the app. It is the record of what was sent and what it cost, as
-- a tagging run is, and where the attempt succeeded it holds the text. The
-- digest of a week is its latest row whose outcome is 'written'.
--
-- The free part of a digest, the counts and the posts, is stored nowhere:
-- it is read from the bookmarks each time.
--
--   week             the week, by the date of its Monday on the computer
--                    that wrote it: YYYY-MM-DD
--   period_start_at  the two moments that bounded that week there and then
--   period_end_at
--   started_by       'owner' for a run at a terminal, 'schedule' for the
--                    launchd job
--   model            the model that was asked
--   instructions_version
--                    the version of the digest's own instructions, which
--                    covers the wording, the fields sent, the answer's shape
--                    and the model's settings
--   outcome          null while the run is open
--   failure          why a failed run failed: a code, never content
--   bookmarks_in_week
--                    how many bookmarks the week held when the run began
--   post_ids         the bookmarks that were sent, in the order they were
--                    numbered in the request, which carries no post id. The
--                    answer points at a bookmark by its number, and a number
--                    becomes a post id only through this list
--   cost_usd         worked out from the tokens the API reported and the
--                    prices of the day; the invoice is the authority
--   unanswered_requests
--                    attempts that went out and brought no answer back. The
--                    API may have charged for each, and they are in no token
--                    count and so not in cost_usd
--   body             the digest as written: a JSON object of an overview,
--                    themes and bookmarks worth going back to, in which a
--                    bookmark is a post id of post_ids. A model's words
--                    about strangers' posts: shown as text, never as markup
CREATE TABLE digest_runs (
  id INTEGER PRIMARY KEY,
  week TEXT NOT NULL
    CHECK (week GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_start_at INTEGER NOT NULL CHECK (period_start_at > 1000000000000),
  period_end_at INTEGER NOT NULL CHECK (period_end_at > period_start_at),
  started_at INTEGER NOT NULL CHECK (started_at > 1000000000000),
  finished_at INTEGER CHECK (finished_at > 1000000000000),
  started_by TEXT NOT NULL CHECK (started_by IN ('owner', 'schedule')),
  model TEXT NOT NULL CHECK (length(model) > 0),
  instructions_version INTEGER NOT NULL CHECK (instructions_version > 0),
  outcome TEXT CHECK (outcome IN ('written', 'failed', 'abandoned')),
  failure TEXT CHECK (length(failure) > 0),
  bookmarks_in_week INTEGER NOT NULL CHECK (bookmarks_in_week >= 0),
  post_ids TEXT NOT NULL
    CHECK (json_valid(post_ids) AND json_type(post_ids) = 'array'),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  unanswered_requests INTEGER NOT NULL DEFAULT 0
    CHECK (unanswered_requests >= 0),
  cap_usd REAL NOT NULL CHECK (cap_usd >= 0),
  body TEXT CHECK (json_valid(body) AND json_type(body) = 'object'),
  CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  CHECK ((body IS NOT NULL) = (outcome IS 'written'))
) STRICT;

-- The digest of a week is looked up by the week.
CREATE INDEX digest_runs_week ON digest_runs (week, id);

-- At most one run is open, whichever process asks, so that two never pay
-- for the same week side by side.
CREATE UNIQUE INDEX digest_runs_one_open
  ON digest_runs ((finished_at IS NULL)) WHERE finished_at IS NULL;
`,
};
