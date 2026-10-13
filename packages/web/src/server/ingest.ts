import type { Store } from "@curio/core";
import {
  CAPTURE_SOURCE,
  type IngestAnswer,
  MAX_CAPTURE_BYTES,
  parseQueuedCapture,
  sha256Hex,
} from "@curio/extension";
import { insertRawCaptureOnce, parsePendingCaptures } from "./core.ts";
import { provenAnswer, refuseUnlessExtension } from "./guard.ts";

export interface IngestDependencies {
  store: Store;
  token: string;
  now?: () => number;
  /** Parses what has been stored. Replaced only by tests of what happens when it fails. */
  parse?: (store: Store) => unknown;
  /**
   * Called once a new capture is stored and parsed, with nothing to wait
   * for: the route uses it to have the new bookmarks tagged a little later.
   */
  afterStored?: () => void;
}

/** How far ahead of this machine's clock a capture time may be. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
/** Mirrors the database's check that a time is in milliseconds, not seconds. */
const EARLIEST_CAPTURE_MS = 1_000_000_000_000;

/**
 * Stores one capture from the extension, then parses it into bookmarks. The
 * payload is written exactly as it arrived, and a capture id that was stored
 * before is acknowledged without being stored again, so the extension can
 * safely re-send.
 *
 * Storing and parsing are separate steps, in that order, and the answer
 * depends on the first alone. A response the parser does not understand is
 * recorded as such beside its capture, and is parsed again by a re-parse
 * once the parser has been fixed.
 *
 * Tagging the new bookmarks is a third step that is not taken here at all:
 * `afterStored` asks for it, and it happens later, in `tagging.ts`.
 */
export async function handleIngest(
  request: Request,
  {
    store,
    token,
    now = Date.now,
    parse = parsePendingCaptures,
    afterStored,
  }: IngestDependencies,
): Promise<Response> {
  const proved = await refuseUnlessExtension(request, token);
  if (proved instanceof Response) return proved;
  const answer = (status: number, body: IngestAnswer | { error: string }) =>
    provenAnswer(token, proved, status, body);

  const type = request.headers.get("content-type") ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return answer(415, { error: "Send application/json." });
  }
  const tooLarge = () =>
    answer(413, {
      error: `A capture may be at most ${MAX_CAPTURE_BYTES} bytes.`,
    });
  if (Number(request.headers.get("content-length")) > MAX_CAPTURE_BYTES) {
    return tooLarge();
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_CAPTURE_BYTES) return tooLarge();
  if ((await sha256Hex(text)) !== proved.bodyDigest) {
    // Cut short or altered on the way; the signature covered another body.
    return answer(400, { error: "The body is not the one that was signed." });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { error: "The body is not JSON." });
  }
  const capture = parseQueuedCapture(body);
  if (capture === undefined) {
    return answer(422, {
      error: "The body is not a capture of an allowlisted operation.",
    });
  }
  if (
    capture.capturedAt <= EARLIEST_CAPTURE_MS ||
    capture.capturedAt > now() + CLOCK_TOLERANCE_MS
  ) {
    return answer(422, { error: "The capture time is not a plausible time." });
  }

  const { inserted } = insertRawCaptureOnce(store, {
    source: CAPTURE_SOURCE,
    operation: capture.operation,
    payload: capture.payload,
    requestUrl: capture.requestUrl,
    requestBody: capture.requestBody ?? undefined,
    receivedAt: new Date(capture.capturedAt),
    captureKey: capture.id,
  });
  // The capture is stored and committed; nothing below can undo that. Parsing
  // covers every capture not parsed yet, so one left behind by an earlier
  // failure here, or stored by an older version of the app, is picked up too.
  try {
    parse(store);
  } catch (error) {
    console.error(
      "A stored capture could not be parsed. It is kept, and `pnpm reparse` will parse it.",
      error,
    );
  }
  // Tagging is only ever asked for here, never done and never waited for:
  // it needs another host, which may be out of reach, and the answer to the
  // extension must not depend on that. Nor on this call itself.
  if (inserted) {
    try {
      afterStored?.();
    } catch (error) {
      console.error(
        `What follows a stored capture could not be started (${error instanceof Error ? error.name : "unknown error"}). The capture is stored and parsed.`,
      );
    }
  }
  return answer(inserted ? 201 : 200, {
    status: inserted ? "stored" : "duplicate",
    id: capture.id,
  });
}

/**
 * Answers the extension's pairing check. The proof on the answer is the
 * point: it shows the extension that this app holds the same token.
 */
export async function handlePairingCheck(
  request: Request,
  token: string,
): Promise<Response> {
  const proved = await refuseUnlessExtension(request, token);
  if (proved instanceof Response) return proved;
  return provenAnswer(token, proved, 200, { paired: true });
}

/**
 * Answers a CORS preflight with a refusal and no CORS headers. The extension
 * holds a host permission for this origin, so Chrome sends its requests
 * without a preflight; only a web page ever asks.
 */
export function refusePreflight(): Response {
  return Response.json(
    { error: "Cross-origin requests are not accepted." },
    { status: 403 },
  );
}
