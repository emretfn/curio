import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openTempStore, tempDatabasePath } from "@x-bookmarks/core/testing";
import { APP_ORIGIN } from "@x-bookmarks/extension";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tagNow } from "./tagging.ts";
import { handleTaggingStatus } from "./tagging-status.ts";

const HOST = new URL(APP_ORIGIN).host;

/** This test's data directory, where the tagger looks for the `.env` file: never the repo's root, where the owner's is. */
let data: string;
let path: string;

beforeEach(() => {
  path = tempDatabasePath();
  data = dirname(path);
  vi.stubEnv("X_BOOKMARKS_DATA_DIR", data);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __xBookmarksTagging?: unknown }).__xBookmarksTagging;
});

const request = (headers: Record<string, string> = {}) =>
  new Request(`${APP_ORIGIN}/api/tagging`, {
    headers: { host: HOST, "sec-fetch-site": "same-origin", ...headers },
  });

test("before any pass it says so, and counts the library", async () => {
  const response = await handleTaggingStatus(request(), openTempStore(path));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toMatchObject({
    appTagging: { on: false },
    lastAttempt: null,
    running: false,
    scheduled: false,
    library: { bookmarks: 0, classified: 0, unclassified: 0, spentUsd: 0 },
  });
});

test("after a pass it says what the pass came to", async () => {
  const store = openTempStore(path);
  await tagNow(
    async () => ({
      status: "no-key",
      message: "There is no API key.",
      waiting: 4,
      reports: [],
      warning: null,
    }),
    () => store,
    () => new Date("2026-10-13T09:00:00.000Z"),
  );

  const answer = await (await handleTaggingStatus(request(), store)).json();

  expect(answer.lastAttempt).toEqual({
    at: "2026-10-13T09:00:00.000Z",
    status: "no-key",
    message: "There is no API key.",
    warning: null,
    waiting: 4,
    classified: 0,
    failed: 0,
    costUsd: 0,
    problem: false,
  });
});

test.each([
  [
    "under another name, as a re-pointed domain would",
    { host: "evil.example" },
  ],
  ["from a page of another site", { "sec-fetch-site": "cross-site" }],
  ["from another port of this computer", { "sec-fetch-site": "same-site" }],
])(
  "a request %s is refused, before the owner's setting is read",
  async (_, headers) => {
    const setting = vi.fn(async () => ({ on: false, message: "Off." }));

    const response = await handleTaggingStatus(
      request(headers),
      openTempStore(path),
      setting,
    );

    expect(response.status).toBe(403);
    expect(setting).not.toHaveBeenCalled();
  },
);

test("it says tagging by the app is off unless the owner's file turns it on, how to turn it on, and what does the same by hand", async () => {
  const store = openTempStore(path);
  const read = async () =>
    (await (await handleTaggingStatus(request(), store)).json()).appTagging;

  const byDefault = await read();
  writeFileSync(join(data, ".env"), "X_BOOKMARKS_APP_TAGGING=on\n", {
    mode: 0o600,
  });
  const turnedOn = await read();

  expect(byDefault.on).toBe(false);
  expect(byDefault.message).toMatch(/^Tagging by the app is off/);
  expect(byDefault.message).toContain(
    `add the line X_BOOKMARKS_APP_TAGGING=on to ${join(data, ".env")}`,
  );
  expect(byDefault.message).toContain("pnpm tag");
  expect(turnedOn.on).toBe(true);
  expect(turnedOn.message).toMatch(/^Tagging by the app is on/);
});

test("no request turns the app's tagging on: the route reads, whatever it is sent", async () => {
  const store = openTempStore(path);
  const asked = new Request(
    `${APP_ORIGIN}/api/tagging?appTagging=on&X_BOOKMARKS_APP_TAGGING=on`,
    {
      headers: {
        host: HOST,
        "sec-fetch-site": "same-origin",
        "x-bookmarks-app-tagging": "on",
      },
    },
  );

  const answer = await (await handleTaggingStatus(asked, store)).json();

  expect(answer.appTagging.on).toBe(false);
});

test("a program that sends no fetch metadata is answered: the status holds nothing a local program cannot read", async () => {
  const response = await handleTaggingStatus(
    new Request(`${APP_ORIGIN}/api/tagging`, { headers: { host: HOST } }),
    openTempStore(path),
  );

  expect(response.status).toBe(200);
});
