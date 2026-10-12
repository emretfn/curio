import {
  APP_ORIGIN,
  BODY_DIGEST_HEADER,
  EXTENSION_ORIGIN,
  NONCE_HEADER,
  SIGNATURE_SCHEME,
  sha256Hex,
  signRequest,
} from "@x-bookmarks/extension";

export const TOKEN = "kq3vX2mB8sYt0aLr5nWc7dHf1gJz4pQe9uTi6oVbNxM";
export const NONCE = "000102030405060708090a0b0c0d0e0f";

/**
 * A request as the paired extension sends it, signed with `token`. `headers`
 * replace or, when null, remove what the extension would send, after signing.
 */
export async function extensionRequest(
  path: string,
  body: string,
  headers: Record<string, string | null> = {},
  token: string = TOKEN,
): Promise<Request> {
  const bodyDigest = await sha256Hex(body);
  const signature = await signRequest(token, {
    method: "POST",
    path,
    nonce: NONCE,
    bodyDigest,
  });
  const merged = new Headers({
    host: new URL(APP_ORIGIN).host,
    origin: EXTENSION_ORIGIN,
    authorization: `${SIGNATURE_SCHEME} ${signature}`,
    [NONCE_HEADER]: NONCE,
    [BODY_DIGEST_HEADER]: bodyDigest,
    "content-type": "application/json",
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: merged,
    body,
  });
}
