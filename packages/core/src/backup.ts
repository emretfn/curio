/**
 * Snapshots of the whole database, kept outside it.
 *
 * The raw captures are the part of the library that cannot be made again:
 * each is a response X sent once, collected by hand. A snapshot is one file
 * holding everything, taken from a running database without stopping it, and
 * checked against the database before it is given its name.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { connectionOf, type Store } from "./store.ts";

/** One snapshot file. */
export interface Snapshot {
  /** The file's name, which holds the time it was taken. */
  name: string;
  path: string;
  takenAt: Date;
  bytes: number;
}

export interface BackupOptions {
  /**
   * Where snapshots are kept. Created when missing, readable by its owner
   * alone. Keep it outside the repo and off the database's own directory.
   */
  directory: string;
  /** How many snapshots to keep. Older ones are deleted. Defaults to `DEFAULT_SNAPSHOTS_KEPT`. */
  keep?: number | undefined;
  /**
   * Take nothing when the latest snapshot is younger than this many
   * milliseconds. Leave it out to take one regardless.
   */
  minIntervalMs?: number | undefined;
  /** The time the snapshot is named for. Defaults to now. */
  now?: Date | undefined;
}

/**
 * What a backup did.
 *
 * - `written`: a new snapshot was taken, verified and kept.
 * - `unchanged`: the latest snapshot already holds exactly what the database
 *   holds, so no second copy of it was kept. This is what stops a library
 *   that is not changing from filling its `keep` snapshots with one state.
 * - `recent`: the latest snapshot is younger than `minIntervalMs`.
 * - `empty`: the database holds no captures yet, so there is nothing to keep.
 */
export type BackupResult =
  | {
      status: "written";
      snapshot: Snapshot;
      /** Raw captures in the snapshot, each checked against the database. */
      rawCaptures: number;
      bookmarks: number;
      /** Older snapshots deleted to stay within `keep`. */
      pruned: string[];
    }
  | { status: "unchanged" | "recent"; snapshot: Snapshot }
  | { status: "empty" };

export const DEFAULT_SNAPSHOTS_KEPT = 10;

/**
 * Names this module gives its files. Listing and pruning read these names
 * and no others, so a file anyone else puts in the directory is never
 * counted and never deleted.
 */
const SNAPSHOT_NAME =
  /^snapshot-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/;
const PARTIAL_SUFFIX = ".partial";

function nameAt(time: Date): string {
  const stamp = time
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `snapshot-${stamp}.db`;
}

/** The time in a snapshot's name, or undefined for any other file name. */
function timeOfName(name: string): Date | undefined {
  const stamp = SNAPSHOT_NAME.exec(name);
  if (stamp === null) return undefined;
  const [, year, month, day, hour, minute, second] = stamp;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

/** The snapshots in a directory, newest first. A directory that does not exist holds none. */
export function listSnapshots(directory: string): Snapshot[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .flatMap((name) => {
      const takenAt = timeOfName(name);
      if (takenAt === undefined) return [];
      const path = join(directory, name);
      const stats = statSync(path);
      return stats.isFile() ? [{ name, path, takenAt, bytes: stats.size }] : [];
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(1 << 20);
  const file = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(file, chunk);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(file);
  }
  return hash.digest("hex");
}

interface Contents {
  rawCaptures: number;
  lastRawCaptureId: number;
  bookmarks: number;
  migrations: string;
}

function contentsOf(db: Database.Database): Contents {
  const counts = db
    .prepare<
      [],
      { rawCaptures: number; lastRawCaptureId: number; bookmarks: number }
    >(
      `SELECT (SELECT count(*) FROM raw_captures) AS rawCaptures,
              (SELECT coalesce(max(id), 0) FROM raw_captures) AS lastRawCaptureId,
              (SELECT count(*) FROM bookmarks) AS bookmarks`,
    )
    .get();
  if (counts === undefined) {
    throw new Error("An aggregate query returned no row.");
  }
  return {
    ...counts,
    migrations: JSON.stringify(
      db
        .prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        )
        .all(),
    ),
  };
}

/**
 * A digest of every raw capture up to `lastId`, every column of each, in id
 * order. Two databases with the same digest hold the same captures.
 */
function rawCaptureDigest(db: Database.Database, lastId: number): string {
  const hash = createHash("sha256");
  const rows = db
    .prepare<[number], Record<string, string | number | null>>(
      `SELECT id, source, operation, request_url, request_body, payload,
              received_at, capture_key
       FROM raw_captures WHERE id <= ? ORDER BY id`,
    )
    .iterate(lastId);
  for (const row of rows) {
    for (const value of Object.values(row)) {
      // The length goes in before the value, so that no two rows can run
      // together into the bytes of a third.
      const text = value === null ? "" : String(value);
      hash.update(
        `${value === null ? "n" : typeof value === "number" ? "i" : "s"}${Buffer.byteLength(text)}:`,
      );
      hash.update(text);
    }
  }
  return hash.digest("hex");
}

/**
 * Package-internal: checks a finished snapshot file against the database it
 * was taken from, and throws when it does not hold up. `before` is what the
 * database held just before the snapshot was taken; it may have grown since,
 * and raw captures never change once stored, so the snapshot must hold at
 * least that, and exactly what the database holds up to the snapshot's last
 * capture.
 */
export function verifySnapshot(
  path: string,
  store: Store,
  before: Contents = contentsOf(connectionOf(store)),
): Contents {
  const source = connectionOf(store);
  const snapshot = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = snapshot.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error("the snapshot fails SQLite's integrity check");
    }
    const held = contentsOf(snapshot);
    const now = contentsOf(source);
    if (held.migrations !== before.migrations) {
      throw new Error("the snapshot's schema is not the database's");
    }
    if (
      held.rawCaptures < before.rawCaptures ||
      held.rawCaptures > now.rawCaptures
    ) {
      throw new Error(
        `the snapshot holds ${held.rawCaptures} raw captures, and the database held ${before.rawCaptures} before it and ${now.rawCaptures} after`,
      );
    }
    if (held.bookmarks < before.bookmarks || held.bookmarks > now.bookmarks) {
      throw new Error(
        `the snapshot holds ${held.bookmarks} bookmarks, and the database held ${before.bookmarks} before it and ${now.bookmarks} after`,
      );
    }
    if (
      rawCaptureDigest(snapshot, held.lastRawCaptureId) !==
      rawCaptureDigest(source, held.lastRawCaptureId)
    ) {
      throw new Error(
        "a raw capture in the snapshot differs from the one in the database",
      );
    }
    return held;
  } finally {
    snapshot.close();
  }
}

/**
 * Takes a snapshot of the whole database into `options.directory` and
 * returns what was done. Safe while the database is in use, by this process
 * or another: the snapshot is one consistent state, written by SQLite inside
 * a single read.
 *
 * The file is written under a temporary name, then opened and verified:
 * SQLite's integrity check, the same schema, and every raw capture equal to
 * the database's, column for column. Only then is it given a snapshot's
 * name, so a file with that name has passed. Anything that fails throws,
 * and leaves no partial file behind.
 *
 * Afterwards the oldest snapshots beyond `keep` are deleted. Only files this
 * function named are ever deleted.
 */
export function backupStore(
  store: Store,
  options: BackupOptions,
): BackupResult {
  const keep = options.keep ?? DEFAULT_SNAPSHOTS_KEPT;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new RangeError(
      `keep must be a whole number of at least 1; got ${keep}.`,
    );
  }
  const now = options.now ?? new Date();
  const db = connectionOf(store);
  const { directory } = options;

  const before = contentsOf(db);
  if (before.rawCaptures === 0) return { status: "empty" };

  const [latest] = listSnapshots(directory);
  if (
    latest !== undefined &&
    options.minIntervalMs !== undefined &&
    now.getTime() - latest.takenAt.getTime() < options.minIntervalMs
  ) {
    return { status: "recent", snapshot: latest };
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // What an earlier run left behind when it was cut short.
  for (const name of readdirSync(directory)) {
    if (
      name.endsWith(PARTIAL_SUFFIX) &&
      SNAPSHOT_NAME.test(name.slice(0, -PARTIAL_SUFFIX.length))
    ) {
      rmSync(join(directory, name));
    }
  }

  const name = nameAt(now);
  const path = join(directory, name);
  const partial = `${path}${PARTIAL_SUFFIX}`;
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    chmodSync(partial, 0o600);
    const held = verifySnapshot(partial, store, before);

    if (
      latest !== undefined &&
      latest.bytes === statSync(partial).size &&
      sha256OfFile(latest.path) === sha256OfFile(partial)
    ) {
      rmSync(partial);
      return { status: "unchanged", snapshot: latest };
    }
    if (listSnapshots(directory).some((existing) => existing.name === name)) {
      throw new Error(
        `a snapshot named ${name} already exists, and snapshots are never overwritten`,
      );
    }
    renameSync(partial, path);

    const pruned = listSnapshots(directory)
      .slice(keep)
      .map((old) => {
        rmSync(old.path);
        return old.name;
      });
    return {
      status: "written",
      snapshot: {
        name,
        path,
        takenAt: timeOfName(name) ?? now,
        bytes: statSync(path).size,
      },
      rawCaptures: held.rawCaptures,
      bookmarks: held.bookmarks,
      pruned,
    };
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}
