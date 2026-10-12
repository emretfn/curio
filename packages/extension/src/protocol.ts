/**
 * The contract between the extension and the local app: which responses are
 * captured, where they are sent, what a capture looks like on the wire, and
 * how each end proves itself to the other. This is the package's only export,
 * and it runs in the extension and in Node, so it uses nothing but the
 * language and Web Crypto.
 */

import {
  type CapturedOperation,
  capturedOperationOf,
  isCapturedOperation,
} from "./operations.ts";

export {
  BODY_DIGEST_HEADER,
  NONCE_HEADER,
  newNonce,
  PROOF_HEADER,
  proveResponse,
  requestSignatureIsValid,
  responseProofIsValid,
  SIGNATURE_SCHEME,
  sha256Hex,
  signRequest,
} from "./auth.ts";
export {
  CAPTURED_OPERATIONS,
  type CapturedOperation,
  capturedOperationOf,
  isCapturedOperation,
} from "./operations.ts";

/**
 * The extension's id. It is fixed by the `key` in manifest.json, so it is the
 * same wherever the unpacked extension is loaded from, and the app can accept
 * this one origin and no other.
 */
export const EXTENSION_ID = "imbpimaegfnjdhdcfefapkaejieaahjh";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/**
 * Where the local app listens. The port is fixed because the extension's only
 * host permission names it.
 */
export const APP_HOST = "127.0.0.1";
export const APP_PORT = 47130;
export const APP_ORIGIN = `http://${APP_HOST}:${APP_PORT}`;
export const INGEST_PATH = "/api/ingest";
export const PAIRING_PATH = "/api/pairing";

/** The capture source this route writes, as `@x-bookmarks/core` names it. */
export const CAPTURE_SOURCE = "x-web-client";

/** Larger than any timeline page; a body above it is refused, not truncated. */
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/**
 * One response as the page hook saw it. Nothing in it is parsed or altered.
 * It carries no time on purpose: page scripts can forge this, and the time a
 * capture was taken becomes a bookmark's first-seen time.
 */
export interface SeenResponse {
  operation: CapturedOperation;
  /** The full URL the page requested, including its query string. */
  requestUrl: string;
  /** The request body as the page sent it, when it was text. */
  requestBody: string | null;
  /** The response text exactly as the page received it. */
  payload: string;
}

/** A seen response once the service worker has taken it in. */
export interface Capture extends SeenResponse {
  /**
   * When the service worker received it, in Unix epoch milliseconds, by the
   * service worker's own clock. Nothing a page sends can set it.
   */
  capturedAt: number;
}

/** A capture with the id the extension gives it when it is queued. */
export interface QueuedCapture extends Capture {
  /** Unique per capture. The app stores a given id once however often it arrives. */
  id: string;
}

/**
 * An allowlisted request the hook could not turn into a capture, so that a
 * failure is visible instead of silent. It carries no part of the response.
 */
export interface CaptureProblem {
  operation: CapturedOperation;
  detail: string;
}

export type HookEvent =
  | { kind: "capture"; capture: SeenResponse }
  | { kind: "problem"; problem: CaptureProblem };

/** What the app answers to a capture it has stored, now or on an earlier delivery. */
export interface IngestAnswer {
  status: "stored" | "duplicate";
  /** The id of the capture this answers, echoed from the request. */
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks an untrusted value against `SeenResponse`, without changing any of
 * it. Anything else the value carries, a time included, is dropped.
 */
export function parseSeenResponse(value: unknown): SeenResponse | undefined {
  if (!isRecord(value)) return undefined;
  const { operation, requestUrl, requestBody, payload } = value;
  if (!isCapturedOperation(operation)) return undefined;
  if (typeof requestUrl !== "string") return undefined;
  if (capturedOperationOf(requestUrl) !== operation) return undefined;
  if (requestBody !== null && typeof requestBody !== "string") return undefined;
  if (typeof payload !== "string" || payload.length === 0) return undefined;
  return { operation, requestUrl, requestBody, payload };
}

const CAPTURE_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Checks an untrusted value against `QueuedCapture`. */
export function parseQueuedCapture(value: unknown): QueuedCapture | undefined {
  const seen = parseSeenResponse(value);
  if (seen === undefined || !isRecord(value)) return undefined;
  const { id, capturedAt } = value;
  if (typeof id !== "string" || !CAPTURE_ID.test(id)) return undefined;
  if (typeof capturedAt !== "number" || !Number.isSafeInteger(capturedAt)) {
    return undefined;
  }
  return { id, ...seen, capturedAt };
}

/** Checks an untrusted value against `IngestAnswer`. */
export function parseIngestAnswer(value: unknown): IngestAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const { status, id } = value;
  if (status !== "stored" && status !== "duplicate") return undefined;
  if (typeof id !== "string") return undefined;
  return { status, id };
}

/** Checks an untrusted value against `HookEvent`. */
export function parseHookEvent(value: unknown): HookEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "capture") {
    const capture = parseSeenResponse(value.capture);
    return capture && { kind: "capture", capture };
  }
  if (value.kind === "problem" && isRecord(value.problem)) {
    const { operation, detail } = value.problem;
    if (!isCapturedOperation(operation) || typeof detail !== "string") {
      return undefined;
    }
    return {
      kind: "problem",
      problem: { operation, detail: detail.slice(0, 200) },
    };
  }
  return undefined;
}
