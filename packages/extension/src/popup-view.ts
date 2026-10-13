/**
 * What the popup shows for a status: which state it is in, in what words,
 * and the one thing to do next. A pure function of what the service worker
 * reported, so every state is tested here without a browser; `popup.ts`
 * only draws the result.
 */
import type { Status, Trouble } from "./channel.ts";
import { APP_HOST, APP_PORT } from "./protocol.ts";

/** What the popup is in the middle of, between a press and the worker's answer. */
export type Activity = "pairing" | "checking" | "sending";

export type PopupState =
  /** The worker has not answered yet: a few milliseconds, drawn as nothing. */
  | "loading"
  /** The worker gave no status. */
  | "unavailable"
  | "not-paired"
  /** A token was just submitted and the app is being asked to prove itself. */
  | "pairing"
  /** A token is saved and the app has not answered. */
  | "unconfirmed"
  /** Something answered at the app's address without proving it holds the token. */
  | "refused"
  /** Paired, and nothing captured yet. */
  | "ready"
  /** Paired, and everything captured is in the app. */
  | "up-to-date"
  /** A capture was taken in the last few seconds. */
  | "capturing"
  /** Captures are on their way to the app. */
  | "sending"
  /** Captures wait in the extension because the app is not running. */
  | "waiting"
  /** The app answered, and captures still wait. */
  | "stalled"
  /** The app refused captures. */
  | "rejected"
  /** A bookmark response on X's page could not be taken. */
  | "not-captured";

export type Tone = "neutral" | "active" | "problem";
export type Icon =
  | "unplug"
  | "check"
  | "dashed"
  | "spinner"
  | "live"
  | "warning"
  | "error";

/** Prose with something to type in it: a string is text, `{ code }` a command. */
export type Prose = readonly (string | { readonly code: string })[];

export interface View {
  state: PopupState;
  tone: Tone;
  icon: Icon;
  title: string;
  detail: Prose;
  /** What to do, in order, where the next step is more than one. */
  steps: readonly Prose[];
  /** The state's one main action, and what its button says. */
  action: { does: "check" | "send"; label: string; busy: string } | null;
  /**
   * The token field: `open` where pairing is the thing to do, `folded` under
   * a disclosure where a token is already saved, `hidden` where there is no
   * status to pair against.
   */
  tokenField: "open" | "folded" | "hidden";
  /** Whether the counts say anything yet. */
  counts: boolean;
  /**
   * The worker's own record of what went wrong, where it says more than the
   * title and detail do: an HTTP status, the operation that was not captured.
   */
  problem: { at: number; message: string } | null;
}

/** How long after a capture the popup still says it is capturing. */
export const CAPTURING_FOR_MS = 8000;

const APP_ADDRESS = `${APP_HOST}:${APP_PORT}`;
const START_THE_APP = { code: "pnpm app" } as const;
const PRINT_THE_TOKEN = { code: "pnpm pair" } as const;

/**
 * The troubles a state says in its own words, with what to do about them.
 * The worker's sentence for these adds nothing, so it is not shown as well.
 */
const SAID_BY_THE_STATE: readonly (Trouble | null)[] = [
  "not-paired",
  "app-unreachable",
  "app-unproven",
];

export function captures(count: number): string {
  return count === 1 ? "1 capture" : `${count} captures`;
}

const are = (count: number) => (count === 1 ? "is" : "are");

/** What the popup shows. `status` is undefined when the worker gave none. */
export function viewOf(
  status: Status | undefined | "loading",
  activity: Activity | null,
  now: number,
): View {
  const blank = {
    tone: "neutral",
    steps: [],
    action: null,
    tokenField: "hidden",
    counts: false,
    problem: null,
  } as const satisfies Partial<View>;

  if (status === "loading") {
    return {
      ...blank,
      state: "loading",
      icon: "dashed",
      title: "Reading the status…",
      detail: [],
    };
  }
  if (status === undefined) {
    return {
      ...blank,
      state: "unavailable",
      tone: "problem",
      icon: "error",
      title: "The extension is not answering",
      detail: [
        "Its background worker gave no status. Close this popup and open it again. If it stays like this, reload the extension on ",
        { code: "chrome://extensions" },
        ".",
      ],
    };
  }

  const { pending, rejected, captured, lastError } = status;
  // From here on the counts are drawn once there is something to count.
  const base = {
    ...blank,
    tokenField: "folded",
    counts: captured > 0,
  } as const;
  const trouble = lastError?.trouble ?? null;
  const problem =
    lastError === null || SAID_BY_THE_STATE.includes(trouble)
      ? null
      : { at: lastError.at, message: lastError.message };
  const kept =
    pending === 0
      ? []
      : [
          ` ${captures(pending)} ${are(pending)} kept here and sent once the app has answered.`,
        ];

  if (activity === "pairing" && status.pairing !== "paired") {
    return {
      ...base,
      state: "pairing",
      tone: "active",
      icon: "spinner",
      title: "Pairing…",
      detail: [
        `Asking the app at ${APP_ADDRESS} to prove it holds this token.`,
      ],
      tokenField: "open",
      problem,
    };
  }

  if (status.pairing === "none") {
    return {
      ...base,
      state: "not-paired",
      icon: "unplug",
      title: "Not paired yet",
      detail:
        pending === 0
          ? ["Pair with the Curio app on this computer to start capturing."]
          : [
              `${captures(pending)} ${are(pending)} kept here, and sent to the Curio app on this computer once you pair with it.`,
            ],
      steps: [
        ["Start the app: ", START_THE_APP],
        ["In a second terminal, run ", PRINT_THE_TOKEN],
        ["Paste the token it prints below"],
      ],
      tokenField: "open",
      problem,
    };
  }

  if (status.pairing !== "paired") {
    // The freshest fact wins: a token the app once turned down, checked
    // again while nothing is listening, is an app that is not answering.
    const turnedDown =
      trouble === "app-unproven" ||
      (status.pairing === "refused" && trouble !== "app-unreachable");
    if (turnedDown) {
      return {
        ...base,
        state: "refused",
        tone: "problem",
        icon: "error",
        title: "The app did not accept this token",
        detail: [
          `Whatever answered at ${APP_ADDRESS} could not prove it holds this token, so nothing was sent to it. Run `,
          PRINT_THE_TOKEN,
          " and paste the token it prints. If the token is right, another program is using the app's port.",
          ...kept,
        ],
        action: { does: "check", label: "Check again", busy: "Checking…" },
        tokenField: "open",
        problem,
      };
    }
    return {
      ...base,
      state: "unconfirmed",
      icon: "warning",
      title: "Waiting for the app",
      detail: [
        `The token is saved, but nothing answered at ${APP_ADDRESS}. Start the app with `,
        START_THE_APP,
        ", then check again.",
        ...kept,
      ],
      action: { does: "check", label: "Check again", busy: "Checking…" },
      problem,
    };
  }

  // Asked for by the button: said at once, whatever was wrong a moment ago.
  // The button stays, busy, so that the keyboard is not left on nothing.
  if (activity === "sending") {
    return {
      ...base,
      state: "sending",
      tone: "active",
      icon: "spinner",
      title: "Sending…",
      detail: ["Handing what is kept here to the app."],
      action: { does: "send", label: "Send now", busy: "Sending…" },
      problem,
    };
  }

  if (rejected > 0) {
    return {
      ...base,
      state: "rejected",
      tone: "problem",
      icon: "error",
      title: `The app refused ${captures(rejected)}`,
      detail: [
        `${rejected === 1 ? "It is" : "They are"} kept here, and nothing is lost. The app may be older than this extension: update it, start it again, then send ${rejected === 1 ? "it" : "them"} again.`,
      ],
      action: { does: "send", label: "Send again", busy: "Sending…" },
      problem,
    };
  }

  const recentlyCaptured =
    status.lastCapturedAt !== null &&
    now - status.lastCapturedAt < CAPTURING_FOR_MS;

  if (pending > 0 && lastError !== null && trouble !== "not-captured") {
    if (trouble === "app-unreachable") {
      return {
        ...base,
        state: "waiting",
        icon: "warning",
        title: `${captures(pending)} waiting for the app`,
        detail: [
          "The app is not running, and nothing is lost. Start it with ",
          START_THE_APP,
          `: ${pending === 1 ? "it is" : "they are"} sent within a minute, or at once with the button.`,
        ],
        action: { does: "send", label: "Send now", busy: "Sending…" },
      };
    }
    return {
      ...base,
      state: "stalled",
      tone: "problem",
      icon: "error",
      title: `${captures(pending)} not delivered`,
      detail: [
        `The app answered without confirming that it stored ${pending === 1 ? "it" : "them"}. Nothing is lost: ${pending === 1 ? "it is" : "they are"} kept here and tried again every minute.`,
      ],
      action: { does: "send", label: "Try again", busy: "Sending…" },
      problem,
    };
  }

  if (
    trouble === "not-captured" &&
    lastError !== null &&
    (status.lastCapturedAt === null || status.lastCapturedAt < lastError.at)
  ) {
    return {
      ...base,
      state: "not-captured",
      icon: "warning",
      title: "A response was not captured",
      detail: [
        "X's page received a bookmark response that could not be kept. If X answered with an error, wait a while, then scroll your bookmarks again.",
      ],
      problem,
    };
  }

  if (pending > 0 && !recentlyCaptured) {
    return {
      ...base,
      state: "sending",
      tone: "active",
      icon: "spinner",
      title: `Sending ${captures(pending)}…`,
      detail: ["Handing what is kept here to the app."],
      problem,
    };
  }

  if (recentlyCaptured) {
    return {
      ...base,
      state: "capturing",
      tone: "active",
      icon: "live",
      title: "Capturing",
      // Said once, not once a capture: this part is read out when it changes.
      detail: [
        "Keep scrolling at reading pace: each step X loads is one capture.",
      ],
      problem,
    };
  }

  if (captured === 0) {
    return {
      ...base,
      state: "ready",
      icon: "dashed",
      title: "Paired. Nothing captured yet",
      detail: [
        "Open your bookmarks on X and scroll through them: each step X loads is captured. Reload any X tab that was open before the extension was.",
      ],
      problem,
    };
  }

  return {
    ...base,
    state: "up-to-date",
    icon: "check",
    title: "Up to date",
    detail: [
      status.delivered === 1
        ? "The 1 capture taken is in the app."
        : `All ${status.delivered} captures are in the app.`,
    ],
    problem,
  };
}

const RELATIVE_STEPS: readonly [limit: number, unit: number, name: string][] = [
  [60 * 60_000, 60_000, "min"],
  [24 * 60 * 60_000, 60 * 60_000, "h"],
];

/** A time as the popup's small print says it: how long ago, then the date. */
export function ago(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60_000) return "just now";
  for (const [limit, unit, name] of RELATIVE_STEPS) {
    if (elapsed < limit) return `${Math.floor(elapsed / unit)} ${name} ago`;
  }
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
