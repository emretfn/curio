import { dirname } from "node:path";
import { openTempStore, tempDatabasePath } from "@x-bookmarks/core/testing";
import { APP_ORIGIN } from "@x-bookmarks/extension";
import { afterEach, expect, test, vi } from "vitest";
import { tagNow } from "./tagging.ts";
import { handleTaggingStatus } from "./tagging-status.ts";

const HOST = new URL(APP_ORIGIN).host;

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __xBookmarksTagging?: unknown }).__xBookmarksTagging;
});

const request = (headers: Record<string, string> = {}) =>
  new Request(`${APP_ORIGIN}/api/tagging`, {
    headers: { host: HOST, "sec-fetch-site": "same-origin", ...headers },
  });

test("before any pass it says so, and counts the library", async () => {
  const response = handleTaggingStatus(request(), openTempStore());

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await response.json()).toMatchObject({
    lastAttempt: null,
    running: false,
    scheduled: false,
    library: { bookmarks: 0, classified: 0, unclassified: 0, spentUsd: 0 },
  });
});

test("after a pass it says what the pass came to", async () => {
  const path = tempDatabasePath();
  vi.stubEnv("X_BOOKMARKS_DATA_DIR", dirname(path));
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

  const answer = await handleTaggingStatus(request(), store).json();

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
])("a request %s is refused", (_, headers) => {
  const response = handleTaggingStatus(request(headers), openTempStore());

  expect(response.status).toBe(403);
});

test("a program that sends no fetch metadata is answered: the status holds nothing a local program cannot read", () => {
  const response = handleTaggingStatus(
    new Request(`${APP_ORIGIN}/api/tagging`, { headers: { host: HOST } }),
    openTempStore(),
  );

  expect(response.status).toBe(200);
});
