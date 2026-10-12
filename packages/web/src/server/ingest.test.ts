import { globSync, readFileSync } from "node:fs";
import {
  getBookmark,
  getCaptureParse,
  getRawCapture,
  insertRawCaptureOnce,
  listParseIssues,
  summariseParsing,
  summariseRawCaptures,
} from "@x-bookmarks/core";
import { openTempStore, readFixture } from "@x-bookmarks/core/testing";
import {
  APP_HOST,
  APP_PORT,
  MAX_CAPTURE_BYTES,
  PROOF_HEADER,
  type QueuedCapture,
  responseProofIsValid,
  sha256Hex,
} from "@x-bookmarks/extension";
import { expect, test, vi } from "vitest";
import { handleIngest, handlePairingCheck, refusePreflight } from "./ingest.ts";
import { extensionRequest, NONCE, TOKEN } from "./testing.ts";

// Odd spacing, an integer beyond Number.MAX_SAFE_INTEGER, escapes and
// non-ASCII text: everything a JSON round-trip would normalise or corrupt.
const payload =
  '{ "sortIndex":1861899614026727424,\n\t"text" : "caf\\u00e9 \u{1F516} ünïcode" , "n": 1.0 }\n';
const now = Date.parse("2026-10-12T09:00:00.000Z");
const OTHER_TOKEN = "Zq3vX2mB8sYt0aLr5nWc7dHf1gJz4pQe9uTi6oVbNxM";

const capture: QueuedCapture = {
  id: "0b9d6f4e-6a55-4c0e-9a51-0d6f8b1c2e3f",
  operation: "Bookmarks",
  requestUrl:
    "https://x.com/i/api/graphql/tF6KOjmZM0WGcB2Q0mfwhw/Bookmarks?variables=%7B%22count%22%3A20%7D",
  requestBody: null,
  payload,
  capturedAt: Date.parse("2026-10-12T08:30:00.123Z"),
};

function setUp() {
  const store = openTempStore();
  const ingest = (request: Request) =>
    handleIngest(request, { store, token: TOKEN, now: () => now });
  const send = async (
    body: unknown = capture,
    headers: Record<string, string | null> = {},
  ) =>
    ingest(
      await extensionRequest("/api/ingest", JSON.stringify(body), headers),
    );
  return { store, ingest, send };
}

/** Whether a response carries the app's proof for the test request's nonce. */
async function isProven(response: Response): Promise<boolean> {
  const text = await response.clone().text();
  return responseProofIsValid(
    TOKEN,
    {
      nonce: NONCE,
      status: response.status,
      bodyDigest: await sha256Hex(text),
    },
    response.headers.get(PROOF_HEADER) ?? "",
  );
}

test("a capture from the extension is stored exactly as it was captured, and acknowledged with proof", async () => {
  const { store, send } = setUp();

  const response = await send();

  expect(response.status).toBe(201);
  expect(await isProven(response)).toBe(true);
  expect(await response.json()).toEqual({ status: "stored", id: capture.id });
  expect(getRawCapture(store, 1)).toEqual({
    id: 1,
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    requestUrl: capture.requestUrl,
    requestBody: null,
    captureKey: capture.id,
    receivedAt: new Date(capture.capturedAt),
  });
});

test("a mutation's request body is stored with it, unchanged", async () => {
  const { store, send } = setUp();
  const requestBody =
    '{"variables":{ "tweet_id":"1861899614026727424" },"queryId":"abc"}';

  await send({
    ...capture,
    operation: "CreateBookmark",
    requestUrl: "https://x.com/i/api/graphql/abc/CreateBookmark",
    requestBody,
    payload: '{"data":{"tweet_bookmark_put":"Done"}}',
  });

  expect(getRawCapture(store, 1)).toMatchObject({
    operation: "CreateBookmark",
    requestBody,
    payload: '{"data":{"tweet_bookmark_put":"Done"}}',
  });
});

// A real response, redacted: what the parser was written against.
const bookmarksPage = readFixture(
  "x-web-client/Bookmarks/2026-10-12-text-posts.json",
);
/** The id of the page's second post, from the entry that holds it. */
const SECOND_POST: string =
  JSON.parse(
    bookmarksPage,
  ).data.bookmark_timeline_v2.timeline.instructions[0].entries[1].entryId.slice(
    6,
  );

test("a bookmarks capture becomes bookmarks as it arrives, first seen when it was captured", async () => {
  const { store, send } = setUp();

  const response = await send({ ...capture, payload: bookmarksPage });

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ status: "stored", id: capture.id });
  expect(getCaptureParse(store, 1)).toMatchObject({
    outcome: "parsed",
    bookmarkCount: 5,
    failedEntryCount: 0,
  });
  expect(getBookmark(store, SECOND_POST)).toMatchObject({
    authorHandle: expect.stringMatching(/^[a-z]+$/),
    card: { domain: "site6.example" },
    firstSeenAt: new Date(capture.capturedAt),
    firstSeenCaptureId: 1,
  });
  expect(summariseParsing(store)).toMatchObject({
    bookmarks: 5,
    captures: { parsed: 1, failed: 0, pending: 0 },
  });
});

test("a capture the parser does not understand is stored and acknowledged all the same, and recorded as failed", async () => {
  const { store, send } = setUp();

  const response = await send();

  expect(response.status).toBe(201);
  expect(await isProven(response)).toBe(true);
  expect(getRawCapture(store, 1)?.payload).toBe(payload);
  expect(getCaptureParse(store, 1)).toMatchObject({ outcome: "failed" });
  expect(listParseIssues(store)).toMatchObject([
    { kind: "capture-failed", code: "missing-field", path: "$.data" },
  ]);
  expect(summariseParsing(store).bookmarks).toBe(0);
});

test("a capture of an operation with no parser yet is stored and recorded as that", async () => {
  const { store, send } = setUp();

  await send({
    ...capture,
    operation: "BookmarkFolderTimeline",
    requestUrl: "https://x.com/i/api/graphql/abc/BookmarkFolderTimeline",
    payload: '{"data":{}}',
  });

  expect(summariseRawCaptures(store).count).toBe(1);
  expect(summariseParsing(store).captures).toMatchObject({
    noParser: 1,
    failed: 0,
  });
});

test("when parsing itself breaks, the capture is already stored and the extension is told so", async () => {
  const store = openTempStore();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const request = await extensionRequest(
    "/api/ingest",
    JSON.stringify({ ...capture, payload: bookmarksPage }),
  );

  const response = await handleIngest(request, {
    store,
    token: TOKEN,
    now: () => now,
    parse: () => {
      throw new Error("the database is locked");
    },
  });

  expect(response.status).toBe(201);
  expect(await isProven(response)).toBe(true);
  expect(await response.json()).toEqual({ status: "stored", id: capture.id });
  expect(getRawCapture(store, 1)?.payload).toBe(bookmarksPage);
  expect(summariseParsing(store).captures.pending).toBe(1);
  expect(logged).toHaveBeenCalledOnce();
  logged.mockRestore();
});

test("the next delivery parses whatever an earlier one left unparsed, oldest first", async () => {
  const { store, send } = setUp();
  // Stored and never parsed: by an older version of the app, or one that
  // stopped between the two steps.
  insertRawCaptureOnce(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: bookmarksPage,
    receivedAt: new Date(capture.capturedAt - 60_000),
    captureKey: "7c1f0d52-3b7e-4f0a-8d2c-5e6f7a8b9c0d",
  });
  expect(summariseParsing(store).captures.pending).toBe(1);

  const redelivered = await send({
    ...capture,
    id: "7c1f0d52-3b7e-4f0a-8d2c-5e6f7a8b9c0d",
    payload: bookmarksPage,
  });
  const next = await send({ ...capture, payload: bookmarksPage });

  expect([redelivered.status, next.status]).toEqual([200, 201]);
  expect(summariseParsing(store).captures).toMatchObject({
    parsed: 2,
    pending: 0,
  });
  expect(getBookmark(store, SECOND_POST)).toMatchObject({
    firstSeenAt: new Date(capture.capturedAt - 60_000),
    firstSeenCaptureId: 1,
    lastSeenCaptureId: 2,
  });
});

test("a redelivered capture is acknowledged and not stored again", async () => {
  const { store, send } = setUp();

  const first = await send();
  const second = await send();
  const third = await send();

  expect([first.status, second.status, third.status]).toEqual([201, 200, 200]);
  expect(await isProven(second)).toBe(true);
  expect(await second.json()).toEqual({ status: "duplicate", id: capture.id });
  expect(summariseRawCaptures(store).count).toBe(1);
});

test("captures with different ids are stored separately, even with the same payload", async () => {
  const { store, send } = setUp();

  await send();
  await send({ ...capture, id: "7c1f0d52-3b7e-4f0a-8d2c-5e6f7a8b9c0d" });

  expect(summariseRawCaptures(store, "x-web-client").count).toBe(2);
});

test.each([
  ["no Origin, as from a script outside a browser", { origin: null }, 403],
  ["a web page", { origin: "https://evil.example" }, 403],
  ["the app's own pages", { origin: `http://${APP_HOST}:${APP_PORT}` }, 403],
  [
    "another extension",
    { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    403,
  ],
  ["a rebound domain", { host: "evil.example:47130" }, 403],
  ["the extension without a signature", { authorization: null }, 401],
  [
    "a caller presenting the token itself",
    { authorization: `Bearer ${TOKEN}` },
    401,
  ],
] as const)(
  "a capture from %s is refused before its body is read, and nothing is stored",
  async (_, headers, status) => {
    const { store, ingest } = setUp();
    const request = await extensionRequest(
      "/api/ingest",
      JSON.stringify(capture),
      headers,
    );

    const response = await ingest(request);

    expect(response.status).toBe(status);
    expect(request.bodyUsed).toBe(false);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get(PROOF_HEADER)).toBeNull();
    expect(summariseRawCaptures(store).count).toBe(0);
  },
);

test("a capture signed with another token is refused before its body is read", async () => {
  const { store, ingest } = setUp();
  const request = await extensionRequest(
    "/api/ingest",
    JSON.stringify(capture),
    {},
    OTHER_TOKEN,
  );

  const response = await ingest(request);

  expect(response.status).toBe(401);
  expect(request.bodyUsed).toBe(false);
  expect(summariseRawCaptures(store).count).toBe(0);
});

test("a body other than the one that was signed is refused", async () => {
  const { store, ingest } = setUp();
  const signed = await extensionRequest("/api/ingest", JSON.stringify(capture));
  const withBody = (body: string) =>
    new Request(signed.url, { method: "POST", headers: signed.headers, body });

  const responses = [
    await ingest(
      withBody(JSON.stringify({ ...capture, payload: '{"forged":true}' })),
    ),
    // Cut short, as a proxy with a size limit would leave it.
    await ingest(withBody(JSON.stringify(capture).slice(0, 100))),
  ];

  for (const response of responses) {
    expect(response.status).toBe(400);
    expect(await isProven(response)).toBe(true);
    expect(await response.json()).toEqual({
      error: "The body is not the one that was signed.",
    });
  }
  expect(summariseRawCaptures(store).count).toBe(0);
});

test("a form-style post, the kind a page can send without a preflight, is refused even when signed", async () => {
  const { store, send } = setUp();

  const response = await send(capture, { "content-type": "text/plain" });

  expect(response.status).toBe(415);
  expect(summariseRawCaptures(store).count).toBe(0);
});

test.each([
  [
    "an operation off the allowlist",
    {
      operation: "HomeTimeline",
      requestUrl: "https://x.com/i/api/graphql/abc/HomeTimeline",
    },
  ],
  [
    "a URL from another operation",
    { requestUrl: "https://x.com/i/api/graphql/abc/HomeTimeline" },
  ],
  [
    "a URL on another host",
    { requestUrl: "https://example.com/i/api/graphql/abc/Bookmarks" },
  ],
  ["an empty payload", { payload: "" }],
  ["a payload that was parsed", { payload: { data: {} } }],
  ["an id that is not a UUID", { id: "1" }],
  ["no capture time", { capturedAt: undefined }],
  ["a capture time in seconds", { capturedAt: 1760257800 }],
  ["a capture time in the future", { capturedAt: now + 10 * 60 * 1000 }],
])(
  "a body with %s is refused, with proof, and nothing is stored",
  async (_, change) => {
    const { store, send } = setUp();

    const response = await send({ ...capture, ...change });

    expect(response.status).toBe(422);
    expect(await isProven(response)).toBe(true);
    expect(summariseRawCaptures(store).count).toBe(0);
  },
);

test("a capture time slightly ahead of this machine's clock is accepted", async () => {
  const { send } = setUp();

  const response = await send({ ...capture, capturedAt: now + 60 * 1000 });

  expect(response.status).toBe(201);
});

test("a body that is not JSON is refused", async () => {
  const { store, ingest } = setUp();

  const response = await ingest(
    await extensionRequest("/api/ingest", "{not json"),
  );

  expect(response.status).toBe(400);
  expect(summariseRawCaptures(store).count).toBe(0);
});

test("a body above the size limit is refused, by its declared length or its real one", async () => {
  const { store, ingest, send } = setUp();

  const declared = await ingest(
    await extensionRequest("/api/ingest", JSON.stringify(capture), {
      "content-length": String(MAX_CAPTURE_BYTES + 1),
    }),
  );
  const real = await send({
    ...capture,
    payload: "x".repeat(MAX_CAPTURE_BYTES),
  });

  expect([declared.status, real.status]).toEqual([413, 413]);
  expect(summariseRawCaptures(store).count).toBe(0);
});

test("a capture just under the size limit is stored whole", async () => {
  const { store, send } = setUp();
  const large = `{"filler":"${"x".repeat(MAX_CAPTURE_BYTES - 4096)}"}`;

  const response = await send({ ...capture, payload: large });

  expect(response.status).toBe(201);
  expect(getRawCapture(store, 1)?.payload).toBe(large);
});

test("the pairing check proves the app to the paired extension and tells anyone else nothing", async () => {
  const check = async (
    headers: Record<string, string | null> = {},
    token?: string,
  ) =>
    handlePairingCheck(
      await extensionRequest("/api/pairing", "{}", headers, token),
      TOKEN,
    );

  const paired = await check();
  const wrongToken = await check({}, OTHER_TOKEN);
  const webPage = await check({ origin: "https://evil.example" });

  expect(paired.status).toBe(200);
  expect(await isProven(paired)).toBe(true);
  expect(wrongToken.status).toBe(401);
  expect(wrongToken.headers.get(PROOF_HEADER)).toBeNull();
  expect(webPage.status).toBe(403);
  expect(webPage.headers.get(PROOF_HEADER)).toBeNull();
});

test("a preflight is refused with no CORS headers, so no page's cross-origin request is ever approved", () => {
  const response = refusePreflight();

  expect(response.status).toBe(403);
  expect(
    [...response.headers.keys()].filter((name) =>
      name.startsWith("access-control-"),
    ),
  ).toEqual([]);
});

test("the app's start scripts listen on the loopback address and the port the extension is permitted to reach", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const binding = `--hostname ${APP_HOST} --port ${APP_PORT}`;

  expect(APP_HOST).toBe("127.0.0.1");
  expect(scripts.app).toContain(`next start ${binding}`);
  expect(scripts.dev).toContain(`next dev ${binding}`);
});

test("the pairing token is read only by the two routes that check a signature", () => {
  // No page or other route can show the token if none of them reads it. The
  // one place it is ever displayed is the terminal, by `pnpm pair`.
  const appRoot = new URL("../app/", import.meta.url);
  const readers = globSync("**/*.{ts,tsx}", { cwd: appRoot })
    .filter((file) =>
      readFileSync(new URL(file, appRoot), "utf8").includes("sharedToken"),
    )
    .sort();

  expect(readers).toEqual(["api/ingest/route.ts", "api/pairing/route.ts"]);
});
