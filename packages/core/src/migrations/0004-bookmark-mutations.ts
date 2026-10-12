import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 4,
  name: "bookmark-mutations",
  sql: `
-- What the captured mutations say about a post: the last time X confirmed
-- that it was bookmarked (CreateBookmark) and the last time X confirmed that
-- its bookmark was removed (DeleteBookmark), each with the capture that says
-- so. A mutation carries a post id and nothing else, so a row can exist for a
-- post the library holds no bookmark of, and waits for one.
--
-- It is derived data, written by parseCapture alone. Each column pair holds
-- the latest capture of its kind, so the row is the same whatever order the
-- captures are parsed in.
--
-- Whether a bookmark counts as removed on X is not stored. It is read from
-- this row and the bookmark's own last sighting: removed when removed_at is
-- later than both bookmarked_at and the bookmark's last_seen_at, because a
-- later CreateBookmark, or a later page of the timeline that lists the post,
-- shows it was bookmarked again.
CREATE TABLE bookmark_mutations (
  post_id TEXT PRIMARY KEY CHECK (post_id GLOB '[0-9]*' AND post_id NOT GLOB '*[^0-9]*'),
  bookmarked_at INTEGER CHECK (bookmarked_at > 1000000000000),
  bookmarked_capture_id INTEGER REFERENCES raw_captures (id),
  removed_at INTEGER CHECK (removed_at > 1000000000000),
  removed_capture_id INTEGER REFERENCES raw_captures (id),
  CHECK ((bookmarked_at IS NULL) = (bookmarked_capture_id IS NULL)),
  CHECK ((removed_at IS NULL) = (removed_capture_id IS NULL)),
  CHECK (bookmarked_at IS NOT NULL OR removed_at IS NOT NULL)
) STRICT;
`,
};
