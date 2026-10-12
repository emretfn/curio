import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  APP_ORIGIN,
  CAPTURED_OPERATIONS,
  capturedOperationOf,
  EXTENSION_ID,
  parseHookEvent,
  parseIngestAnswer,
  parseQueuedCapture,
  parseSeenResponse,
} from "./protocol.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

const seen = {
  operation: "Bookmarks",
  requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%7D",
  requestBody: null,
  payload: '{"data":{}}',
} as const;
const capture = { ...seen, capturedAt: 1760257800123 } as const;

test("the allowlist is the bookmark timelines, the folder list and the two bookmark mutations", () => {
  expect(CAPTURED_OPERATIONS).toEqual([
    "Bookmarks",
    "BookmarkFolderTimeline",
    "BookmarkFoldersSlice",
    "CreateBookmark",
    "DeleteBookmark",
  ]);
});

test.each(CAPTURED_OPERATIONS)(
  "%s is recognised whatever its query id and query string",
  (operation) => {
    expect(
      capturedOperationOf(
        `https://x.com/i/api/graphql/tF6KOjmZM0WGcB2Q0mfwhw/${operation}?variables=%7B%7D&features=%7B%7D`,
      ),
    ).toBe(operation);
    expect(
      capturedOperationOf(
        `/i/api/graphql/j5KExFXtSWj8HjRui17ydA/${operation}`,
        "https://x.com/home",
      ),
    ).toBe(operation);
  },
);

test.each([
  ["another operation", "https://x.com/i/api/graphql/abc/HomeTimeline"],
  [
    "a name that only starts the same",
    "https://x.com/i/api/graphql/abc/BookmarksAllDelete",
  ],
  [
    "a name that only ends the same",
    "https://x.com/i/api/graphql/abc/SearchBookmarks",
  ],
  ["a different case", "https://x.com/i/api/graphql/abc/bookmarks"],
  [
    "the name in the query string",
    "https://x.com/i/api/graphql/abc/HomeTimeline?next=/graphql/abc/Bookmarks",
  ],
  ["the name before the query id", "https://x.com/i/api/graphql/Bookmarks/abc"],
  ["a deeper path", "https://x.com/i/api/graphql/abc/Bookmarks/extra"],
  ["the bookmarks page itself", "https://x.com/i/bookmarks"],
  ["another host", "https://example.com/i/api/graphql/abc/Bookmarks"],
  ["a host that ends in x.com", "https://notx.com/i/api/graphql/abc/Bookmarks"],
  [
    "x.com as a subdomain label",
    "https://x.com.example.com/i/api/graphql/abc/Bookmarks",
  ],
  ["plain http", "http://x.com/i/api/graphql/abc/Bookmarks"],
  ["a relative URL with no base", "/i/api/graphql/abc/Bookmarks"],
  ["not a URL", "::"],
])("%s is not captured", (_, url) => {
  expect(capturedOperationOf(url)).toBeUndefined();
});

test("a subdomain of x.com is accepted", () => {
  expect(capturedOperationOf("https://api.x.com/graphql/abc/Bookmarks")).toBe(
    "Bookmarks",
  );
});

test("a well-formed seen response is accepted with every field unchanged", () => {
  expect(parseSeenResponse({ ...seen, extra: "dropped" })).toEqual(seen);
  expect(parseHookEvent({ kind: "capture", capture: seen })).toEqual({
    kind: "capture",
    capture: seen,
  });
});

test("a time claimed by the page is dropped, not passed on", () => {
  const forged = { ...seen, capturedAt: Date.parse("2017-01-01T00:00:00Z") };

  expect(parseSeenResponse(forged)).toEqual(seen);
  expect(parseHookEvent({ kind: "capture", capture: forged })).toEqual({
    kind: "capture",
    capture: seen,
  });
});

test.each([
  ["an operation off the allowlist", { operation: "HomeTimeline" }],
  [
    "a URL that belongs to another operation",
    { requestUrl: "https://x.com/i/api/graphql/abc/HomeTimeline" },
  ],
  ["an empty payload", { payload: "" }],
  ["a parsed payload", { payload: { data: {} } }],
  ["a missing request body", { requestBody: undefined }],
])("a seen response with %s is refused", (_, change) => {
  expect(parseSeenResponse({ ...seen, ...change })).toBeUndefined();
  expect(
    parseHookEvent({ kind: "capture", capture: { ...seen, ...change } }),
  ).toBeUndefined();
});

test("a queued capture needs a UUID as its id and a whole number of milliseconds as its time", () => {
  const id = "0b9d6f4e-6a55-4c0e-9a51-0d6f8b1c2e3f";

  expect(parseQueuedCapture({ id, ...capture })).toEqual({ id, ...capture });
  expect(parseQueuedCapture(capture)).toBeUndefined();
  expect(parseQueuedCapture({ ...capture, id: "1" })).toBeUndefined();
  expect(parseQueuedCapture({ id, ...seen })).toBeUndefined();
  expect(parseQueuedCapture({ id, ...seen, capturedAt: 1.5 })).toBeUndefined();
  expect(
    parseQueuedCapture({ id, ...seen, capturedAt: "1760257800123" }),
  ).toBeUndefined();
  expect(parseQueuedCapture(null)).toBeUndefined();
});

test("only the app's stored or duplicate answer, naming a capture, counts as an acknowledgement", () => {
  expect(parseIngestAnswer({ status: "stored", id: "a" })).toEqual({
    status: "stored",
    id: "a",
  });
  expect(parseIngestAnswer({ status: "duplicate", id: "a", more: 1 })).toEqual({
    status: "duplicate",
    id: "a",
  });
  expect(parseIngestAnswer({ status: "ok", id: "a" })).toBeUndefined();
  expect(parseIngestAnswer({ status: "stored" })).toBeUndefined();
  expect(parseIngestAnswer({})).toBeUndefined();
  expect(parseIngestAnswer(undefined)).toBeUndefined();
  expect(parseIngestAnswer("stored")).toBeUndefined();
});

test("a problem is accepted only for an allowlisted operation, and its text is capped", () => {
  expect(
    parseHookEvent({
      kind: "problem",
      problem: { operation: "Bookmarks", detail: "x".repeat(500) },
    }),
  ).toEqual({
    kind: "problem",
    problem: { operation: "Bookmarks", detail: "x".repeat(200) },
  });
  expect(
    parseHookEvent({
      kind: "problem",
      problem: { operation: "HomeTimeline", detail: "x" },
    }),
  ).toBeUndefined();
  expect(parseHookEvent({ kind: "other" })).toBeUndefined();
});

test("EXTENSION_ID is the id Chrome derives from the manifest key", () => {
  const digest = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex");
  const id = [...digest.slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");

  expect(EXTENSION_ID).toBe(id);
});

test("the manifest grants the local app's origin and no access to X beyond the two content scripts", () => {
  expect(manifest.host_permissions).toEqual([`${APP_ORIGIN}/*`]);
  expect(manifest.optional_host_permissions).toBeUndefined();
  expect(manifest.permissions).toEqual([
    "storage",
    "unlimitedStorage",
    "alarms",
  ]);
  expect(manifest.externally_connectable).toBeUndefined();
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(manifest.content_scripts).toEqual([
    {
      matches: ["https://x.com/*"],
      js: ["page-hook.js"],
      run_at: "document_start",
      world: "MAIN",
    },
    {
      matches: ["https://x.com/*"],
      js: ["relay.js"],
      run_at: "document_start",
    },
  ]);
});
