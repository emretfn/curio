import type { Migration } from "../migrate.ts";

/** The tags the library starts with, as taxonomy version 1 listed them. */
const STARTER_TAGS = [
  "claude-code",
  "open-source",
  "prompts",
  "agent-skills",
  "react",
  "animation",
  "ui-components",
  "cursor",
  "chatgpt",
  "nextjs",
  "codex",
  "shadcn-ui",
  "mcp",
  "vibe-coding",
  "gemini",
  "react-native",
  "ai-pricing",
  "ads",
  "image-generation",
  "swiftui",
  "tailwind",
  "cloudflare",
  "paywall",
  "career",
  "app-screenshots",
  "auth",
  "app-ideas",
  "self-hosting",
  "security",
  "aso",
  "agent-rules",
  "seo",
];

/** Other ways those tags are written, folded as `foldTagText` folds a text. */
const STARTER_ALIASES: [alias: string, tag: string][] = [
  ["reklam", "ads"],
  ["uygulama-fikri", "app-ideas"],
  ["gorsel-uretimi", "image-generation"],
  ["acik-kaynak", "open-source"],
  ["guvenlik", "security"],
  ["ozgecmis", "career"],
  ["resume", "career"],
  ["cc", "claude-code"],
  ["rn", "react-native"],
  ["expo", "react-native"],
  ["next.js", "nextjs"],
  ["shadcn", "shadcn-ui"],
  ["claude.md", "agent-rules"],
  ["agents.md", "agent-rules"],
  ["cursorrules", "agent-rules"],
  ["vibecoding", "vibe-coding"],
];

const NOW = "CAST(unixepoch() AS INTEGER) * 1000";

export const migration: Migration = {
  version: 7,
  name: "vocabulary",
  sql: `
-- The tag vocabulary moves out of the code and into the database, so that
-- the owner can add a tag, retire one, rename one or make one another name
-- for a second, from the interface, with nothing to edit. From here on these
-- two tables and tag_aliases are the vocabulary, and nothing else is: the
-- lists above are what it starts as, written once by this migration.
-- Categories and formats stay in src/taxonomy.ts.

-- Every change to the vocabulary, in order. The latest version is the
-- vocabulary's version. Version 1 is the starter set.
--   add      a tag joined: created by the owner, or a proposal accepted
--   restore  a retired tag came back
--   retire   a tag left; the bookmarks keep their rows and lose the tag
--   rename   tag is the new name, other the old one, now an alias of it
--   merge    other became another name for tag, and its bookmarks follow
--   alias    other became another way of writing tag
--   unalias  other stopped being another way of writing tag
CREATE TABLE vocabulary_changes (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  change TEXT NOT NULL CHECK (change IN (
    'starter', 'add', 'restore', 'retire', 'rename', 'merge', 'alias',
    'unalias')),
  tag TEXT CHECK (length(tag) > 0),
  other TEXT CHECK (length(other) > 0),
  changed_at INTEGER NOT NULL CHECK (changed_at > 1000000000000),
  CHECK ((change = 'starter') = (tag IS NULL))
) STRICT;

INSERT INTO vocabulary_changes (version, change, changed_at)
VALUES (1, 'starter', ${NOW});

-- The tags there are. A retired tag stays as a row, so that the bookmarks
-- that had it get it back if it is restored, and so that its name is not
-- proposed again.
--   added_version  the vocabulary version that first held it, or that
--                  restored it. A bookmark classified under an earlier
--                  version was never asked about it.
CREATE TABLE tags (
  tag TEXT PRIMARY KEY CHECK (length(tag) > 0),
  origin TEXT NOT NULL CHECK (origin IN ('starter', 'owner')),
  added_version INTEGER NOT NULL REFERENCES vocabulary_changes (version),
  added_at INTEGER NOT NULL CHECK (added_at > 1000000000000),
  retired_at INTEGER CHECK (retired_at > 1000000000000)
) STRICT, WITHOUT ROWID;

INSERT INTO tags (tag, origin, added_version, added_at) VALUES
${STARTER_TAGS.map((tag) => `  ('${tag}', 'starter', 1, ${NOW})`).join(",\n")};

-- The aliases the taxonomy shipped with join the owner's own in
-- tag_aliases, which is now the one place an alias is kept.
INSERT OR IGNORE INTO tag_aliases (alias, tag, decided_at) VALUES
${STARTER_ALIASES.map(([alias, tag]) => `  ('${alias}', '${tag}', ${NOW})`).join(",\n")};

-- Which vocabulary a classification was made against. Everything
-- classified before this migration was asked about the starter set, which
-- is version 1.
ALTER TABLE bookmark_classifications ADD COLUMN vocabulary_version INTEGER
  NOT NULL DEFAULT 1 CHECK (vocabulary_version > 0);

-- A run gains the vocabulary version it asked with, and a fourth mode:
--   new-tags  asks again about bookmarks classified before a tag joined the
--             vocabulary, and adds to each only tags it was never offered
-- The list of modes is a CHECK, which SQLite cannot alter, so the table is
-- made again and its rows copied as they are. Nothing refers to it. The
-- version has a default so that an app still running the code of migration
-- 6, which knows no vocabulary but the starter set, can go on recording its
-- runs until it is restarted.
CREATE TABLE tagging_runs_with_vocabulary (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL CHECK (started_at > 1000000000000),
  heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at > 1000000000000),
  finished_at INTEGER CHECK (finished_at > 1000000000000),
  started_by TEXT NOT NULL CHECK (started_by IN ('owner', 'app')),
  mode TEXT NOT NULL
    CHECK (mode IN ('sample', 'untagged', 'retag', 'new-tags')),
  transport TEXT NOT NULL CHECK (transport IN ('direct', 'batch')),
  model TEXT NOT NULL CHECK (length(model) > 0),
  taxonomy_version INTEGER NOT NULL CHECK (taxonomy_version > 0),
  instructions_version INTEGER NOT NULL CHECK (instructions_version > 0),
  vocabulary_version INTEGER NOT NULL DEFAULT 1
    CHECK (vocabulary_version > 0),
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

INSERT INTO tagging_runs_with_vocabulary (
  id, started_at, heartbeat_at, finished_at, started_by, mode, transport,
  model, taxonomy_version, instructions_version, vocabulary_version, outcome,
  failure, batch_id, batch_post_ids, selected, classified, failed,
  input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
  cost_usd, unanswered_requests, cap_usd
)
SELECT
  id, started_at, heartbeat_at, finished_at, started_by, mode, transport,
  model, taxonomy_version, instructions_version, 1, outcome,
  failure, batch_id, batch_post_ids, selected, classified, failed,
  input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
  cost_usd, unanswered_requests, cap_usd
FROM tagging_runs;

DROP TABLE tagging_runs;
ALTER TABLE tagging_runs_with_vocabulary RENAME TO tagging_runs;

CREATE UNIQUE INDEX tagging_runs_one_open
  ON tagging_runs ((finished_at IS NULL)) WHERE finished_at IS NULL;

-- The tags a bookmark has are now only tags the vocabulary holds: the
-- classifier's, less any the owner has spoken on, plus those the owner
-- added, and of all those the ones that are not retired.
DROP VIEW bookmark_effective_tags;
CREATE VIEW bookmark_effective_tags AS
SELECT t.post_id AS post_id, t.tag AS tag
FROM bookmark_tags t
JOIN tags v ON v.tag = t.tag AND v.retired_at IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM bookmark_tag_corrections x
  WHERE x.post_id = t.post_id AND x.tag = t.tag)
UNION ALL
SELECT x.post_id AS post_id, x.tag AS tag
FROM bookmark_tag_corrections x
JOIN tags v ON v.tag = x.tag AND v.retired_at IS NULL
WHERE x.action = 'add';
`,
};
