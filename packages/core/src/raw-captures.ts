import { connectionOf, type Store } from "./store.ts";

/** The capture routes. A new route is added here first. */
export const CAPTURE_SOURCES = ["x-web-client", "x-api-v2"] as const;

/**
 * `x-web-client`: a response X's own web client received, forwarded by the
 * browser extension. `x-api-v2`: a response from the official X API.
 */
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export interface NewRawCapture {
  source: CaptureSource;
  /**
   * What was asked within that source, as the source names it: the GraphQL
   * operation (`Bookmarks`) or the API route (`GET /2/users/:id/bookmarks`).
   */
  operation: string;
  /**
   * The response body exactly as received. Pass the original text: parsing and
   * re-serialising it loses the precision of large integers.
   */
  payload: string;
  /** URL of the request that produced the response, when the capturer has it. */
  requestUrl?: string | undefined;
  /**
   * When the response was received. Defaults to now. Pass it only when storing
   * a capture later than it was taken, such as draining a queue.
   */
  receivedAt?: Date | undefined;
}

export interface RawCapture {
  id: number;
  source: CaptureSource;
  operation: string;
  payload: string;
  requestUrl: string | null;
  receivedAt: Date;
}

interface RawCaptureRow {
  id: number;
  source: CaptureSource;
  operation: string;
  payload: string;
  requestUrl: string | null;
  receivedAt: number;
}

/** Stores a response verbatim. The stored row can never be changed or removed. */
export function insertRawCapture(
  store: Store,
  capture: NewRawCapture,
): RawCapture {
  if (!CAPTURE_SOURCES.includes(capture.source)) {
    throw new TypeError(
      `Unknown capture source "${capture.source}". Known sources: ${CAPTURE_SOURCES.join(", ")}.`,
    );
  }
  const receivedAt = capture.receivedAt ?? new Date();
  const { lastInsertRowid } = connectionOf(store)
    .prepare(
      `INSERT INTO raw_captures (source, operation, request_url, payload, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      capture.source,
      capture.operation,
      capture.requestUrl ?? null,
      capture.payload,
      receivedAt.getTime(),
    );
  return {
    id: Number(lastInsertRowid),
    source: capture.source,
    operation: capture.operation,
    payload: capture.payload,
    requestUrl: capture.requestUrl ?? null,
    receivedAt,
  };
}

export function getRawCapture(
  store: Store,
  id: number,
): RawCapture | undefined {
  const row = connectionOf(store)
    .prepare<[number], RawCaptureRow>(
      `SELECT id, source, operation, payload,
              request_url AS requestUrl, received_at AS receivedAt
       FROM raw_captures WHERE id = ?`,
    )
    .get(id);
  return row && { ...row, receivedAt: new Date(row.receivedAt) };
}
