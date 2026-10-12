import { expect, test } from "vitest";
import {
  newNonce,
  proveResponse,
  requestSignatureIsValid,
  responseProofIsValid,
  sha256Hex,
  signRequest,
} from "./auth.ts";

const token = "kq3vX2mB8sYt0aLr5nWc7dHf1gJz4pQe9uTi6oVbNxM";
const otherToken = "Zq3vX2mB8sYt0aLr5nWc7dHf1gJz4pQe9uTi6oVbNxM";

test("sha256Hex is SHA-256 of the UTF-8 text, in lowercase hex", async () => {
  expect(await sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(await sha256Hex("café \u{1F516}")).toBe(
    "1c988fd742f80e9e4adbcc2c8fa47b817a1e7a51452e1507176bf5a336f84803",
  );
});

test("a nonce is 16 random bytes in hex, new every time", () => {
  const nonces = new Set(Array.from({ length: 100 }, newNonce));

  expect(nonces.size).toBe(100);
  for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/);
});

test("a request signature is valid for exactly the request and token it was made with", async () => {
  const request = {
    method: "POST",
    path: "/api/ingest",
    nonce: newNonce(),
    bodyDigest: await sha256Hex('{"id":"1"}'),
  };
  const signature = await signRequest(token, request);
  const valid = (changed: Partial<typeof request>, withToken = token) =>
    requestSignatureIsValid(withToken, { ...request, ...changed }, signature);

  expect(signature).toMatch(/^[0-9a-f]{64}$/);
  expect(await valid({})).toBe(true);
  expect(await valid({}, otherToken)).toBe(false);
  expect(await valid({ method: "GET" })).toBe(false);
  expect(await valid({ path: "/api/pairing" })).toBe(false);
  expect(await valid({ nonce: newNonce() })).toBe(false);
  expect(await valid({ bodyDigest: await sha256Hex('{"id":"2"}') })).toBe(
    false,
  );
});

test("a response proof is valid for exactly the answer, nonce and token it was made with", async () => {
  const response = {
    nonce: newNonce(),
    status: 201,
    bodyDigest: await sha256Hex('{"status":"stored"}'),
  };
  const proof = await proveResponse(token, response);
  const valid = (changed: Partial<typeof response>, withToken = token) =>
    responseProofIsValid(withToken, { ...response, ...changed }, proof);

  expect(await valid({})).toBe(true);
  expect(await valid({}, otherToken)).toBe(false);
  expect(await valid({ nonce: newNonce() })).toBe(false);
  expect(await valid({ status: 200 })).toBe(false);
  expect(await valid({ bodyDigest: await sha256Hex("{}") })).toBe(false);
});

test("a request signature does not pass as a response proof", async () => {
  const nonce = newNonce();
  const bodyDigest = await sha256Hex("{}");
  const signature = await signRequest(token, {
    method: "POST",
    path: "/api/pairing",
    nonce,
    bodyDigest,
  });

  expect(
    await responseProofIsValid(
      token,
      { nonce, status: 200, bodyDigest },
      signature,
    ),
  ).toBe(false);
});

test.each(["", "not hex", "abc", "ZZ"])(
  "a malformed signature (%j) is invalid, not an error",
  async (signature) => {
    expect(
      await requestSignatureIsValid(
        token,
        { method: "POST", path: "/", nonce: "", bodyDigest: "" },
        signature,
      ),
    ).toBe(false);
  },
);
