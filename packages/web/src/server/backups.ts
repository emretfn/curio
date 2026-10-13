import { dirname, join, resolve } from "node:path";
import type { BackupResult, Snapshot, Store } from "@curio/core";
import { backupStore, listSnapshots } from "./core.ts";
import { sharedStore } from "./data.ts";
import { dataDirectory } from "./data-directory.ts";

const HOUR_MS = 60 * 60 * 1000;
/** A snapshot is taken at most this often by the app itself. `pnpm backup` takes one whenever it is run. */
export const BACKUP_INTERVAL_MS = 24 * HOUR_MS;
/**
 * How often a running app looks whether a snapshot is due. It is due once
 * the latest is a day old, and is then taken as soon as the library has
 * changed, so new captures wait an hour at most.
 */
const CHECK_INTERVAL_MS = HOUR_MS;

/**
 * Where snapshots are kept: `CURIO_BACKUP_DIR` when set. Otherwise a
 * directory beside the repo, named after it with `-backups` added, so that
 * no snapshot is ever inside the working tree; or, when the data directory
 * itself was moved with `CURIO_DATA_DIR`, `backups` inside that.
 */
export function backupDirectory(): string {
  const configured = process.env.CURIO_BACKUP_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const data = dataDirectory();
  const moved = process.env.CURIO_DATA_DIR;
  return moved !== undefined && moved !== ""
    ? join(data, "backups")
    : `${dirname(data)}-backups`;
}

/** How many snapshots are kept: `CURIO_BACKUP_KEEP`, or core's default when unset. */
export function snapshotsKept(): number | undefined {
  const configured = process.env.CURIO_BACKUP_KEEP;
  if (configured === undefined || configured === "") return undefined;
  const keep = Number(configured);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(
      `CURIO_BACKUP_KEEP must be a whole number of at least 1; it is "${configured}".`,
    );
  }
  return keep;
}

/** What the app's last look at its backups came to. */
export type BackupAttempt = { at: Date } & (
  | { outcome: BackupResult["status"] }
  | {
      outcome: "failed";
      /** Why, as the error said it: a path or a reason, never a bookmark. */
      reason: string;
    }
);

export interface BackupStatus {
  directory: string;
  /** Snapshots in the directory now, whoever took them: the app or `pnpm backup`. */
  snapshots: number;
  latest: Snapshot | null;
  /** Null until this process has looked once, which it does as it starts. */
  lastAttempt: BackupAttempt | null;
  /** Set when the snapshots could not even be listed. */
  unreadable: string | null;
}

/**
 * Why the library is not being backed up, as the error said it, or null
 * while it is: the last attempt failed, or the snapshots cannot be listed.
 */
export function backupFailure({
  lastAttempt,
  unreadable,
}: BackupStatus): string | null {
  return lastAttempt?.outcome === "failed" ? lastAttempt.reason : unreadable;
}

interface Shared {
  lastAttempt?: BackupAttempt;
  timer?: ReturnType<typeof setInterval>;
}

// On globalThis for the reason given in data.ts: Next evaluates this module
// once per server layer, and the hook that starts the backups and the page
// that reports them are in different layers.
const shared = globalThis as typeof globalThis & {
  __curioBackups?: Shared;
};

function state(): Shared {
  shared.__curioBackups ??= {};
  return shared.__curioBackups;
}

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : "something other than an Error";

/**
 * Takes a snapshot if one is due, and records what happened for the status
 * page. Never throws: a backup that fails must not take the app down with
 * it, and must not pass unseen either, so the failure is kept and logged.
 */
export function backUpIfDue(
  store: () => Store = sharedStore,
  now: Date = new Date(),
): BackupAttempt {
  let attempt: BackupAttempt;
  try {
    const { status } = backupStore(store(), {
      directory: backupDirectory(),
      keep: snapshotsKept(),
      minIntervalMs: BACKUP_INTERVAL_MS,
      now,
    });
    attempt = { at: now, outcome: status };
  } catch (error) {
    attempt = { at: now, outcome: "failed", reason: reasonOf(error) };
    console.error(
      `The backup of the library failed, and the status page says so until one succeeds. The reason: ${attempt.reason}`,
    );
  }
  state().lastAttempt = attempt;
  return attempt;
}

/**
 * Looks now, and then every hour for as long as the app runs. Called once
 * as the server starts; a second call changes nothing.
 */
export function startBackups(): void {
  const current = state();
  if (current.timer !== undefined) return;
  backUpIfDue();
  current.timer = setInterval(() => void backUpIfDue(), CHECK_INTERVAL_MS);
  // The timer alone must not keep the process alive.
  current.timer.unref();
}

/** What the status page shows. */
export function backupStatus(): BackupStatus {
  const lastAttempt = state().lastAttempt ?? null;
  let directory = "";
  try {
    directory = backupDirectory();
    const snapshots = listSnapshots(directory);
    return {
      directory,
      snapshots: snapshots.length,
      latest: snapshots[0] ?? null,
      lastAttempt,
      unreadable: null,
    };
  } catch (error) {
    return {
      directory,
      snapshots: 0,
      latest: null,
      lastAttempt,
      unreadable: reasonOf(error),
    };
  }
}
