/**
 * Tagging of new bookmarks without anyone running anything. The work is the
 * tagger's (`tagNewBookmarks` in `@curio/tagger/automatic`); this
 * module decides when the app asks for it, and remembers what came of it.
 *
 * It is off unless the owner has turned it on, because a pass spends their
 * money with no one watching. The switch is a line of the `.env` file at
 * the repo's root, which the owner writes by hand and the tagger reads at
 * each pass. This module holds no switch and offers none: no argument of
 * `scheduleTagging`, no route and no page can make a pass send. Asked for
 * a pass with tagging off, the tagger counts what is waiting, answers
 * `off` with how to turn it on, and the app has still loaded nothing that
 * can reach another host. The timers below run all the same, so the
 * owner's edit takes effect at the next pass with no restart.
 *
 * A pass is asked for three ways: shortly after the app starts, for what
 * arrived while it was not running or could not be tagged; a minute after
 * the last capture of a burst is stored; and once an hour, which is how a
 * pass that failed because the API was out of reach is tried again. A
 * screen on which the owner accepts or adds a tag asks for one too, with
 * `scheduleTagging`, so that the bookmarks that mention the tag are asked
 * about it within the minute.
 *
 * Nothing waits for a pass. The ingest route asks for one and answers the
 * extension at once; a pass runs later, on its own, and whatever happens in
 * it, a missing key, no network, an error, is recorded here and logged
 * without a word of any bookmark.
 *
 * The API key is not this module's business and never passes through it.
 * The tagger reads it from the `.env` file at the repo's root when a pass
 * runs. That file is not one Next loads: Next reads `.env` files from its
 * own project directory, `packages/web`, which holds none. So the key is
 * in no variable of this process's environment, before a pass or after.
 * The bookmarks themselves are stored and complete before a pass begins,
 * and stay so whether or not it succeeds.
 *
 * What a pass may do by itself, and what it leaves to the owner (the first
 * run, a backlog, a re-tagging), is decided in the tagger.
 */
import type { Store } from "@curio/core";
import type { AppTagging, AutomaticPass } from "@curio/tagger/automatic";
import { sharedStore } from "./data.ts";

const MINUTE_MS = 60 * 1000;
/** How long after the app starts the first pass runs: once the server is up and answering. */
const AFTER_START_MS = 15 * 1000;
/**
 * How long after a capture is stored a pass runs. A capture session
 * delivers page after page; each one moves the pass back, so the session's
 * bookmarks are sent together when it has gone quiet.
 */
export const AFTER_CAPTURE_MS = MINUTE_MS;
const CHECK_INTERVAL_MS = 60 * MINUTE_MS;

/** What the app's last pass came to. Counts, money and a message fit to show: never a bookmark. */
export interface TaggingAttempt {
  at: Date;
  status: AutomaticPass["status"];
  message: string;
  /**
   * Set when the variable Anthropic's own tools read a key from is in the
   * app's environment or in the key's file. Tagging does not use it; a
   * status screen should pass the warning on.
   */
  warning: string | null;
  /** How many bookmarks were waiting when the pass began: unclassified, or mentioning a tag added since they were classified. */
  waiting: number;
  /** How many the pass got an answer for, of either kind. */
  classified: number;
  failed: number;
  costUsd: number;
  /** Whether the pass broke, or the API ended its run: something a status screen should say. */
  problem: boolean;
}

/** The pass itself. Replaced in tests. */
export type Pass = (store: Store) => Promise<AutomaticPass>;

/**
 * The tagger's entry for the app, loaded by Node when it is first needed
 * and not bundled: it imports core, of which this process must hold one
 * copy (see `core.ts`). The entry is the pass and the owner's setting and
 * no more. The client that sends is loaded by the pass itself, and only by
 * one the owner has allowed that has something to send.
 */
const automatic = () =>
  import(/* turbopackIgnore: true */ "@curio/tagger/automatic");

const tagger: Pass = async (store) => {
  const { tagNewBookmarks } = await automatic();
  return tagNewBookmarks(store);
};

/**
 * Whether the owner has let the app tag by itself, as the tagger reads it
 * from the `.env` file now, with a message fit to show: how to turn it on
 * or off, and which commands do the same by hand. Read-only: nothing here
 * can change it.
 */
export async function appTagging(): Promise<AppTagging> {
  const { appTagging: read } = await automatic();
  return read();
}

interface Shared {
  lastAttempt?: TaggingAttempt;
  running?: Promise<TaggingAttempt>;
  /** Whether a pass was asked for while one was running. */
  again?: boolean;
  pending?: ReturnType<typeof setTimeout>;
  timer?: ReturnType<typeof setInterval>;
}

// On globalThis for the reason given in data.ts: the start hook, the ingest
// route and a page that reports the status are in different server layers.
const shared = globalThis as typeof globalThis & {
  __curioTagging?: Shared;
};

function state(): Shared {
  shared.__curioTagging ??= {};
  return shared.__curioTagging;
}

const sum = (
  reports: AutomaticPass["reports"],
  field: "classified" | "failed" | "costUsd",
) => reports.reduce((total, report) => total + report[field], 0);

async function attempt(
  pass: Pass,
  store: () => Store,
  now: () => Date,
): Promise<TaggingAttempt> {
  let made: TaggingAttempt;
  try {
    const result = await pass(store());
    made = {
      at: now(),
      status: result.status,
      message: result.message,
      warning: result.warning,
      waiting: result.waiting,
      classified: sum(result.reports, "classified"),
      failed: sum(result.reports, "failed"),
      costUsd: sum(result.reports, "costUsd"),
      problem:
        result.status === "error" ||
        result.reports.some(({ status }) => status === "failed"),
    };
  } catch (error) {
    // The error's name alone: its message could quote what it was working on.
    made = {
      at: now(),
      status: "error",
      message: `The tagging pass could not run (${error instanceof Error ? error.name : "an unknown error"}).`,
      warning: null,
      waiting: 0,
      classified: 0,
      failed: 0,
      costUsd: 0,
      problem: true,
    };
  }
  if (made.problem) console.error(`Tagging of new bookmarks: ${made.message}`);
  if (made.warning !== null) {
    console.error(`Tagging of new bookmarks: ${made.warning}`);
  }
  return made;
}

/**
 * Runs a pass now, unless one is running, in which case that one is
 * awaited and another follows it. Never throws.
 */
export function tagNow(
  pass: Pass = tagger,
  store: () => Store = sharedStore,
  now: () => Date = () => new Date(),
): Promise<TaggingAttempt> {
  const current = state();
  if (current.running !== undefined) {
    current.again = true;
    return current.running;
  }
  const running = attempt(pass, store, now).then((made) => {
    current.lastAttempt = made;
    delete current.running;
    if (current.again === true) {
      delete current.again;
      void tagNow(pass, store, now);
    }
    return made;
  });
  current.running = running;
  return running;
}

/**
 * Asks for a pass `delayMs` from now, in place of any pass already asked
 * for. Returns at once; what the pass does is none of the caller's concern.
 */
export function scheduleTagging(
  delayMs: number = AFTER_CAPTURE_MS,
  pass: Pass = tagger,
): void {
  const current = state();
  clearTimeout(current.pending);
  current.pending = setTimeout(() => {
    delete current.pending;
    void tagNow(pass);
  }, delayMs);
  // A pass that is waiting must not keep the process alive.
  current.pending.unref();
}

/**
 * A first pass shortly, and then one every hour for as long as the app
 * runs. Called once as the server starts; a second call changes nothing.
 */
export function startTagging(pass: Pass = tagger): void {
  const current = state();
  if (current.timer !== undefined) return;
  scheduleTagging(AFTER_START_MS, pass);
  current.timer = setInterval(() => void tagNow(pass), CHECK_INTERVAL_MS);
  current.timer.unref();
}

/** What a status screen shows of the app's own tagging. */
export interface TaggingStatus {
  /** Null until this process has made a pass. */
  lastAttempt: TaggingAttempt | null;
  /** Whether a pass is running now, or has been asked for and is waiting its turn. */
  running: boolean;
  scheduled: boolean;
}

export function taggingStatus(): TaggingStatus {
  const current = state();
  return {
    lastAttempt: current.lastAttempt ?? null,
    running: current.running !== undefined,
    scheduled: current.pending !== undefined,
  };
}
