import { afterEach, expect, test, vi } from "vitest";
import { HOOK_EVENT } from "./channel.ts";

const seen = {
  operation: "Bookmarks",
  requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%7D",
  requestBody: null,
  payload: '{ "sortIndex":1861899614026727424 }',
} as const;

/** Loads the relay into a stand-in page and returns how to fire events at it. */
async function startRelay(
  sendMessage: (message: unknown) => Promise<unknown> = async () => undefined,
) {
  const page = new EventTarget();
  const send = vi.fn(sendMessage);
  vi.stubGlobal("window", page);
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
  vi.resetModules();
  await import("./relay.ts");
  return {
    send,
    fire: (detail: unknown, name: string = HOOK_EVENT) =>
      page.dispatchEvent(new CustomEvent(name, { detail })),
  };
}

afterEach(() => vi.unstubAllGlobals());

test("a capture reported by the page hook is passed to the service worker", async () => {
  const { send, fire } = await startRelay();

  fire(JSON.stringify({ kind: "capture", capture: seen }));

  expect(send.mock.calls).toEqual([
    [{ type: "hook-event", event: { kind: "capture", capture: seen } }],
  ]);
});

test("a problem is passed on, and a time claimed by the page is not", async () => {
  const { send, fire } = await startRelay();

  fire(
    JSON.stringify({
      kind: "problem",
      problem: { operation: "Bookmarks", detail: "X answered HTTP 429." },
    }),
  );
  fire(
    JSON.stringify({
      kind: "capture",
      capture: { ...seen, capturedAt: Date.parse("2017-01-01T00:00:00Z") },
    }),
  );

  expect(send.mock.calls).toEqual([
    [
      {
        type: "hook-event",
        event: {
          kind: "problem",
          problem: { operation: "Bookmarks", detail: "X answered HTTP 429." },
        },
      },
    ],
    [{ type: "hook-event", event: { kind: "capture", capture: seen } }],
  ]);
});

test.each([
  ["an object instead of text", { kind: "capture", capture: seen }],
  ["text that is not JSON", "{not json"],
  ["JSON that is not an event", '"capture"'],
  ["null", null],
  [
    "an operation off the allowlist",
    JSON.stringify({
      kind: "capture",
      capture: {
        ...seen,
        operation: "HomeTimeline",
        requestUrl: "https://x.com/i/api/graphql/abc/HomeTimeline",
      },
    }),
  ],
  [
    "a payload that is not text",
    JSON.stringify({ kind: "capture", capture: { ...seen, payload: {} } }),
  ],
])("an event carrying %s is dropped without an error", async (_, detail) => {
  const { send, fire } = await startRelay();

  expect(() => fire(detail)).not.toThrow();

  expect(send).not.toHaveBeenCalled();
});

test("events under any other name are not listened to", async () => {
  const { send, fire } = await startRelay();

  fire(JSON.stringify({ kind: "capture", capture: seen }), "message");
  fire(JSON.stringify({ kind: "capture", capture: seen }), "x-bookmarks:other");

  expect(send).not.toHaveBeenCalled();
});

test("when the extension was reloaded under the tab, nothing is thrown into the page", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const rejecting = await startRelay(async () => {
    throw new Error("Extension context invalidated.");
  });
  const event = JSON.stringify({ kind: "capture", capture: seen });

  expect(() => rejecting.fire(event)).not.toThrow();
  const throwing = await startRelay(() => {
    throw new Error("Extension context invalidated.");
  });
  expect(() => throwing.fire(event)).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.off("unhandledRejection", unhandled);

  expect(rejecting.send).toHaveBeenCalledTimes(1);
  expect(throwing.send).toHaveBeenCalledTimes(1);
  expect(unhandled).not.toHaveBeenCalled();
});
