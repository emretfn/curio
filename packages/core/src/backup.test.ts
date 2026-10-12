import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { backupStore, listSnapshots, verifySnapshot } from "./backup.ts";
import { getBookmark } from "./bookmarks.ts";
import { parseCapture } from "./parsing.ts";
import { getRawCapture, insertRawCapture } from "./raw-captures.ts";
import type { Store } from "./store.ts";
import { readFixture } from "./testing/fixtures.ts";
import { openTempStore, tempDatabasePath } from "./testing/temp-database.ts";

const page = readFixture("x-web-client/Bookmarks/2026-10-12-text-posts.json");
const POST: string =
  JSON.parse(
    page,
  ).data.bookmark_timeline_v2.timeline.instructions[0].entries[0].entryId.slice(
    6,
  );
const at = (hour: number) => new Date(Date.UTC(2026, 9, 12, hour));
const DAY_MS = 24 * 60 * 60 * 1000;

/** A library holding one parsed page, and a directory beside it for its snapshots. */
function library(): { store: Store; directory: string } {
  const path = tempDatabasePath();
  const store = openTempStore(path);
  addCapture(store);
  return { store, directory: join(dirname(path), "snapshots") };
}

function addCapture(store: Store, payload = page): number {
  const { id } = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks",
    receivedAt: at(8),
  });
  parseCapture(store, id);
  return id;
}

test("a snapshot is one verified file that holds the captures and the bookmarks", () => {
  const { store, directory } = library();

  const result = backupStore(store, { directory, now: at(10) });

  expect(result).toEqual({
    status: "written",
    snapshot: {
      name: "snapshot-20261012T100000Z.db",
      path: join(directory, "snapshot-20261012T100000Z.db"),
      takenAt: at(10),
      bytes: expect.any(Number),
    },
    rawCaptures: 1,
    bookmarks: 5,
    pruned: [],
  });
  expect(readdirSync(directory)).toEqual(["snapshot-20261012T100000Z.db"]);
  expect(listSnapshots(directory)).toEqual(
    result.status === "written" ? [result.snapshot] : [],
  );
  const restored = openTempStore(
    join(directory, "snapshot-20261012T100000Z.db"),
    {
      readOnly: true,
    },
  );
  expect(getRawCapture(restored, 1)).toEqual(getRawCapture(store, 1));
  expect(getBookmark(restored, POST)).toEqual(getBookmark(store, POST));
});

test("the directory and the snapshot are readable by their owner alone", () => {
  const { store, directory } = library();

  backupStore(store, { directory, now: at(10) });

  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(
    statSync(join(directory, "snapshot-20261012T100000Z.db")).mode & 0o777,
  ).toBe(0o600);
});

test("a library that has not changed is not copied twice, and one that has is", () => {
  const { store, directory } = library();
  backupStore(store, { directory, now: at(10) });

  expect(backupStore(store, { directory, now: at(11) })).toMatchObject({
    status: "unchanged",
    snapshot: { name: "snapshot-20261012T100000Z.db" },
  });
  expect(readdirSync(directory)).toEqual(["snapshot-20261012T100000Z.db"]);

  addCapture(store, '{"errors":[]}');

  expect(backupStore(store, { directory, now: at(12) })).toMatchObject({
    status: "written",
    rawCaptures: 2,
  });
  expect(listSnapshots(directory).map(({ name }) => name)).toEqual([
    "snapshot-20261012T120000Z.db",
    "snapshot-20261012T100000Z.db",
  ]);
});

test("with a minimum interval, nothing is taken while the latest snapshot is younger than it", () => {
  const { store, directory } = library();
  backupStore(store, { directory, now: at(10) });
  addCapture(store, '{"errors":[]}');
  const dayLater = new Date(at(10).getTime() + DAY_MS);

  expect(
    backupStore(store, { directory, now: at(23), minIntervalMs: DAY_MS }),
  ).toMatchObject({
    status: "recent",
    snapshot: { name: "snapshot-20261012T100000Z.db" },
  });
  expect(
    backupStore(store, { directory, now: dayLater, minIntervalMs: DAY_MS }),
  ).toMatchObject({ status: "written" });
});

test("the first snapshot is taken whatever the interval", () => {
  const { store, directory } = library();

  expect(
    backupStore(store, { directory, now: at(10), minIntervalMs: DAY_MS }),
  ).toMatchObject({ status: "written" });
});

test("a library with no captures is not snapshotted, and no directory is made for it", () => {
  const path = tempDatabasePath();
  const directory = join(dirname(path), "snapshots");

  expect(backupStore(openTempStore(path), { directory })).toEqual({
    status: "empty",
  });
  expect(existsSync(directory)).toBe(false);
});

test("only the newest snapshots are kept, and no file of another name is ever deleted", () => {
  const { store, directory } = library();
  mkdirSync(directory);
  const others = [
    "bookmarks-2026-10-12-2021.db",
    "snapshot-20261012T050000Z.db.bak",
    "snapshot-2026.db",
    "notes.txt",
  ];
  for (const name of others) writeFileSync(join(directory, name), "mine");
  for (const hour of [1, 2, 3, 4]) {
    addCapture(store, `{"errors":[${hour}]}`);
    backupStore(store, { directory, keep: 3, now: at(hour) });
  }
  addCapture(store, '{"errors":[5]}');

  expect(backupStore(store, { directory, keep: 2, now: at(5) })).toMatchObject({
    status: "written",
    pruned: ["snapshot-20261012T030000Z.db", "snapshot-20261012T020000Z.db"],
  });
  expect(readdirSync(directory).toSorted()).toEqual(
    [
      ...others,
      "snapshot-20261012T040000Z.db",
      "snapshot-20261012T050000Z.db",
    ].toSorted(),
  );
});

test("a file left half written by a run that was cut short is cleared away, and is never listed", () => {
  const { store, directory } = library();
  mkdirSync(directory);
  writeFileSync(join(directory, "snapshot-20261012T090000Z.db.partial"), "cut");

  expect(listSnapshots(directory)).toEqual([]);
  backupStore(store, { directory, now: at(10) });

  expect(readdirSync(directory)).toEqual(["snapshot-20261012T100000Z.db"]);
});

test("a backup that cannot be written throws, and leaves nothing behind", () => {
  const { store, directory } = library();
  writeFileSync(directory, "a file where the directory should be");

  expect(() => backupStore(store, { directory, now: at(10) })).toThrow(
    /EEXIST|ENOTDIR/,
  );
  expect(statSync(directory).isFile()).toBe(true);
});

test("a snapshot is never overwritten", () => {
  const { store, directory } = library();
  backupStore(store, { directory, now: at(10) });
  addCapture(store, '{"errors":[]}');

  expect(() => backupStore(store, { directory, now: at(10) })).toThrow(
    /already exists/,
  );
  expect(readdirSync(directory)).toEqual(["snapshot-20261012T100000Z.db"]);
});

test.each([0, 1.5, -1])("keeping %s snapshots is refused", (keep) => {
  const { store, directory } = library();

  expect(() => backupStore(store, { directory, keep })).toThrow(RangeError);
});

/** A copy of a good snapshot, for damaging. */
function snapshotCopy(): { store: Store; copy: string } {
  const { store, directory } = library();
  backupStore(store, { directory, now: at(10) });
  const copy = join(directory, "copy.db");
  copyFileSync(join(directory, "snapshot-20261012T100000Z.db"), copy);
  return { store, copy };
}

test("verification passes a good snapshot", () => {
  const { store, copy } = snapshotCopy();

  expect(verifySnapshot(copy, store)).toMatchObject({
    rawCaptures: 1,
    bookmarks: 5,
  });
});

test("verification catches a raw capture that differs by one character", () => {
  const { store, copy } = snapshotCopy();
  const db = new Database(copy);
  db.exec("DROP TRIGGER raw_captures_no_update");
  db.prepare(
    "UPDATE raw_captures SET payload = replace(payload, 'Tweet', 'Tweat')",
  ).run();
  db.close();

  expect(() => verifySnapshot(copy, store)).toThrow(
    /a raw capture in the snapshot differs/,
  );
});

test("verification catches a raw capture whose request was lost", () => {
  const { store, copy } = snapshotCopy();
  const db = new Database(copy);
  db.exec("DROP TRIGGER raw_captures_no_update");
  db.prepare("UPDATE raw_captures SET request_url = NULL").run();
  db.close();

  expect(() => verifySnapshot(copy, store)).toThrow(
    /a raw capture in the snapshot differs/,
  );
});

test("verification catches a snapshot that is missing captures", () => {
  const { store, copy } = snapshotCopy();
  const db = new Database(copy);
  db.exec("DROP TRIGGER raw_captures_no_delete; PRAGMA foreign_keys = OFF");
  db.prepare("DELETE FROM raw_captures").run();
  db.close();

  expect(() => verifySnapshot(copy, store)).toThrow(
    /holds 0 raw captures, and the database held 1 before/,
  );
});

test("verification catches a snapshot of another schema", () => {
  const { store, copy } = snapshotCopy();
  const db = new Database(copy);
  db.prepare(
    "UPDATE schema_migrations SET checksum = 'other' WHERE version = 1",
  ).run();
  db.close();

  expect(() => verifySnapshot(copy, store)).toThrow(
    /schema is not the database's/,
  );
});

test("verification catches a file damaged on disk", () => {
  const { store, copy } = snapshotCopy();
  const file = openSync(copy, "r+");
  writeSync(file, Buffer.alloc(8192, 0xff), 0, 8192, 4096);

  expect(() => verifySnapshot(copy, store)).toThrow();
});
