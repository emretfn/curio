import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { getBookmark } from "../bookmarks.ts";
import { listBookmarks } from "../library.ts";
import { applyMigrations } from "../migrate.ts";
import { summariseTagging } from "../tagging.ts";
import { openTempStore, tempDatabasePath } from "../testing/temp-database.ts";
import { getVocabulary, listTags, resolveTag } from "../vocabulary.ts";
import { migrations } from "./index.ts";

const posted = Date.parse("2026-04-08T06:30:15.000Z");
const received = Date.parse("2026-10-05T09:00:00.000Z");
const classified = Date.parse("2026-10-13T01:00:00.000Z");
const POST = "1975000000000000001";
const OTHER = "1975000000000000002";

/**
 * A database as migration 6 left it, with what a first run of the
 * classifier and an owner at work would have put there: two classified
 * bookmarks with tags and a proposal, a correction, an alias of the owner's
 * and a closed run.
 */
function databaseAtMigration6(): string {
  const path = tempDatabasePath();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 6));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES ('x-web-client', 'Bookmarks', '{}', ?)",
  ).run(received);
  const bookmark = db.prepare(
    `INSERT INTO bookmarks (
       post_id, author_id, author_handle, author_name, text, posted_at,
       first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
     ) VALUES (?, '44196397', 'someone', 'Some One', 'kept as it was', ?, ?, 1, ?, 1)`,
  );
  const classification = db.prepare(
    `INSERT INTO bookmark_classifications (
       post_id, category, format, too_little_text, proposed_tags,
       taxonomy_version, instructions_version, model, classified_at
     ) VALUES (?, 'web-dev', 'guide', 0, ?, 1, 1, 'a-model', ?)`,
  );
  const tag = db.prepare(
    "INSERT INTO bookmark_tags (post_id, tag) VALUES (?, ?)",
  );
  for (const post of [POST, OTHER]) {
    bookmark.run(post, posted, received, received);
    classification.run(
      post,
      JSON.stringify(post === POST ? ["drizzle"] : []),
      classified,
    );
    tag.run(post, "react");
  }
  tag.run(POST, "nextjs");
  db.prepare(
    "INSERT INTO bookmark_tag_corrections (post_id, tag, action, corrected_at) VALUES (?, 'auth', 'add', ?)",
  ).run(OTHER, classified);
  db.prepare(
    "INSERT INTO tag_aliases (alias, tag, decided_at) VALUES ('nextauth', 'auth', ?), ('cc', 'cursor', ?), ('hot-take', NULL, ?)",
  ).run(classified, classified, classified);
  db.prepare(
    `INSERT INTO tagging_runs (
       started_at, heartbeat_at, finished_at, started_by, mode, transport, model,
       taxonomy_version, instructions_version, outcome, selected, classified, cost_usd, cap_usd
     ) VALUES (?, ?, ?, 'owner', 'sample', 'direct', 'a-model', 1, 1, 'completed', 2, 2, 0.0061, 2)`,
  ).run(classified, classified, classified);
  db.close();
  return path;
}

test("what was classified before the migration is as it was, and counts as asked about the starter vocabulary", () => {
  const store = openTempStore(databaseAtMigration6());

  expect(getBookmark(store, POST)?.labels).toEqual({
    category: "web-dev",
    format: "guide",
    tags: ["nextjs", "react"],
    corrected: { category: false, format: false, tags: false },
    classification: {
      category: "web-dev",
      format: "guide",
      tags: ["nextjs", "react"],
      proposedTags: ["drizzle"],
      tooLittleText: false,
      taxonomyVersion: 1,
      instructionsVersion: 1,
      vocabularyVersion: 1,
      model: "a-model",
      classifiedAt: new Date(classified),
    },
  });
  // The owner's added tag is still on its bookmark.
  expect(getBookmark(store, OTHER)?.labels.tags).toEqual(["auth", "react"]);
  expect(listBookmarks(store, { tags: ["react"] }).total).toBe(2);
  expect(summariseTagging(store)).toMatchObject({
    classified: 2,
    behindVocabulary: 0,
    spentUsd: 0.0061,
    lastRun: { outcome: "completed", vocabularyVersion: 1, classified: 2 },
  });
});

test("a run recorded before the migration is kept as it was, one run is still open at a time, and a run can be of the new kind", () => {
  const path = databaseAtMigration6();
  const before = new Database(path, { readonly: true });
  const run = before.prepare("SELECT * FROM tagging_runs").get() as Record<
    string,
    unknown
  >;
  before.close();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  const open = (mode: string) =>
    db
      .prepare(
        `INSERT INTO tagging_runs (
           started_at, heartbeat_at, started_by, mode, transport, model,
           taxonomy_version, instructions_version, vocabulary_version, selected, cap_usd
         ) VALUES (?, ?, 'app', ?, 'direct', 'a-model', 1, 2, 3, 1, 0.1)`,
      )
      .run(classified, classified, mode);

  expect(db.prepare("SELECT * FROM tagging_runs").all()).toEqual([
    { ...run, vocabulary_version: 1 },
  ]);
  expect(() => open("anything-else")).toThrow(/CHECK/);
  expect(() => open("new-tags")).not.toThrow();
  expect(() => open("untagged")).toThrow(/UNIQUE/);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'tagging_runs%' ORDER BY name",
      )
      .pluck()
      .all(),
  ).toEqual(["tagging_runs", "tagging_runs_one_open"]);
});

test("the vocabulary starts as the starter set, version 1, with its aliases", () => {
  const vocabulary = getVocabulary(openTempStore());

  expect(vocabulary.version).toBe(1);
  expect(vocabulary.tags).toHaveLength(32);
  expect(vocabulary.tags).toEqual(vocabulary.tags.toSorted());
  expect(vocabulary.tags).toContain("claude-code");
  expect(vocabulary.tags).toContain("seo");
  expect(Object.keys(vocabulary.aliases)).toHaveLength(16);
  expect(vocabulary.aliases).toMatchObject({
    reklam: "ads",
    "gorsel-uretimi": "image-generation",
    "next.js": "nextjs",
    "claude.md": "agent-rules",
    rn: "react-native",
  });
  for (const tag of Object.values(vocabulary.aliases)) {
    expect(vocabulary.tags).toContain(tag);
  }
});

test("every starter tag is marked as one, and none is retired", () => {
  const tags = listTags(openTempStore(), { includeRetired: true });

  expect(tags).toHaveLength(32);
  for (const tag of tags) {
    expect(tag).toMatchObject({
      origin: "starter",
      retiredAt: null,
      bookmarks: 0,
    });
  }
});

test("an alias the owner had already decided on is left as the owner decided it", () => {
  const store = openTempStore(databaseAtMigration6());

  // The starter set has "cc" for another tag; the owner's word came first.
  expect(resolveTag(store, "cc")).toBe("cursor");
  expect(resolveTag(store, "nextauth")).toBe("auth");
  expect(resolveTag(store, "hot-take")).toBeUndefined();
  expect(resolveTag(store, "reklam")).toBe("ads");
});

test("a tag on a bookmark that the vocabulary does not hold is on no bookmark after the migration, and nothing is deleted", () => {
  const path = databaseAtMigration6();
  const before = new Database(path);
  before
    .prepare("INSERT INTO bookmark_tags (post_id, tag) VALUES (?, 'left-over')")
    .run(POST);
  before.close();
  const store = openTempStore(path);

  expect(getBookmark(store, POST)?.labels.tags).toEqual(["nextjs", "react"]);
  store.close();
  const after = new Database(path);
  onTestFinished(() => void after.close());
  expect(
    after
      .prepare("SELECT count(*) FROM bookmark_tags WHERE tag = 'left-over'")
      .pluck()
      .get(),
  ).toBe(1);
});

test("the vocabulary's history starts with the starter set and takes one row a change", () => {
  const path = databaseAtMigration6();
  openTempStore(path).close();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  const insert = (values: Record<string, unknown>) =>
    db
      .prepare(
        "INSERT INTO vocabulary_changes (version, change, tag, other, changed_at) VALUES (@version, @change, @tag, @other, @at)",
      )
      .run({
        version: 2,
        change: "add",
        tag: "drizzle",
        other: null,
        at: classified,
        ...values,
      });

  expect(
    db.prepare("SELECT version, change, tag FROM vocabulary_changes").all(),
  ).toEqual([{ version: 1, change: "starter", tag: null }]);
  expect(() => insert({ change: "invented" })).toThrow(/CHECK/);
  expect(() => insert({ tag: null })).toThrow(/CHECK/);
  expect(() => insert({ change: "starter" })).toThrow(/CHECK/);
  expect(() => insert({})).not.toThrow();
  expect(() => insert({})).toThrow(/UNIQUE|PRIMARY/);
});
