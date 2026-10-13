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

/** The variable that names the port an app on another library was started on. */
export const PORT_VARIABLE = "X_BOOKMARKS_PORT";

/**
 * The port this app answers on: `APP_PORT`, the one the extension is
 * permitted to reach, unless whoever started this process said it listens
 * on another. `pnpm demo` does, for the app it starts on a library of
 * invented posts, so that the demo and the real app can run side by side.
 *
 * It is read from the environment of the process, which only the person
 * starting the app writes, and it must be a port a user's program may
 * hold. Anything else is ignored, and the app then answers to `APP_PORT`
 * alone: started on another port with a value that is not one, it refuses
 * every request instead of guessing.
 */
export function appPort(
  environment: Record<string, string | undefined> = process.env,
): number {
  const configured = environment[PORT_VARIABLE];
  if (configured === undefined || !/^[1-9][0-9]{3,4}$/.test(configured)) {
    return APP_PORT;
  }
  const port = Number(configured);
  return port >= 1024 && port <= 65535 ? port : APP_PORT;
}

/**
 * Whether a request was addressed to this app by its own local name. A page
 * on another site that has re-pointed its domain at 127.0.0.1 (DNS rebinding)
 * still sends that domain in `Host`, and is turned away here.
 */
export function isLocalHost(
  host: string | null,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (host === null) return false;
  const port = appPort(environment);
  const asked = host.toLowerCase();
  return asked === `127.0.0.1:${port}` || asked === `localhost:${port}`;
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
