/**
 * The pass the app makes by itself, so that a newly captured bookmark is
 * filed, and a newly accepted tag reaches the bookmarks that mention it,
 * without anyone running anything. The app calls `tagNewBookmarks` as it
 * starts, a little after captures arrive, and once an hour; each call is
 * one pass.
 *
 * A pass is small and careful with money on purpose. It does two things and
 * no third. It classifies bookmarks that have no answer yet. And it asks
 * again about bookmarks classified before a tag joined the vocabulary whose
 * text mentions that tag, taking from the answer only the tag they were
 * never offered: nothing else about a bookmark can change, so this is not a
 * re-tagging. It sends one request at a time and spends a few cents at most
 * in a pass and in a day. And it leaves a backlog alone: with more than
 * `BACKLOG_LIMIT` bookmarks waiting for either, as on the day the key is
 * first put in place, it does nothing about them and says so, because the
 * first run and every backfill is the owner's to start (`pnpm tag`).
 *
 * It never throws and never holds anything up. Without a key, with the API
 * out of reach, or with nothing to do, it returns what happened and the
 * bookmarks stay as they were, complete, for the next pass.
 */
import {
  getOpenTaggingRun,
  listClassificationCandidates,
  listTaggingRuns,
  type Store,
} from "@x-bookmarks/core";
import { type Claude, createClaude } from "./anthropic.ts";
import {
  ApiKeyUnavailable,
  envFilePath,
  readApiKey,
  standardKeyWarning,
} from "./api-key.ts";
import { INSTRUCTIONS_VERSION } from "./instructions.ts";
import { runTagging, type TaggingReport } from "./run.ts";

/** More unclassified bookmarks than this is a backlog, which a pass leaves to the owner. */
export const BACKLOG_LIMIT = 150;
/** The most one pass may spend, and the most the app's passes may spend in a day, in US dollars. */
export const PASS_CAP_USD = 0.1;
export const DAILY_CAP_USD = 0.3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a pass came to. `message` is fit to show: it holds no post and no key. */
export interface AutomaticPass {
  /**
   * `ran`: the classifier ran; `reports` say what it did. `nothing-to-do`:
   * no bookmark is waiting. `no-key`: there is no usable API key, so
   * tagging is off. `backlog`: too many are waiting for a pass, and the
   * owner starts the run. `daily-cap`: the app's passes have spent their
   * day's allowance. `error`: the pass itself broke.
   */
  status:
    | "ran"
    | "nothing-to-do"
    | "no-key"
    | "backlog"
    | "daily-cap"
    | "error";
  message: string;
  /** How many bookmarks were waiting when the pass began: unclassified, or mentioning a tag added since they were classified. */
  waiting: number;
  /** One report for each run the pass made: the unclassified bookmarks, then the new tags. Empty when it made none. */
  reports: TaggingReport[];
  /**
   * Set when the variable Anthropic's own tools read a key from was found,
   * in the app's environment or in the key's file. It is not used; the
   * owner should hear of it all the same.
   */
  warning: string | null;
}

/** What the app's own runs have spent since a day ago. */
function spentByAppToday(store: Store, now: Date): number {
  return listTaggingRuns(store, { limit: 100 })
    .filter(
      (run) =>
        run.startedBy === "app" &&
        run.startedAt.getTime() > now.getTime() - DAY_MS,
    )
    .reduce((sum, run) => sum + run.costUsd, 0);
}

export async function tagNewBookmarks(
  store: Store,
  options: {
    /** The `.env` file that holds the API key. The repo's own unless a test says otherwise. */
    envFile?: string;
    /** Makes the client for a key. Replaced in tests by one that reaches a fake of the API. */
    connect?: (apiKey: string) => Claude;
    now?: () => Date;
  } = {},
): Promise<AutomaticPass> {
  const now = options.now ?? (() => new Date());
  const envFile = options.envFile ?? envFilePath();
  let waiting = 0;
  let warning: string | null = null;
  const reports: TaggingReport[] = [];
  const pass = (
    status: AutomaticPass["status"],
    message: string,
  ): AutomaticPass => ({ status, message, waiting, reports, warning });
  const count = (which: "unclassified" | "new-tags") =>
    listClassificationCandidates(store, {
      which,
      instructionsVersion: INSTRUCTIONS_VERSION,
      limit: 1,
    }).total;
  try {
    const unclassified = count("unclassified");
    const mentioning = count("new-tags");
    waiting = unclassified + mentioning;
    // A batch the owner's run left waiting is collected by a pass too: its
    // results are paid for, and reading them costs nothing.
    const batchWaiting = getOpenTaggingRun(store)?.batchId != null;
    if (waiting === 0 && !batchWaiting) {
      return pass("nothing-to-do", "Every bookmark has been classified.");
    }
    if (unclassified > BACKLOG_LIMIT && !batchWaiting) {
      return pass(
        "backlog",
        `${unclassified} bookmarks are waiting to be classified. That is more than the app classifies by itself: run pnpm tag.`,
      );
    }
    if (unclassified === 0 && mentioning > BACKLOG_LIMIT && !batchWaiting) {
      return pass(
        "backlog",
        `${mentioning} bookmarks mention a tag added since they were classified. That is more than the app asks about by itself: run pnpm tag --new-tags.`,
      );
    }
    const spent = spentByAppToday(store, now());
    if (spent >= DAILY_CAP_USD) {
      return pass(
        "daily-cap",
        `The app's own tagging has spent its allowance for a day ($${DAILY_CAP_USD.toFixed(2)}). It goes on tomorrow; pnpm tag classifies what is waiting now.`,
      );
    }
    // Only now is the key's file opened: a pass with nothing to do has no
    // business with it.
    warning = standardKeyWarning(envFile);
    let apiKey: string;
    try {
      apiKey = readApiKey(envFile);
    } catch (error) {
      if (!(error instanceof ApiKeyUnavailable)) throw error;
      return pass("no-key", error.message);
    }
    const claude = (
      options.connect ?? ((key) => createClaude({ apiKey: key }))
    )(apiKey);
    const run = async (mode: "untagged" | "new-tags") => {
      const used = reports.reduce((sum, { costUsd }) => sum + costUsd, 0);
      const report = await runTagging(store, {
        claude,
        startedBy: "app",
        mode,
        transport: "direct",
        limit: BACKLOG_LIMIT,
        capUsd: Math.min(PASS_CAP_USD, DAILY_CAP_USD - spent) - used,
        // A batch still being processed is looked at once and left to the next pass.
        batchWaitMs: 0,
        now,
      });
      reports.push(report);
      return report;
    };
    const first = await run("untagged");
    // The new tags follow only a first step that went well, and only when
    // they are few enough to be the app's to ask about.
    if (
      (first.status === "completed" || first.status === "nothing-to-do") &&
      mentioning > 0 &&
      mentioning <= BACKLOG_LIMIT
    ) {
      await run("new-tags");
    }
    const last = reports.at(-1) ?? first;
    const asked = reports.length > 1 ? last.classified : 0;
    return pass(
      "ran",
      last.failure?.message ??
        first.failure?.message ??
        (first.status === "busy"
          ? "Another tagging run is at work, and this pass left the bookmarks to it."
          : first.status === "waiting-for-batch"
            ? "A batch is still being processed. A later pass collects its results."
            : `Classified ${first.classified} of ${first.selected} new bookmarks${reports.length > 1 ? `, and asked ${asked} of ${last.selected} about tags added since they were classified` : ""}.`),
    );
  } catch (error) {
    // The name of the error and no more: a message could quote what it was working on.
    return pass(
      "error",
      `The tagging pass broke (${error instanceof Error ? error.name : "an unknown error"}). The bookmarks are untouched.`,
    );
  }
}
