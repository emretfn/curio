import Database from "better-sqlite3";
import { expect, onTestFinished, test } from "vitest";
import { getBookmark } from "../bookmarks.ts";
import { applyMigrations } from "../migrate.ts";
import {
  listTaggingRuns,
  recordTaggingProgress,
  startTaggingRun,
  summariseTagging,
} from "../tagging.ts";
import { openTempStore, tempDatabasePath } from "../testing/temp-database.ts";
import { migrations } from "./index.ts";

const posted = Date.parse("2026-04-08T06:30:15.000Z");
const received = Date.parse("2026-10-05T09:00:00.000Z");
const started = Date.parse("2026-10-06T10:00:00.000Z");
const minute = 60_000;
const postId = (n: number) => String(1975000000000000000n + BigInt(n));

/**
 * A database as migration 8 left it: five bookmarks, and two closed runs.
 * The first classified four of them, two with nothing worth sending; the
 * second, a `new-tags` run, asked one again.
 */
function databaseAtMigration8(): string {
  const path = tempDatabasePath();
  const db = new Database(path);
  onTestFinished(() => void db.close());
  applyMigrations(db, migrations.slice(0, 8));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES ('x-web-client', 'Bookmarks', '{}', ?)",
  ).run(received);
  const bookmark = db.prepare(
    `INSERT INTO bookmarks (
       post_id, author_id, author_handle, author_name, text, posted_at,
       first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
     ) VALUES (?, '44196397', 'someone', 'Some One', 'kept as it was', ?, ?, 1, ?, 1)`,
  );
  for (let n = 1; n <= 5; n += 1) {
    bookmark.run(postId(n), posted, received, received);
  }
  const classification = db.prepare(
    `INSERT INTO bookmark_classifications (
       post_id, category, format, too_little_text, taxonomy_version,
       instructions_version, vocabulary_version, model, classified_at
     ) VALUES (?, ?, ?, ?, 1, 2, 1, ?, ?)`,
  );
  classification.run(postId(1), "web-dev", "guide", 0, "a-model", started + 1);
  classification.run(postId(2), "web-dev", "guide", 0, "a-model", started + 2);
  // Filed without a request, by the first run.
  classification.run(postId(3), "other", "unclear", 1, null, started);
  classification.run(postId(4), "other", "unclear", 1, null, started);
  // Filed without a request by some earlier run, outside this one's time.
  classification.run(postId(5), "other", "unclear", 1, null, started - 1);
  const run = db.prepare(
    `INSERT INTO tagging_runs (
       started_at, heartbeat_at, finished_at, started_by, mode, transport,
       model, taxonomy_version, instructions_version, vocabulary_version,
       outcome, selected, classified, failed, cost_usd, unanswered_requests,
       cap_usd
     ) VALUES (?, ?, ?, ?, ?, 'direct', 'a-model', 1, 2, 1, 'completed', ?, ?, 0, ?, ?, 2)`,
  );
  run.run(
    started,
    started,
    started + minute,
    "owner",
    "untagged",
    4,
    4,
    0.5,
    3,
  );
  run.run(
    started + 2 * minute,
    started + 2 * minute,
    started + 3 * minute,
    "app",
    "new-tags",
    1,
    1,
    0.25,
    0,
  );
  db.close();
  return path;
}

test("a library from before the migration is unchanged, and its runs keep every figure they had", () => {
  const path = databaseAtMigration8();
  const before = new Database(path, { readonly: true });
  const runs = before.prepare("SELECT * FROM tagging_runs ORDER BY id").all();
  before.close();
  const store = openTempStore(path);

  expect(getBookmark(store, postId(1))).toMatchObject({
    text: "kept as it was",
    labels: { category: "web-dev", format: "guide" },
  });
  expect(summariseTagging(store)).toMatchObject({
    bookmarks: 5,
    classified: 5,
    spentUsd: 0.75,
  });
  store.close();
  const db = new Database(path, { readonly: true });
  onTestFinished(() => void db.close());
  expect(db.prepare("SELECT * FROM tagging_runs ORDER BY id").all()).toEqual([
    { ...(runs[0] as object), held_usd: 0, filed_without_request: 2 },
    { ...(runs[1] as object), held_usd: 0, filed_without_request: 0 },
  ]);
});

test("an earlier run's bookmarks filed without a request are read off the library, and what it held is not guessed", () => {
  const store = openTempStore(databaseAtMigration8());

  const [second, first] = listTaggingRuns(store);

  // Two of the first run's four named no model and fall inside its time.
  // It had three unanswered attempts; what it held for them was never
  // written down, and stays nothing.
  expect(first).toMatchObject({
    classified: 4,
    filedWithoutRequest: 2,
    unansweredRequests: 3,
    heldUsd: 0,
  });
  // A run that only adds tags files nothing.
  expect(second).toMatchObject({
    mode: "new-tags",
    filedWithoutRequest: 0,
    heldUsd: 0,
  });
});

test("a run after the migration records both figures, and neither can be negative", () => {
  const path = databaseAtMigration8();
  const store = openTempStore(path);
  const opened = startTaggingRun(store, {
    startedBy: "app",
    mode: "untagged",
    transport: "direct",
    model: "a-model",
    instructionsVersion: 2,
    selected: 3,
    capUsd: 0.1,
  });
  const progress = {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    classified: 2,
    failed: 0,
    costUsd: 0,
  };

  recordTaggingProgress(store, opened.id, {
    ...progress,
    heldUsd: 0.004,
    filedWithoutRequest: 2,
  });

  expect(listTaggingRuns(store)[0]).toMatchObject({
    heldUsd: 0.004,
    filedWithoutRequest: 2,
  });
  expect(() =>
    recordTaggingProgress(store, opened.id, { ...progress, heldUsd: -1 }),
  ).toThrow(/CHECK/);
  expect(() =>
    recordTaggingProgress(store, opened.id, {
      ...progress,
      filedWithoutRequest: -1,
    }),
  ).toThrow(/CHECK/);
});
