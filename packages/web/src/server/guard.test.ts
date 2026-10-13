import {
  PROOF_HEADER,
  responseProofIsValid,
  sha256Hex,
} from "@curio/extension";
import { expect, test } from "vitest";
import {
  appPort,
  isLocalHost,
  provenAnswer,
  refuseUnlessExtension,
} from "./guard.ts";
import { extensionRequest, NONCE, TOKEN } from "./testing.ts";

const OTHER_TOKEN = "Zq3vX2mB8sYt0aLr5nWc7dHf1gJz4pQe9uTi6oVbNxM";

test.each(["127.0.0.1:47130", "localhost:47130", "LOCALHOST:47130"])(
  "%s is this app's own address",
  (host) => {
    expect(isLocalHost(host)).toBe(true);
  },
);

test.each([
  ["a rebound domain", "evil.example:47130"],
  ["a domain that starts like localhost", "localhost.evil.example:47130"],
  ["another port", "127.0.0.1:3000"],
  ["no port", "127.0.0.1"],
  ["the LAN address", "192.168.1.20:47130"],
  ["the any-address", "0.0.0.0:47130"],
  ["a missing header", null],
])("%s is not", (_, host) => {
  expect(isLocalHost(host)).toBe(false);
});

test("an app started on another port answers at that address and no longer at the extension's", () => {
  const demo = { CURIO_PORT: "47131" };

  expect(appPort(demo)).toBe(47131);
  expect(isLocalHost("127.0.0.1:47131", demo)).toBe(true);
  expect(isLocalHost("localhost:47131", demo)).toBe(true);
  expect(isLocalHost("127.0.0.1:47130", demo)).toBe(false);
  // A rebound domain is still another name, whatever the port.
  expect(isLocalHost("evil.example:47131", demo)).toBe(false);
});

test.each([
  ["nothing", undefined],
  ["an empty value", ""],
  ["a word", "demo"],
  ["a port only root may hold", "80"],
  ["a number that is no port", "70000"],
  ["a number with something after it", "47131 "],
  ["a number written another way", "0x1f"],
  ["a host and a port", "evil.example:47131"],
])(
  "a port given as %s is ignored, and the app answers to its own alone",
  (_, value) => {
    const environment = { CURIO_PORT: value };

    expect(appPort(environment)).toBe(47130);
    expect(isLocalHost("127.0.0.1:47130", environment)).toBe(true);
    expect(isLocalHost(`127.0.0.1:${value}`, environment)).toBe(false);
  },
);

test("the paired extension's request may proceed, and yields what it signed", async () => {
  const request = await extensionRequest("/api/ingest", '{"a":1}');

  expect(await refuseUnlessExtension(request, TOKEN)).toEqual({
    nonce: NONCE,
    bodyDigest: await sha256Hex('{"a":1}'),
  });
  expect(request.bodyUsed).toBe(false);
});

test.each([
  ["no Origin, as from a script outside a browser", { origin: null }, 403],
  ["a web page", { origin: "https://evil.example" }, 403],
  ["a page on x.com", { origin: "https://x.com" }, 403],
  ["a sandboxed page", { origin: "null" }, 403],
  ["the app's own pages", { origin: "http://127.0.0.1:47130" }, 403],
  [
    "another extension",
    { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    403,
  ],
  ["a rebound domain", { host: "evil.example:47130" }, 403],
  ["no signature", { authorization: null }, 401],
  ["the token itself as a bearer", { authorization: `Bearer ${TOKEN}` }, 401],
  [
    "the token itself under the signature scheme",
    { authorization: `CURIO1-HMAC-SHA256 ${TOKEN}` },
    401,
  ],
  [
    "a signature that is not one",
    { authorization: `CURIO1-HMAC-SHA256 ${"0".repeat(64)}` },
    401,
  ],
  ["no nonce", { "x-curio-nonce": null }, 401],
  [
    "a nonce other than the signed one",
    { "x-curio-nonce": "f".repeat(32) },
    401,
  ],
  ["no body digest", { "x-curio-body-sha256": null }, 401],
  [
    "a body digest other than the signed one",
    { "x-curio-body-sha256": "0".repeat(64) },
    401,
  ],
] as const)(
  "a request with %s is refused, with no proof attached",
  async (_, headers, status) => {
    const request = await extensionRequest("/api/ingest", "{}", headers);

    const refused = await refuseUnlessExtension(request, TOKEN);

    expect(refused).toBeInstanceOf(Response);
    const response = refused as Response;
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get(PROOF_HEADER)).toBeNull();
    expect(request.bodyUsed).toBe(false);
  },
);

test("a request signed with another token, for another path, or with another method is refused", async () => {
  const otherToken = await extensionRequest(
    "/api/ingest",
    "{}",
    {},
    OTHER_TOKEN,
  );
  const signedForPairing = await extensionRequest("/api/pairing", "{}");
  const replayedElsewhere = new Request("http://127.0.0.1:47130/api/ingest", {
    method: "POST",
    headers: signedForPairing.headers,
    body: "{}",
  });
  const otherMethod = new Request("http://127.0.0.1:47130/api/pairing", {
    method: "PUT",
    headers: signedForPairing.headers,
    body: "{}",
  });

  for (const request of [otherToken, replayedElsewhere, otherMethod]) {
    const refused = await refuseUnlessExtension(request, TOKEN);
    expect((refused as Response).status).toBe(401);
  }
});

test("an answer to the extension carries a proof only the token's holder could make", async () => {
  const request = await extensionRequest("/api/pairing", "{}");
  const proved = await refuseUnlessExtension(request, TOKEN);
  if (proved instanceof Response) throw new Error("expected to be let in");

  const response = await provenAnswer(TOKEN, proved, 200, { paired: true });

  const proof = response.headers.get(PROOF_HEADER) ?? "";
  const text = await response.text();
  expect(text).toBe('{"paired":true}');
  const answered = {
    nonce: NONCE,
    status: 200,
    bodyDigest: await sha256Hex(text),
  };
  expect(await responseProofIsValid(TOKEN, answered, proof)).toBe(true);
  expect(await responseProofIsValid(OTHER_TOKEN, answered, proof)).toBe(false);
  expect(
    await responseProofIsValid(TOKEN, { ...answered, status: 201 }, proof),
  ).toBe(false);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});
