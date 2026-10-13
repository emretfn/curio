/**
 * How the extension and the app prove to each other that they hold the same
 * pairing token, without the token ever being sent.
 *
 * The extension signs each request with the token (HMAC-SHA-256), and the app
 * signs its answer, tied to the request's nonce. Whatever answers on the
 * app's port without the token can do neither, so it learns no secret and
 * cannot pass for the app. Uses Web Crypto, which the service worker and Node
 * both have.
 */

export const SIGNATURE_SCHEME = "CURIO1-HMAC-SHA256";
/** A fresh random value per request, which the app's proof must cover. */
export const NONCE_HEADER = "x-curio-nonce";
/** SHA-256 of the request body, so the signature can be checked before the body is read. */
export const BODY_DIGEST_HEADER = "x-curio-body-sha256";
/** The app's signature over its answer. */
export const PROOF_HEADER = "x-curio-proof";

export interface SignedRequest {
  method: string;
  path: string;
  nonce: string;
  /** `sha256Hex` of the body. */
  bodyDigest: string;
}

export interface ProvenResponse {
  /** The nonce of the request being answered. */
  nonce: string;
  status: number;
  /** `sha256Hex` of the response body. */
  bodyDigest: string;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^([0-9a-f]{2})+$/.test(hex)) return undefined;
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** A value no earlier request has used. */
export function newNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

function hmacKey(token: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(token: string, lines: string[]): Promise<string> {
  return toHex(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(token),
      encoder.encode(lines.join("\n")),
    ),
  );
}

/** Compares in constant time, inside Web Crypto. */
async function verify(
  token: string,
  lines: string[],
  signature: string,
): Promise<boolean> {
  const bytes = fromHex(signature);
  if (bytes === undefined) return false;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(token),
    bytes,
    encoder.encode(lines.join("\n")),
  );
}

// The first line keeps a request signature from ever being valid as a proof.
const requestLines = (request: SignedRequest) => [
  "request",
  request.method,
  request.path,
  request.nonce,
  request.bodyDigest,
];
const responseLines = (response: ProvenResponse) => [
  "response",
  response.nonce,
  String(response.status),
  response.bodyDigest,
];

export function signRequest(
  token: string,
  request: SignedRequest,
): Promise<string> {
  return sign(token, requestLines(request));
}

export function requestSignatureIsValid(
  token: string,
  request: SignedRequest,
  signature: string,
): Promise<boolean> {
  return verify(token, requestLines(request), signature);
}

export function proveResponse(
  token: string,
  response: ProvenResponse,
): Promise<string> {
  return sign(token, responseLines(response));
}

export function responseProofIsValid(
  token: string,
  response: ProvenResponse,
  proof: string,
): Promise<boolean> {
  return verify(token, responseLines(response), proof);
}
