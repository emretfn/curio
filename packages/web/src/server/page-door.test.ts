import { expect, test } from "vitest";
import { refuseUnlessExtension } from "./guard.ts";
import {
  MAX_PAGE_WRITE_BYTES,
  readPageBody,
  refuseUnlessOwnPage,
  tooLarge,
} from "./page-door.ts";
import { extensionRequest, pageRequest, TOKEN } from "./testing.ts";

const CHANGE = "/api/owner/correct";

test.each([
  ["at 127.0.0.1", {}],
  [
    "at localhost",
    { host: "localhost:47130", origin: "http://localhost:47130" },
  ],
  [
    "with a character set named",
    { "content-type": "application/json; charset=utf-8" },
  ],
  [
    "with the host in capitals",
    { host: "LOCALHOST:47130", origin: "http://localhost:47130" },
  ],
] as const)("a change from the app's own page %s may proceed", (_, headers) => {
  const request = pageRequest(CHANGE, "{}", headers);

  expect(refuseUnlessOwnPage(request)).toBeNull();
  expect(request.bodyUsed).toBe(false);
});

test.each([
  [
    "a page on another site",
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    403,
  ],
  // Each header is the browser's own word, and each is checked by itself: a
  // request that gets one of them right is still not from this app's page.
  ["another site's origin alone", { origin: "https://evil.example" }, 403],
  ["a cross-site mark alone", { "sec-fetch-site": "cross-site" }, 403],
  [
    "a page on another port of this computer",
    { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-site" },
    403,
  ],
  [
    "the app's page under its other name",
    { origin: "http://localhost:47130", "sec-fetch-site": "same-site" },
    403,
  ],
  [
    "a domain re-pointed at this computer, which the browser takes for one origin with the app",
    {
      host: "evil.example:47130",
      origin: "http://evil.example:47130",
      "sec-fetch-site": "same-origin",
    },
    403,
  ],
  [
    "a rebound domain that names the app as its origin",
    { host: "evil.example:47130" },
    403,
  ],
  [
    "the capture extension, which has a door of its own",
    {
      origin: "chrome-extension://imbpimaegfnjdhdcfefapkaejieaahjh",
      "sec-fetch-site": "none",
    },
    403,
  ],
  ["a sandboxed frame", { origin: "null" }, 403],
  ["no Origin", { origin: null }, 403],
  [
    "an origin over HTTPS, which this app is not served on",
    { origin: "https://127.0.0.1:47130" },
    403,
  ],
  [
    "no word from the browser on where it came from",
    { "sec-fetch-site": null },
    403,
  ],
  ["a request the user typed, not a page", { "sec-fetch-site": "none" }, 403],
  ["no Host", { host: null }, 403],
  [
    "a form's content type",
    { "content-type": "application/x-www-form-urlencoded" },
    415,
  ],
  [
    "plain text, which a page can send without asking",
    { "content-type": "text/plain" },
    415,
  ],
  ["no content type", { "content-type": null }, 415],
  [
    "a body declared larger than a change can be",
    { "content-length": String(MAX_PAGE_WRITE_BYTES + 1) },
    413,
  ],
] as const)(
  "a change from %s is refused before its body is read",
  async (_, headers, status) => {
    const request = pageRequest(CHANGE, '{"postId":"1"}', headers);

    const refused = refuseUnlessOwnPage(request);

    expect(refused).toBeInstanceOf(Response);
    expect(refused?.status).toBe(status);
    expect(await refused?.json()).toEqual({ error: expect.any(String) });
    expect(
      [...(refused?.headers.keys() ?? [])].filter((name) =>
        name.startsWith("access-control-"),
      ),
    ).toEqual([]);
    expect(request.bodyUsed).toBe(false);
  },
);

test("neither door opens to what the other lets in", async () => {
  const fromExtension = await extensionRequest("/api/ingest", "{}");
  const fromPage = pageRequest("/api/ingest", "{}");

  expect(refuseUnlessOwnPage(fromExtension)?.status).toBe(403);
  expect(
    ((await refuseUnlessExtension(fromPage, TOKEN)) as Response).status,
  ).toBe(403);
});

/** A request whose body arrives in pieces and declares no length, and how much of it was taken. */
function inPieces(pieces: number, bytesEach: number) {
  let taken = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (taken === pieces) return controller.close();
      taken += 1;
      controller.enqueue(new Uint8Array(bytesEach).fill(0x20));
    },
  });
  const request = new Request("http://127.0.0.1:47130/api/owner/correct", {
    method: "POST",
    headers: pageRequest("/api/owner/correct", "{}").headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, taken: () => taken };
}

test("a body sent in pieces, with no length declared, is read no further than a change can be long", async () => {
  const kilobyte = 1024;
  const endless = inPieces(100_000, kilobyte);
  // The door reads headers, and this body declares nothing in them.
  expect(endless.request.headers.get("content-length")).toBeNull();
  expect(refuseUnlessOwnPage(endless.request)).toBeNull();

  expect(await readPageBody(endless.request)).toBeNull();

  // A hundred megabytes were on offer. What was taken is the limit and the
  // piece that passed it, with whatever the stream had drawn ahead.
  expect(endless.taken()).toBeLessThan(MAX_PAGE_WRITE_BYTES / kilobyte + 8);
  expect(tooLarge().status).toBe(413);
});

test("a body within the limit is read whole, in pieces or in one, and none is an empty one", async () => {
  const small = inPieces(3, 4);
  expect(await readPageBody(small.request)).toBe(" ".repeat(12));
  expect(small.taken()).toBe(3);
  expect(
    await readPageBody(pageRequest("/api/owner/correct", '{"postId":"ı"}')),
  ).toBe('{"postId":"ı"}');
  expect(
    await readPageBody(
      new Request("http://127.0.0.1:47130/api/owner/correct", {
        method: "POST",
      }),
    ),
  ).toBe("");
  // Exactly the limit is a change; one byte more is not.
  const exactly = pageRequest(
    "/api/owner/correct",
    "x".repeat(MAX_PAGE_WRITE_BYTES),
  );
  expect((await readPageBody(exactly))?.length).toBe(MAX_PAGE_WRITE_BYTES);
  const over = pageRequest(
    "/api/owner/correct",
    "x".repeat(MAX_PAGE_WRITE_BYTES + 1),
  );
  expect(await readPageBody(over)).toBeNull();
});
