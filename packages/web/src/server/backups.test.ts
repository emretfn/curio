import { readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openTempStore, tempDatabasePath } from "@x-bookmarks/core/testing";
import { afterEach, expect, test, vi } from "vitest";
import {
  BACKUP_INTERVAL_MS,
  backUpIfDue,
  backupDirectory,
  backupStatus,
  snapshotsKept,
  startBackups,
} from "./backups.ts";
import { insertRawCaptureOnce } from "./core.ts";

const at = (hour: number) => new Date(Date.UTC(2026, 9, 12, hour));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  const shared = globalThis as {
    __xBookmarksBackups?: { timer?: NodeJS.Timeout };
    __xBookmarks?: { store?: { close(): void } };
  };
  clearInterval(shared.__xBookmarksBackups?.timer);
  delete shared.__xBookmarksBackups;
  // The app's own store, which startBackups opens.
  shared.__xBookmarks?.store?.close();
  delete shared.__xBookmarks;
});

/** A library with one capture, in a temporary data directory that the app's settings point at. */
function setUp() {
  const path = tempDatabasePath();
  const data = dirname(path);
  vi.stubEnv("X_BOOKMARKS_DATA_DIR", data);
  vi.stubEnv("X_BOOKMARKS_BACKUP_DIR", "");
  vi.stubEnv("X_BOOKMARKS_BACKUP_KEEP", "");
  const store = openTempStore(path);
  let captures = 0;
  const capture = () =>
    insertRawCaptureOnce(store, {
      source: "x-web-client",
      operation: "Bookmarks",
      payload: "{}",
      captureKey: `capture-${++captures}`,
    });
  capture();
  return { store, data, capture, snapshots: join(data, "backups") };
}

test("by default snapshots are kept beside the repo, never inside it", () => {
  vi.stubEnv("X_BOOKMARKS_DATA_DIR", "");
  vi.stubEnv("X_BOOKMARKS_BACKUP_DIR", "");
  const repoRoot = join(import.meta.dirname, "../../../..");

  expect(backupDirectory()).toBe(
    join(dirname(repoRoot), `${basename(repoRoot)}-backups`),
  );
});

test("a data directory that was moved keeps its snapshots inside it, and a named directory wins over both", () => {
  const { data } = setUp();

  expect(backupDirectory()).toBe(join(data, "backups"));
  vi.stubEnv("X_BOOKMARKS_BACKUP_DIR", join(data, "elsewhere"));
  expect(backupDirectory()).toBe(join(data, "elsewhere"));
});

test.each([
  ["", undefined],
  ["3", 3],
])(
  "the number of snapshots kept is read from the setting %j",
  (setting, kept) => {
    vi.stubEnv("X_BOOKMARKS_BACKUP_KEEP", setting);

    expect(snapshotsKept()).toBe(kept);
  },
);

test.each(["0", "many", "2.5"])(
  "a setting of %j for the number kept is refused",
  (setting) => {
    vi.stubEnv("X_BOOKMARKS_BACKUP_KEEP", setting);

    expect(snapshotsKept).toThrow(/X_BOOKMARKS_BACKUP_KEEP/);
  },
);

test("a look takes the first snapshot, and the status says so", () => {
  const { store, snapshots } = setUp();
  expect(backupStatus()).toEqual({
    directory: snapshots,
    snapshots: 0,
    latest: null,
    lastAttempt: null,
    unreadable: null,
  });

  expect(backUpIfDue(() => store, at(10))).toEqual({
    at: at(10),
    outcome: "written",
  });

  expect(backupStatus()).toMatchObject({
    directory: snapshots,
    snapshots: 1,
    latest: { name: "snapshot-20261012T100000Z.db", takenAt: at(10) },
    lastAttempt: { at: at(10), outcome: "written" },
    unreadable: null,
  });
});

test("no more than one snapshot a day is taken, however often the app looks or restarts", () => {
  const { store, capture, snapshots } = setUp();
  backUpIfDue(() => store, at(10));
  capture();

  expect(backUpIfDue(() => store, at(11))).toMatchObject({ outcome: "recent" });
  expect(backUpIfDue(() => store, at(23))).toMatchObject({ outcome: "recent" });
  expect(readdirSync(snapshots)).toHaveLength(1);

  const nextDay = new Date(at(10).getTime() + BACKUP_INTERVAL_MS);
  expect(backUpIfDue(() => store, nextDay)).toMatchObject({
    outcome: "written",
  });
  expect(readdirSync(snapshots)).toHaveLength(2);
});

test("a day later with nothing new, no second copy is kept", () => {
  const { store, snapshots } = setUp();
  backUpIfDue(() => store, at(10));

  const nextDay = new Date(at(10).getTime() + BACKUP_INTERVAL_MS);
  expect(backUpIfDue(() => store, nextDay)).toMatchObject({
    outcome: "unchanged",
  });
  expect(readdirSync(snapshots)).toHaveLength(1);
});

test("the number kept follows the setting", () => {
  const { store, capture, snapshots } = setUp();
  vi.stubEnv("X_BOOKMARKS_BACKUP_KEEP", "2");

  for (const day of [0, 1, 2, 3]) {
    capture();
    backUpIfDue(
      () => store,
      new Date(at(10).getTime() + day * BACKUP_INTERVAL_MS),
    );
  }

  expect(readdirSync(snapshots).toSorted()).toEqual([
    "snapshot-20261014T100000Z.db",
    "snapshot-20261015T100000Z.db",
  ]);
});

test("a backup that fails does not throw, is logged, and stays on the status until one succeeds", () => {
  const { store, data } = setUp();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  // A file where the directory should be: nothing can be written there.
  writeFileSync(join(data, "blocked"), "");
  vi.stubEnv("X_BOOKMARKS_BACKUP_DIR", join(data, "blocked", "snapshots"));

  const attempt = backUpIfDue(() => store, at(10));

  expect(attempt).toMatchObject({ at: at(10), outcome: "failed" });
  expect(attempt.outcome === "failed" && attempt.reason).toMatch(/ENOTDIR/);
  expect(logged).toHaveBeenCalledWith(
    expect.stringMatching(
      /^The backup of the library failed.* The reason: ENOTDIR/,
    ),
  );
  expect(backupStatus()).toMatchObject({
    snapshots: 0,
    latest: null,
    lastAttempt: {
      outcome: "failed",
      reason: expect.stringMatching(/ENOTDIR/),
    },
    unreadable: expect.stringMatching(/ENOTDIR/),
  });

  vi.stubEnv("X_BOOKMARKS_BACKUP_DIR", join(data, "open"));
  backUpIfDue(() => store, at(11));
  expect(backupStatus()).toMatchObject({
    snapshots: 1,
    lastAttempt: { outcome: "written" },
    unreadable: null,
  });
});

test("a library that cannot be opened is a failed backup, not a crash", () => {
  setUp();
  vi.spyOn(console, "error").mockImplementation(() => {});

  const attempt = backUpIfDue(() => {
    throw new Error(
      "The database is at migration 9, which this code does not know.",
    );
  }, at(10));

  expect(attempt).toEqual({
    at: at(10),
    outcome: "failed",
    reason: "The database is at migration 9, which this code does not know.",
  });
});

test("a setting that cannot be read is a failed backup too", () => {
  const { store } = setUp();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("X_BOOKMARKS_BACKUP_KEEP", "none");

  expect(backUpIfDue(() => store, at(10))).toMatchObject({
    outcome: "failed",
    reason: expect.stringMatching(/X_BOOKMARKS_BACKUP_KEEP/),
  });
});

test("an empty library is not snapshotted", () => {
  const data = dirname(tempDatabasePath());
  vi.stubEnv("X_BOOKMARKS_DATA_DIR", data);
  vi.stubEnv("X_BOOKMARKS_BACKUP_DIR", "");
  const store = openTempStore(join(data, "bookmarks.db"));

  expect(backUpIfDue(() => store, at(10))).toMatchObject({ outcome: "empty" });
  expect(readdirSync(data)).not.toContain("backups");
});

test("starting looks at once, then every hour, and starting twice is starting once", () => {
  const { snapshots } = setUp();
  vi.useFakeTimers({ now: at(10) });

  // With no store handed in, this is the app's own, opened on the data directory.
  startBackups();
  startBackups();

  expect(backupStatus().lastAttempt).toEqual({
    at: at(10),
    outcome: "written",
  });
  expect(readdirSync(snapshots)).toEqual(["snapshot-20261012T100000Z.db"]);
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(backupStatus().lastAttempt).toEqual({ at: at(11), outcome: "recent" });
  vi.advanceTimersByTime(30 * 60 * 1000);
  expect(backupStatus().lastAttempt).toMatchObject({ at: at(11) });
  expect(vi.getTimerCount()).toBe(1);
});
