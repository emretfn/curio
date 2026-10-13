import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 6,
  name: "labels",
  sql: `
-- What a bookmark is filed under: one category, one format and a few tags,
-- from the taxonomy of src/taxonomy.ts. Two hands write here and each has
-- tables of its own. The classifier writes bookmark_classifications and
-- bookmark_tags, and replaces them whenever it classifies a bookmark again.
-- The owner writes bookmark_corrections and bookmark_tag_corrections, which
-- the classifier never touches. What a bookmark is filed under is read from
-- both, the owner's word first, so no later run can undo a correction.
--
-- Categories, formats and tags are stored by their ids and are not checked
-- against a list here: the list is data in the code and changes with a
-- version, not with a migration. Core's functions check what they write.

-- The classifier's latest answer for a bookmark, and what produced it.
--   too_little_text       the stored text was too little to tell, which is
--                         one of the two reasons for the category "other"
--   proposed_tags         tags it suggested that the vocabulary does not
--                         hold: a JSON array, kept apart and never applied
--   taxonomy_version      the version of src/taxonomy.ts it was given
--   instructions_version  the version of the classifier's own instructions
--   model                 the model that answered. Null where none was
--                         asked, because nothing stored was worth sending.
CREATE TABLE bookmark_classifications (
  post_id TEXT PRIMARY KEY REFERENCES bookmarks (post_id),
  category TEXT NOT NULL CHECK (length(category) > 0),
  format TEXT NOT NULL CHECK (length(format) > 0),
  too_little_text INTEGER NOT NULL CHECK (too_little_text IN (0, 1)),
  proposed_tags TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(proposed_tags) AND json_type(proposed_tags) = 'array'),
  taxonomy_version INTEGER NOT NULL CHECK (taxonomy_version > 0),
  instructions_version INTEGER NOT NULL CHECK (instructions_version > 0),
  model TEXT CHECK (length(model) > 0),
  classified_at INTEGER NOT NULL CHECK (classified_at > 1000000000000),
  CHECK (model IS NOT NULL OR too_little_text = 1)
) STRICT;

-- The tags of the vocabulary the classifier gave a bookmark.
CREATE TABLE bookmark_tags (
  post_id TEXT NOT NULL REFERENCES bookmark_classifications (post_id),
  tag TEXT NOT NULL CHECK (length(tag) > 0),
  PRIMARY KEY (post_id, tag)
) STRICT, WITHOUT ROWID;

CREATE INDEX bookmark_tags_tag ON bookmark_tags (tag);

-- The owner's own category or format for a bookmark. A null column is one
-- the owner left to the classifier.
CREATE TABLE bookmark_corrections (
  post_id TEXT PRIMARY KEY REFERENCES bookmarks (post_id),
  category TEXT CHECK (length(category) > 0),
  format TEXT CHECK (length(format) > 0),
  corrected_at INTEGER NOT NULL CHECK (corrected_at > 1000000000000),
  CHECK (category IS NOT NULL OR format IS NOT NULL)
) STRICT;

-- The owner's word on one tag of one bookmark: 'add' puts it on, 'remove'
-- keeps it off, whatever the classifier says now or later.
CREATE TABLE bookmark_tag_corrections (
  post_id TEXT NOT NULL REFERENCES bookmarks (post_id),
  tag TEXT NOT NULL CHECK (length(tag) > 0),
  action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  corrected_at INTEGER NOT NULL CHECK (corrected_at > 1000000000000),
  PRIMARY KEY (post_id, tag)
) STRICT, WITHOUT ROWID;

CREATE INDEX bookmark_tag_corrections_tag ON bookmark_tag_corrections (tag);

-- The tags a bookmark has: the classifier's, less any the owner has spoken
-- on, plus those the owner added. Filters, counts and the bookmark record
-- all read tags from here and nowhere else.
CREATE VIEW bookmark_effective_tags AS
SELECT t.post_id AS post_id, t.tag AS tag
FROM bookmark_tags t
WHERE NOT EXISTS (
  SELECT 1 FROM bookmark_tag_corrections x
  WHERE x.post_id = t.post_id AND x.tag = t.tag)
UNION ALL
SELECT x.post_id AS post_id, x.tag AS tag
FROM bookmark_tag_corrections x
WHERE x.action = 'add';

-- Other ways of writing a tag that the owner decided on, beside the aliases
-- the taxonomy ships with. An alias is stored folded, as foldTagText of
-- src/taxonomy.ts leaves it. A null tag is the owner's decision that the
-- text is no tag at all, which takes a suggestion off the list of proposals.
CREATE TABLE tag_aliases (
  alias TEXT PRIMARY KEY CHECK (length(alias) > 0),
  tag TEXT CHECK (length(tag) > 0),
  decided_at INTEGER NOT NULL CHECK (decided_at > 1000000000000)
) STRICT, WITHOUT ROWID;

-- A bookmark the classifier was asked about and gave no usable answer for,
-- so that it is not asked again without end. A code and a count, never
-- anything the post or the model said. The row goes when the bookmark is
-- classified.
--   refused         the model declined the request
--   cut-short       the answer ran out of room before it was complete
--   invalid-output  the answer was not what the taxonomy allows
--   rejected        the API refused the request for this one bookmark
CREATE TABLE classification_failures (
  post_id TEXT PRIMARY KEY REFERENCES bookmarks (post_id),
  reason TEXT NOT NULL
    CHECK (reason IN ('refused', 'cut-short', 'invalid-output', 'rejected')),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  taxonomy_version INTEGER NOT NULL CHECK (taxonomy_version > 0),
  instructions_version INTEGER NOT NULL CHECK (instructions_version > 0),
  failed_at INTEGER NOT NULL CHECK (failed_at > 1000000000000)
) STRICT;

-- One run of the classifier: what it set out to do, what it used and what
-- came of it. This is the record of what was spent, the place a batch's id
-- is kept while it is processed, so that an interrupted run takes its
-- results up again and does not pay for them twice, and what stops two runs
-- working at once.
--   started_by      'owner' for pnpm tag, 'app' for the app's own passes
--   outcome         null while the run is open
--   failure         why a failed run failed: a code, never content
--   batch_post_ids  the bookmarks of a batch, in the order of its requests,
--                   which are numbered so that no post id is sent
--   cost_usd        worked out from the tokens the API reported and the
--                   prices of the day; the invoice is the authority
--   unanswered_requests
--                   attempts that went out and brought no answer back. The
--                   API may have charged for each, and they are in no token
--                   count and so not in cost_usd
CREATE TABLE tagging_runs (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL CHECK (started_at > 1000000000000),
  heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at > 1000000000000),
  finished_at INTEGER CHECK (finished_at > 1000000000000),
  started_by TEXT NOT NULL CHECK (started_by IN ('owner', 'app')),
  mode TEXT NOT NULL CHECK (mode IN ('sample', 'untagged', 'retag')),
  transport TEXT NOT NULL CHECK (transport IN ('direct', 'batch')),
  model TEXT NOT NULL CHECK (length(model) > 0),
  taxonomy_version INTEGER NOT NULL CHECK (taxonomy_version > 0),
  instructions_version INTEGER NOT NULL CHECK (instructions_version > 0),
  outcome TEXT
    CHECK (outcome IN ('completed', 'stopped-at-cap', 'failed', 'abandoned')),
  failure TEXT CHECK (length(failure) > 0),
  batch_id TEXT CHECK (length(batch_id) > 0),
  batch_post_ids TEXT
    CHECK (json_valid(batch_post_ids) AND json_type(batch_post_ids) = 'array'),
  selected INTEGER NOT NULL CHECK (selected >= 0),
  classified INTEGER NOT NULL DEFAULT 0 CHECK (classified >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  unanswered_requests INTEGER NOT NULL DEFAULT 0
    CHECK (unanswered_requests >= 0),
  cap_usd REAL NOT NULL CHECK (cap_usd >= 0),
  CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  CHECK ((batch_id IS NULL) = (batch_post_ids IS NULL))
) STRICT;

-- At most one run is open, whichever process asks.
CREATE UNIQUE INDEX tagging_runs_one_open
  ON tagging_runs ((finished_at IS NULL)) WHERE finished_at IS NULL;
`,
};
