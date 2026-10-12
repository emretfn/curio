import {
  APP_PORT,
  BODY_DIGEST_HEADER,
  EXTENSION_ORIGIN,
  NONCE_HEADER,
  PROOF_HEADER,
  proveResponse,
  requestSignatureIsValid,
  SIGNATURE_SCHEME,
  sha256Hex,
} from "@x-bookmarks/extension";

const LOCAL_HOSTS: readonly string[] = [
  `127.0.0.1:${APP_PORT}`,
  `localhost:${APP_PORT}`,
];

/**
 * Whether a request was addressed to this app by its own local name. A page
 * on another site that has re-pointed its domain at 127.0.0.1 (DNS rebinding)
 * still sends that domain in `Host`, and is turned away here.
 */
export function isLocalHost(host: string | null): boolean {
  return host !== null && LOCAL_HOSTS.includes(host.toLowerCase());
}

/** A request shown to come from the paired extension. */
export interface ExtensionRequest {
  nonce: string;
  /** The SHA-256 the extension signed for the body. Check the body against it. */
  bodyDigest: string;
}

function refusal(status: number, error: string): Response {
  // No Access-Control-Allow-* header is ever sent, so a web page can neither
  // read this answer nor get a preflight approved. No proof either: a caller
  // that has not shown the token is told nothing signed with it.
  return Response.json({ error }, { status });
}

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Refuses any request that is not from the paired extension. Returns the
 * refusal, or what the request proved when it may proceed. Call it before
 * reading the body: it needs only the headers.
 *
 * `Origin` is set by the browser and a page cannot forge it, so the origin
 * check alone keeps out every web page. The signature keeps out whatever can
 * forge headers but does not hold the pairing token, which is never sent.
 */
export async function refuseUnlessExtension(
  request: Request,
  token: string,
): Promise<ExtensionRequest | Response> {
  if (!isLocalHost(request.headers.get("host"))) {
    return refusal(403, "This app answers only on its local address.");
  }
  if (request.headers.get("origin") !== EXTENSION_ORIGIN) {
    return refusal(403, "Only the x-bookmarks extension may send captures.");
  }
  const [scheme, signature, ...extra] = (
    request.headers.get("authorization") ?? ""
  ).split(" ");
  const nonce = request.headers.get(NONCE_HEADER) ?? "";
  const bodyDigest = request.headers.get(BODY_DIGEST_HEADER) ?? "";
  const wellFormed =
    scheme === SIGNATURE_SCHEME &&
    signature !== undefined &&
    extra.length === 0 &&
    HEX_32.test(nonce) &&
    HEX_64.test(bodyDigest);
  if (
    !wellFormed ||
    !(await requestSignatureIsValid(
      token,
      {
        method: request.method,
        path: new URL(request.url).pathname,
        nonce,
        bodyDigest,
      },
      signature,
    ))
  ) {
    return refusal(401, "Not signed with this app's pairing token.");
  }
  return { nonce, bodyDigest };
}

/**
 * An answer to the paired extension, carrying proof that this app holds the
 * token. The extension believes no answer without it.
 */
export async function provenAnswer(
  token: string,
  { nonce }: ExtensionRequest,
  status: number,
  answer: unknown,
): Promise<Response> {
  const body = JSON.stringify(answer);
  const proof = await proveResponse(token, {
    nonce,
    status,
    bodyDigest: await sha256Hex(body),
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", [PROOF_HEADER]: proof },
  });
}
