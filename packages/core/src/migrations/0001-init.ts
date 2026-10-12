import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 1,
  name: "init",
  sql: `
-- Every timestamp column is an INTEGER holding Unix epoch milliseconds (UTC).
-- The lower bound rejects values written in seconds by mistake.

-- A response exactly as it arrived, kept so parsers can be re-run when X
-- changes its response shapes. Rows are write-once: see the triggers below.
CREATE TABLE raw_captures (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (length(source) > 0),
  operation TEXT NOT NULL CHECK (length(operation) > 0),
  request_url TEXT,
  payload TEXT NOT NULL CHECK (length(payload) > 0),
  received_at INTEGER NOT NULL CHECK (received_at > 1000000000000)
) STRICT;

CREATE TRIGGER raw_captures_no_update
BEFORE UPDATE ON raw_captures
BEGIN
  SELECT RAISE(ABORT, 'raw_captures rows are never updated');
END;

CREATE TRIGGER raw_captures_no_delete
BEFORE DELETE ON raw_captures
BEGIN
  SELECT RAISE(ABORT, 'raw_captures rows are never deleted');
END;

-- One row per bookmarked post. The integer id exists only to give a
-- full-text index a stable rowid; post_id is the key everything else uses.
CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE CHECK (post_id GLOB '[0-9]*' AND post_id NOT GLOB '*[^0-9]*'),
  author_id TEXT NOT NULL CHECK (author_id GLOB '[0-9]*' AND author_id NOT GLOB '*[^0-9]*'),
  text TEXT NOT NULL,
  posted_at INTEGER NOT NULL CHECK (posted_at > 1000000000000),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at > 1000000000000),
  first_seen_capture_id INTEGER NOT NULL REFERENCES raw_captures (id),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
  last_seen_capture_id INTEGER NOT NULL REFERENCES raw_captures (id)
) STRICT;

CREATE INDEX bookmarks_first_seen_at ON bookmarks (first_seen_at);

-- X exposes no "bookmarked at" time, so first_seen_at is the only record of
-- when a bookmark entered the library. Nothing may rewrite it.
CREATE TRIGGER bookmarks_first_seen_is_immutable
BEFORE UPDATE OF first_seen_at, first_seen_capture_id ON bookmarks
WHEN NEW.first_seen_at IS NOT OLD.first_seen_at
  OR NEW.first_seen_capture_id IS NOT OLD.first_seen_capture_id
BEGIN
  SELECT RAISE(ABORT, 'bookmarks.first_seen_at is set once and never overwritten');
END;
`,
};
