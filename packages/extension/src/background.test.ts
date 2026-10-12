import { afterEach, expect, test, vi } from "vitest";
import type { Message, Status } from "./channel.ts";
import { EXTENSION_ID, parseQueuedCapture } from "./protocol.ts";
import { fakeApp, TOKEN } from "./testing.ts";

const payload =
  '{ "sortIndex":1861899614026727424,\n\t"text" : "caf\\u00e9 \u{1F516} ünïcode" }\n';
const seen = {
  operation: "Bookmarks",
  requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%7D",
  requestBody: null,
  payload,
} as const;
const captured: Message = {
  type: "hook-event",
  event: { kind: "capture", capture: seen },
};

type Sender = { id?: string; origin?: string; tab?: { id: number } };
const X_TAB: Sender = {
  id: EXTENSION_ID,
  origin: "https://x.com",
  tab: { id: 1 },
};
const POPUP: Sender = {
  id: EXTENSION_ID,
  origin: `chrome-extension://${EXTENSION_ID}`,
};

/**
 * The parts of Chrome the service worker uses. Storage and alarms belong to
 * the browser, so they outlive any one run of the worker.
 */
function fakeBrowser() {
  const stored = new Map<string, unknown>();
  const alarms = new Map<string, unknown>();
  const accessLevels: unknown[] = [];
  let onMessage:
    | ((
        message: unknown,
        sender: Sender,
        respond: (r: unknown) => void,
      ) => boolean)
    | undefined;
  let onAlarm: ((alarm: { name: string }) => void) | undefined;

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      onMessage: {
        addListener: (listener: typeof onMessage) => {
          onMessage = listener;
        },
      },
    },
    storage: {
      local: {
        setAccessLevel: async (level: unknown) => void accessLevels.push(level),
        get: async (key: string) => ({
          [key]: structuredClone(stored.get(key)),
        }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            stored.set(key, structuredClone(value));
          }
        },
        remove: async (key: string) => void stored.delete(key),
        getKeys: async () => [...stored.keys()],
      },
    },
    alarms: {
      create: async (name: string, info: unknown) =>
        void alarms.set(name, info),
      clear: async (name: string) => alarms.delete(name),
      get: async (name: string) =>
        alarms.has(name)
          ? { name, ...(alarms.get(name) as object) }
          : undefined,
      onAlarm: {
        addListener: (listener: typeof onAlarm) => {
          onAlarm = listener;
        },
      },
    },
  };

  return {
    chrome,
    stored,
    alarms,
    accessLevels,
    /**
     * Starts a run of the worker: evaluates background.ts afresh, as Chrome
     * does, with only storage and alarms carried over.
     */
    async startWorker() {
      onMessage = undefined;
      onAlarm = undefined;
      vi.resetModules();
      await import("./background.ts");
    },
    /** Delivers a message as Chrome would; resolves with the worker's reply. */
    send(
      message: unknown,
      sender: Sender,
    ): Promise<Status | undefined | "ignored"> {
      return new Promise((resolve) => {
        const willRespond = onMessage?.(message, sender, (reply) =>
          resolve(reply as Status | undefined),
        );
        if (willRespond !== true) resolve("ignored");
      });
    },
    fireAlarm: (name: string) => onAlarm?.({ name }),
    waiting: () => [...stored.keys()].filter((key) => key.startsWith("queue:")),
  };
}

function setUp(options: { paired?: boolean } = {}) {
  const browser = fakeBrowser();
  const app = fakeApp();
  if (options.paired !== false) browser.stored.set("token", TOKEN);
  vi.stubGlobal("chrome", browser.chrome);
  vi.stubGlobal("fetch", app.fetch);
  return { browser, app };
}

/** Lets the worker's started work run as far as it can without the app answering. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("the worker closes its storage to content scripts as soon as it starts", async () => {
  const { browser } = setUp();

  await browser.startWorker();

  expect(browser.accessLevels).toEqual([{ accessLevel: "TRUSTED_CONTEXTS" }]);
});

test("a capture from an x.com tab is queued, dated by the worker's clock, and delivered", async () => {
  const { browser, app } = setUp();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:30:00.123Z"));
  await browser.startWorker();

  const status = await browser.send(captured, X_TAB);

  expect(status).toMatchObject({ captured: 1, delivered: 1, pending: 0 });
  const delivered = JSON.parse(
    app.requests.find(({ path }) => path === "/api/ingest")?.body ?? "",
  );
  expect(parseQueuedCapture(delivered)).toEqual({
    id: delivered.id,
    ...seen,
    capturedAt: Date.parse("2026-10-12T08:30:00.123Z"),
  });
});

test("a time claimed in the event never reaches the queue: a forged capture is dated now", async () => {
  const { browser, app } = setUp();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:30:00.123Z"));
  await browser.startWorker();
  const backdated = Date.parse("2017-01-01T00:00:00Z");

  await browser.send(
    {
      type: "hook-event",
      capturedAt: backdated,
      event: {
        kind: "capture",
        capturedAt: backdated,
        capture: { ...seen, capturedAt: backdated, receivedAt: backdated },
      },
    },
    X_TAB,
  );

  const delivered = JSON.parse(
    app.requests.find(({ path }) => path === "/api/ingest")?.body ?? "",
  );
  expect(delivered.capturedAt).toBe(Date.parse("2026-10-12T08:30:00.123Z"));
  expect(JSON.stringify(delivered)).not.toContain(String(backdated));
});

test.each([
  ["an operation off the allowlist", { ...seen, operation: "HomeTimeline" }],
  [
    "a URL from another operation",
    { ...seen, requestUrl: "https://x.com/i/api/graphql/abc/HomeTimeline" },
  ],
  ["a parsed payload", { ...seen, payload: { data: {} } }],
  ["no payload", { ...seen, payload: "" }],
])("an event with %s is dropped", async (_, capture) => {
  const { browser, app } = setUp();
  await browser.startWorker();

  await browser.send(
    { type: "hook-event", event: { kind: "capture", capture } },
    X_TAB,
  );
  await browser.send({ type: "hook-event", event: "nonsense" }, X_TAB);
  await browser.send({ type: "hook-event" }, X_TAB);

  expect(browser.waiting()).toEqual([]);
  expect(app.fetch).not.toHaveBeenCalled();
  expect(await browser.send({ type: "get-status" }, POPUP)).toMatchObject({
    captured: 0,
  });
});

test.each([
  ["another extension", { ...X_TAB, id: "a".repeat(32) }, "ignored"],
  [
    "a tab on another site",
    { ...X_TAB, origin: "https://evil.example" },
    undefined,
  ],
  [
    "a subdomain of x.com",
    { ...X_TAB, origin: "https://evil.x.com" },
    undefined,
  ],
  [
    "something that is not a tab",
    { id: EXTENSION_ID, origin: "https://x.com" },
    undefined,
  ],
] as const)(
  "a capture sent by %s is not accepted",
  async (_, sender, reply) => {
    const { browser, app } = setUp();
    await browser.startWorker();

    expect(await browser.send(captured, sender)).toBe(reply);

    expect(browser.waiting()).toEqual([]);
    expect(app.fetch).not.toHaveBeenCalled();
  },
);

test("only the extension's own pages may pair, ask for delivery or read the status", async () => {
  const { browser, app } = setUp({ paired: false });
  await browser.startWorker();

  // A content script in an x.com tab shares the extension's id, not its origin.
  for (const message of [
    { type: "set-token", token: "attacker-token" },
    { type: "deliver-now" },
    { type: "get-status" },
    { type: "something-else" },
  ]) {
    expect(await browser.send(message, X_TAB)).toBeUndefined();
  }
  expect(browser.stored.has("token")).toBe(false);
  expect(app.fetch).not.toHaveBeenCalled();

  const paired = await browser.send({ type: "set-token", token: TOKEN }, POPUP);
  expect(paired).toMatchObject({ pairing: "paired" });
  expect(await browser.send({ type: "something-else" }, POPUP)).toBeUndefined();
});

test("a problem reported from an x.com tab shows in the status", async () => {
  const { browser } = setUp();
  await browser.startWorker();

  await browser.send(
    {
      type: "hook-event",
      event: {
        kind: "problem",
        problem: { operation: "Bookmarks", detail: "X answered HTTP 429." },
      },
    },
    X_TAB,
  );

  expect(await browser.send({ type: "get-status" }, POPUP)).toMatchObject({
    captured: 0,
    lastError: { message: "Bookmarks: X answered HTTP 429." },
  });
});

test("the retry alarm is set the moment a capture is queued, not when delivery ends", async () => {
  const { browser, app } = setUp();
  await browser.startWorker();
  app.hold();

  // The delivery this starts never finishes: the app does not answer.
  void browser.send(captured, X_TAB);
  await settled();

  expect(browser.waiting()).toHaveLength(1);
  expect(browser.alarms.get("retry-delivery")).toEqual({ periodInMinutes: 1 });
});

test("a worker stopped in the middle of a delivery leaves an alarm that finishes the job", async () => {
  const { browser, app } = setUp();
  await browser.startWorker();
  const release = app.hold();
  for (let index = 0; index < 5; index++) void browser.send(captured, X_TAB);
  await settled();
  expect(browser.waiting()).toHaveLength(5);

  // Chrome stops the worker: its pending work simply never continues. All
  // that is left is what the browser keeps, the storage and the alarm.
  release();
  app.goDown();
  await settled();
  expect(browser.waiting()).toHaveLength(5);
  expect(browser.alarms.has("retry-delivery")).toBe(true);
  app.comeUp();
  app.requests.length = 0;

  // The alarm fires, which starts the worker again.
  await browser.startWorker();
  browser.fireAlarm("retry-delivery");
  await vi.waitFor(() => expect(browser.waiting()).toEqual([]));

  expect(app.stored.size).toBe(5);
  await vi.waitFor(() =>
    expect(browser.alarms.has("retry-delivery")).toBe(false),
  );
});

test("a worker that starts with captures waiting delivers them without being asked", async () => {
  const { browser, app } = setUp();
  app.goDown();
  await browser.startWorker();
  await browser.send(captured, X_TAB);
  await browser.send(captured, X_TAB);
  expect(browser.waiting()).toHaveLength(2);
  app.comeUp();

  // Started for any reason at all, with no message and no alarm.
  await browser.startWorker();

  await vi.waitFor(() => expect(browser.waiting()).toEqual([]));
  expect(app.stored.size).toBe(2);
});

test("a worker that starts with nothing waiting contacts no one and sets no alarm", async () => {
  const { browser, app } = setUp();

  await browser.startWorker();
  await settled();
  browser.fireAlarm("some-other-alarm");
  await settled();

  expect(app.fetch).not.toHaveBeenCalled();
  expect(browser.alarms.size).toBe(0);
});

test("while the app stays closed the alarm stays, and is cleared once the queue is empty", async () => {
  const { browser, app } = setUp();
  app.goDown();
  await browser.startWorker();

  await browser.send(captured, X_TAB);
  browser.fireAlarm("retry-delivery");
  await settled();
  expect(browser.alarms.has("retry-delivery")).toBe(true);

  app.comeUp();
  browser.fireAlarm("retry-delivery");
  await vi.waitFor(() => expect(browser.waiting()).toEqual([]));
  await vi.waitFor(() =>
    expect(browser.alarms.has("retry-delivery")).toBe(false),
  );
});
