import { expect, test } from "vitest";
import { refuseUnlessExtension } from "./guard.ts";
import { MAX_PAGE_WRITE_BYTES, refuseUnlessOwnPage } from "./page-door.ts";
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
