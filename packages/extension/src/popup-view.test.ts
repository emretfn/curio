import { expect, test } from "vitest";
import type { Status, Trouble } from "./channel.ts";
import {
  type Activity,
  ago,
  CAPTURING_FOR_MS,
  type Prose,
  viewOf,
} from "./popup-view.ts";

const NOW = 1760257900000;
const MINUTE = 60_000;

const idle: Status = {
  pairing: "paired",
  captured: 0,
  delivered: 0,
  pending: 0,
  rejected: 0,
  lastCapturedAt: null,
  lastDeliveredAt: null,
  lastError: null,
};

const error = (trouble: Trouble | null, message = "what the worker said") => ({
  at: NOW - MINUTE,
  message,
  trouble,
});

const view = (change: Partial<Status>, activity: Activity | null = null) =>
  viewOf({ ...idle, ...change }, activity, NOW);

const said = (prose: Prose) =>
  prose.map((part) => (typeof part === "string" ? part : part.code)).join("");

test("before the worker has answered nothing is claimed, and nothing can be pressed", () => {
  expect(viewOf("loading", null, NOW)).toMatchObject({
    state: "loading",
    title: "Reading the status…",
    action: null,
    tokenField: "hidden",
    counts: false,
  });
});

test("a worker that gives no status is a state of its own, with what to do", () => {
  const shown = viewOf(undefined, null, NOW);

  expect(shown).toMatchObject({
    state: "unavailable",
    tone: "problem",
    tokenField: "hidden",
    counts: false,
  });
  expect(said(shown.detail)).toMatch(/reload the extension/);
});

test("not paired: the steps to a token, with the field in the open and nothing to count", () => {
  const shown = view({ pairing: "none" });

  expect(shown).toMatchObject({
    state: "not-paired",
    title: "Not paired yet",
    action: null,
    tokenField: "open",
    counts: false,
    problem: null,
  });
  expect(shown.steps.map(said)).toEqual([
    "Start the app: pnpm app",
    "In a second terminal, run pnpm pair",
    "Paste the token it prints below",
  ]);
});

test("not paired with captures taken: says they are kept, and counts them", () => {
  const shown = view({
    pairing: "none",
    captured: 3,
    pending: 3,
    lastError: error("not-paired"),
  });

  expect(shown).toMatchObject({ state: "not-paired", counts: true });
  expect(said(shown.detail)).toMatch(/^3 captures are kept here/);
  // The worker's "Not paired" is what the state already says.
  expect(shown.problem).toBeNull();
});

test("pairing: says so until the app has answered, with the field still there", () => {
  expect(view({ pairing: "none" }, "pairing")).toMatchObject({
    state: "pairing",
    tone: "active",
    icon: "spinner",
    tokenField: "open",
  });
  expect(view({ pairing: "unconfirmed" }, "pairing").state).toBe("pairing");
  // Paired already, while what was waiting is still being delivered.
  expect(
    view({ pairing: "paired", captured: 4, pending: 3 }, "pairing"),
  ).toMatchObject({
    state: "sending",
    title: "Sending 3 captures…",
  });
});

test("a token saved while the app was closed waits for the app, and can be checked again", () => {
  const shown = view({
    pairing: "unconfirmed",
    lastError: error("app-unreachable"),
  });

  expect(shown).toMatchObject({
    state: "unconfirmed",
    title: "Waiting for the app",
    action: { does: "check", label: "Check again" },
    tokenField: "folded",
    problem: null,
  });
  expect(said(shown.detail)).toMatch(
    /Start the app with pnpm app, then check again\.$/,
  );
  expect(
    said(view({ pairing: "unconfirmed", captured: 1, pending: 1 }).detail),
  ).toMatch(/1 capture is kept here/);
});

test("a token the app did not prove is a problem, with the field in the open again", () => {
  const shown = view({ pairing: "refused", lastError: error("app-unproven") });

  expect(shown).toMatchObject({
    state: "refused",
    tone: "problem",
    title: "The app did not accept this token",
    action: { does: "check" },
    tokenField: "open",
    problem: null,
  });
  expect(said(shown.detail)).toMatch(/Run pnpm pair and paste the token/);
});

test("a refused token checked again while nothing listens is an app that is not answering", () => {
  expect(
    view({ pairing: "refused", lastError: error("app-unreachable") }).state,
  ).toBe("unconfirmed");
});

test("paired with nothing captured says where to go, and counts nothing", () => {
  const shown = view({});

  expect(shown).toMatchObject({
    state: "ready",
    title: "Paired. Nothing captured yet",
    action: null,
    tokenField: "folded",
    counts: false,
  });
  expect(said(shown.detail)).toMatch(/Open your bookmarks on X and scroll/);
});

test("everything delivered is up to date", () => {
  const shown = view({
    captured: 152,
    delivered: 152,
    lastCapturedAt: NOW - 3 * MINUTE,
    lastDeliveredAt: NOW - 3 * MINUTE,
  });

  expect(shown).toMatchObject({
    state: "up-to-date",
    title: "Up to date",
    action: null,
    counts: true,
  });
  expect(said(shown.detail)).toBe("All 152 captures are in the app.");
  expect(
    said(
      view({ captured: 1, delivered: 1, lastCapturedAt: NOW - MINUTE }).detail,
    ),
  ).toBe("The 1 capture taken is in the app.");
});

test("a capture in the last few seconds is capturing, and then it is not", () => {
  const recent = { captured: 47, delivered: 47 };

  expect(
    view({ ...recent, lastCapturedAt: NOW - CAPTURING_FOR_MS + 1 }),
  ).toMatchObject({ state: "capturing", tone: "active", icon: "live" });
  expect(
    view({ ...recent, lastCapturedAt: NOW - CAPTURING_FOR_MS }).state,
  ).toBe("up-to-date");
  // One on its way to the app does not interrupt it.
  expect(
    view({ captured: 48, delivered: 47, pending: 1, lastCapturedAt: NOW - 100 })
      .state,
  ).toBe("capturing");
  // What is read out does not change with every capture.
  expect(view({ ...recent, lastCapturedAt: NOW }).detail).toEqual(
    view({ captured: 48, delivered: 48, lastCapturedAt: NOW }).detail,
  );
});

test("captures on their way are being sent", () => {
  expect(
    view({
      captured: 5,
      delivered: 3,
      pending: 2,
      lastCapturedAt: NOW - MINUTE,
    }),
  ).toMatchObject({
    state: "sending",
    title: "Sending 2 captures…",
    action: null,
  });
});

test("captures the app was not running for wait, and say how they get there", () => {
  const shown = view({
    captured: 154,
    delivered: 152,
    pending: 2,
    lastCapturedAt: NOW - MINUTE,
    lastError: error("app-unreachable"),
  });

  expect(shown).toMatchObject({
    state: "waiting",
    tone: "neutral",
    title: "2 captures waiting for the app",
    action: { does: "send", label: "Send now" },
    problem: null,
  });
  expect(said(shown.detail)).toMatch(/Start it with pnpm app/);
  // Not even a capture arriving hides that the app is away.
  expect(
    view({
      captured: 1,
      pending: 1,
      lastCapturedAt: NOW,
      lastError: error("app-unreachable"),
    }),
  ).toMatchObject({ state: "waiting", title: "1 capture waiting for the app" });
});

test.each(["capture-unconfirmed", "app-unproven", null] as const)(
  "captures the app answered for without storing are not delivered (%s), in the worker's words too",
  (trouble) => {
    const shown = view({
      captured: 2,
      pending: 2,
      lastCapturedAt: NOW - MINUTE,
      lastError: error(trouble, "The app answered HTTP 500."),
    });

    expect(shown).toMatchObject({
      state: "stalled",
      tone: "problem",
      title: "2 captures not delivered",
      action: { does: "send", label: "Try again" },
    });
    expect(shown.problem).toEqual(
      trouble === "app-unproven"
        ? null
        : { at: NOW - MINUTE, message: "The app answered HTTP 500." },
    );
  },
);

test("captures the app refused come before everything else that is paired", () => {
  const shown = view({
    captured: 154,
    delivered: 151,
    pending: 1,
    rejected: 2,
    lastCapturedAt: NOW,
    lastError: error(
      "capture-refused",
      "The app refused a capture (HTTP 422).",
    ),
  });

  expect(shown).toMatchObject({
    state: "rejected",
    tone: "problem",
    title: "The app refused 2 captures",
    action: { does: "send", label: "Send again" },
    problem: { message: "The app refused a capture (HTTP 422)." },
  });
  expect(view({ captured: 1, rejected: 1 }).title).toBe(
    "The app refused 1 capture",
  );
});

test("a response that could not be captured is the state until a capture succeeds", () => {
  const lastError = error(
    "not-captured",
    "Bookmarks: X answered HTTP 429; nothing was captured.",
  );
  const missed = view({
    captured: 61,
    delivered: 61,
    lastCapturedAt: NOW - 5 * MINUTE,
    lastError,
  });
  const since = view({
    captured: 62,
    delivered: 62,
    lastCapturedAt: NOW - MINUTE / 2,
    lastError,
  });

  expect(missed).toMatchObject({
    state: "not-captured",
    title: "A response was not captured",
    problem: { message: lastError.message },
  });
  expect(view({ lastError }).state).toBe("not-captured");
  // Afterwards it is a record under the state, not the state.
  expect(since).toMatchObject({
    state: "up-to-date",
    problem: { message: lastError.message },
  });
});

test.each(["pairing", "checking", "sending"] as const)(
  "the button pressed stays on the page while %s is under way",
  (activity) => {
    const pressed = {
      pairing: view({ pairing: "none" }),
      checking: view({ pairing: "unconfirmed" }),
      sending: view({
        captured: 2,
        pending: 2,
        lastError: error("app-unreachable"),
      }),
    }[activity];
    const during = {
      pairing: view({ pairing: "none" }, activity),
      checking: view({ pairing: "unconfirmed" }, activity),
      sending: view(
        { captured: 2, pending: 2, lastError: error("app-unreachable") },
        activity,
      ),
    }[activity];

    expect(during.tokenField).toBe(pressed.tokenField);
    expect(during.action?.does).toBe(pressed.action?.does);
    if (activity === "sending") {
      expect(during).toMatchObject({ state: "sending", title: "Sending…" });
    }
  },
);

test("a time is said as how long ago, and after a day as its date", () => {
  expect(ago(NOW - 59_000, NOW)).toBe("just now");
  expect(ago(NOW + 5000, NOW)).toBe("just now");
  expect(ago(NOW - 2 * MINUTE, NOW)).toBe("2 min ago");
  expect(ago(NOW - 59 * MINUTE, NOW)).toBe("59 min ago");
  expect(ago(NOW - 3 * 60 * MINUTE, NOW)).toBe("3 h ago");
  expect(ago(NOW - 26 * 60 * MINUTE, NOW)).toBe(
    new Date(NOW - 26 * 60 * MINUTE).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    }),
  );
});
