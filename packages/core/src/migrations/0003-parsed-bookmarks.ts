import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 3,
  name: "parsed-bookmarks",
  sql: `
-- What a parser reads from a post beyond the four columns of migration 1.
-- Columns are added, not rebuilt, so first_seen_at, first_seen_capture_id and
-- their trigger are untouched. The two NOT NULL columns default to '' only
-- for rows written before this migration; a re-parse fills them.
ALTER TABLE bookmarks ADD COLUMN author_handle TEXT NOT NULL DEFAULT '';
ALTER TABLE bookmarks ADD COLUMN author_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bookmarks ADD COLUMN author_avatar_url TEXT;
ALTER TABLE bookmarks ADD COLUMN author_verified INTEGER NOT NULL DEFAULT 0
  CHECK (author_verified IN (0, 1));
ALTER TABLE bookmarks ADD COLUMN lang TEXT;
ALTER TABLE bookmarks ADD COLUMN conversation_id TEXT CHECK (conversation_id GLOB '[0-9]*' AND conversation_id NOT GLOB '*[^0-9]*');
ALTER TABLE bookmarks ADD COLUMN in_reply_to_post_id TEXT CHECK (in_reply_to_post_id GLOB '[0-9]*' AND in_reply_to_post_id NOT GLOB '*[^0-9]*');
ALTER TABLE bookmarks ADD COLUMN in_reply_to_handle TEXT;

-- Structured parts of a post, as JSON. Their shapes are the PostMedia,
-- PostLink, PostCard, PostArticle and QuotedPost types of src/post.ts, with a
-- quoted post's time held as Unix epoch milliseconds like every other time.
ALTER TABLE bookmarks ADD COLUMN media TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media) AND json_type(media) = 'array');
ALTER TABLE bookmarks ADD COLUMN links TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links) AND json_type(links) = 'array');
ALTER TABLE bookmarks ADD COLUMN card TEXT CHECK (json_valid(card) AND json_type(card) = 'object');
ALTER TABLE bookmarks ADD COLUMN article TEXT CHECK (json_valid(article) AND json_type(article) = 'object');
ALTER TABLE bookmarks ADD COLUMN quoted TEXT CHECK (json_valid(quoted) AND json_type(quoted) = 'object');

-- Engagement as of the last sighting. Null where the source did not say.
ALTER TABLE bookmarks ADD COLUMN like_count INTEGER CHECK (like_count >= 0);
ALTER TABLE bookmarks ADD COLUMN repost_count INTEGER CHECK (repost_count >= 0);
ALTER TABLE bookmarks ADD COLUMN reply_count INTEGER CHECK (reply_count >= 0);
ALTER TABLE bookmarks ADD COLUMN quote_count INTEGER CHECK (quote_count >= 0);
ALTER TABLE bookmarks ADD COLUMN bookmark_count INTEGER CHECK (bookmark_count >= 0);
ALTER TABLE bookmarks ADD COLUMN view_count INTEGER CHECK (view_count >= 0);

-- The bookmarks timeline's ordering value, larger meaning nearer the top. It
-- exceeds 2^53, so it is text; order by CAST(sort_index AS INTEGER).
ALTER TABLE bookmarks ADD COLUMN sort_index TEXT CHECK (sort_index GLOB '[0-9]*' AND sort_index NOT GLOB '*[^0-9]*');

-- An estimate of when the bookmark was made: sort_index >> 20 read as Unix
-- milliseconds, kept only when it falls between the post's time and the
-- capture's. It is derived from X's data and is a different thing from
-- first_seen_at, which it never replaces or changes.
ALTER TABLE bookmarks ADD COLUMN estimated_bookmarked_at INTEGER
  CHECK (estimated_bookmarked_at > 1000000000000);

-- The result of the latest parse of each raw capture. Unlike the capture it
-- is derived data: a re-parse replaces it. A capture with no row here has not
-- been parsed yet.
--   parsed     the response was understood (it may still hold no bookmarks,
--              and single entries in it may have failed)
--   failed     the response as a whole was not understood
--   no-parser  nothing parses this operation yet; not a failure
CREATE TABLE capture_parses (
  capture_id INTEGER PRIMARY KEY REFERENCES raw_captures (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('parsed', 'failed', 'no-parser')),
  parser_version INTEGER NOT NULL CHECK (parser_version > 0),
  bookmark_count INTEGER NOT NULL CHECK (bookmark_count >= 0),
  unavailable_count INTEGER NOT NULL CHECK (unavailable_count >= 0),
  failed_entry_count INTEGER NOT NULL CHECK (failed_entry_count >= 0),
  warning_count INTEGER NOT NULL CHECK (warning_count >= 0),
  parsed_at INTEGER NOT NULL CHECK (parsed_at > 1000000000000)
) STRICT;

-- Everything the latest parse of a capture could not turn into a bookmark,
-- or could only partly. Structure only: a path into the payload, field names
-- and type names, never a value from the response.
--   capture-failed    why a 'failed' capture was not understood
--   entry-failed      one entry that was not understood; nothing was taken from it
--   post-unavailable  one bookmark whose post X withholds (deleted, restricted)
--   warning           a part that was left empty; the bookmark itself was stored
CREATE TABLE parse_issues (
  id INTEGER PRIMARY KEY,
  capture_id INTEGER NOT NULL REFERENCES capture_parses (capture_id),
  kind TEXT NOT NULL
    CHECK (kind IN ('capture-failed', 'entry-failed', 'post-unavailable', 'warning')),
  entry_index INTEGER CHECK (entry_index >= 0),
  entry_id TEXT,
  post_id TEXT CHECK (post_id GLOB '[0-9]*' AND post_id NOT GLOB '*[^0-9]*'),
  code TEXT NOT NULL CHECK (length(code) > 0),
  path TEXT NOT NULL CHECK (length(path) > 0),
  detail TEXT NOT NULL
) STRICT;

CREATE INDEX parse_issues_capture_id ON parse_issues (capture_id);
`,
};
