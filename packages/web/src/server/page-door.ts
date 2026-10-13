/**
 * The page door: who may change the library from a browser.
 *
 * The app has two doors, and a route that accepts data stands behind exactly
 * one. `refuseUnlessExtension`, in `guard.ts`, lets in captures from the
 * paired extension. `refuseUnlessOwnPage`, here, lets in what the owner does
 * on the app's own screens: a correction, a change to the vocabulary.
 */
import { isLocalHost } from "./guard.ts";

function refusal(status: number, error: string): Response {
  // No Access-Control-Allow-* header is ever sent, so a page on another site
  // can neither read this answer nor get a preflight approved.
  return Response.json({ error }, { status });
}

/**
 * The most a page of this app may send in one write: a correction or a
 * change to the vocabulary is a few names. Anything larger is not one.
 */
export const MAX_PAGE_WRITE_BYTES = 16 * 1024;

/**
 * Refuses any request that a page of this app, open in a browser at the
 * app's own address, did not send. Returns the refusal, or null when the
 * request may proceed. Call it before reading the body: it needs only the
 * headers, and a refused request's body is never read.
 *
 * Nothing passes both doors, and a route that accepts data calls exactly
 * one of them.
 *
 * Every check is of a header the browser writes and page script cannot:
 *
 * - `Host` is the app's own address. A site that has re-pointed its domain
 *   at 127.0.0.1 (DNS rebinding) is one origin with the app as far as the
 *   browser can tell, and still sends its own name here.
 * - `Origin` is that same address. A page on any other site, an extension's
 *   page and a sandboxed frame each send their own, or `null`.
 * - `Sec-Fetch-Site` is `same-origin`: the browser's own word that the page
 *   and the app are one origin. A browser too old to say so is refused.
 * - `Content-Type` is `application/json`, which no form and no "simple"
 *   request can carry, so a page elsewhere would first have to ask this app
 *   for leave (a preflight), and no route here ever grants it.
 *
 * What it does not keep out is said in the web README: a program on this
 * computer writes its own headers, and can already read every page.
 */
export function refuseUnlessOwnPage(request: Request): Response | null {
  const host = request.headers.get("host");
  if (host === null || !isLocalHost(host)) {
    return refusal(403, "This app answers only on its local address.");
  }
  if (request.headers.get("origin") !== `http://${host.toLowerCase()}`) {
    return refusal(403, "Only this app's own pages may change the library.");
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return refusal(
      403,
      "Only this app's own pages may change the library, and this browser did not say the request came from one.",
    );
  }
  const type = request.headers.get("content-type") ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return refusal(415, "Send application/json.");
  }
  if (Number(request.headers.get("content-length")) > MAX_PAGE_WRITE_BYTES) {
    return tooLarge();
  }
  return null;
}

/** The refusal of a change longer than a change can be. */
export function tooLarge(): Response {
  return refusal(413, `A change may be at most ${MAX_PAGE_WRITE_BYTES} bytes.`);
}

/**
 * The body of a request the door has let through, or null when it is longer
 * than a change can be. It is read as it arrives and no further than
 * `MAX_PAGE_WRITE_BYTES`: a body sent in pieces declares no length for the
 * door to refuse, and must not be taken into memory whole to be measured.
 */
export async function readPageBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_PAGE_WRITE_BYTES) {
      // The rest is not wanted, and is not waited for.
      await reader.cancel().catch(() => {});
      return null;
    }
    pieces.push(value);
  }
  return Buffer.concat(pieces).toString("utf8");
}
