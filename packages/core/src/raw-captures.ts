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
   * Body of the request that produced the response, exactly as sent, when the
   * capturer has it. A mutation names the post it acts on only here.
   */
  requestBody?: string | undefined;
  /**
   * When the response was received. Defaults to now. Pass it only when storing
   * a capture later than it was taken, such as draining a queue.
   */
  receivedAt?: Date | undefined;
}

/** A capture that carries an id from its capturer, for `insertRawCaptureOnce`. */
export interface KeyedRawCapture extends NewRawCapture {
  /**
   * An id the capturer gave this capture before sending it, unique within the
   * source. Delivering the same key again stores nothing.
   */
  captureKey: string;
}

export interface RawCapture {
  id: number;
  source: CaptureSource;
  operation: string;
  payload: string;
  requestUrl: string | null;
  requestBody: string | null;
  /** Null for a capture stored with `insertRawCapture`. */
  captureKey: string | null;
  receivedAt: Date;
}

export interface RawCaptureSummary {
  count: number;
  /** The latest `receivedAt` among stored captures, or null when there are none. */
  lastReceivedAt: Date | null;
}

interface RawCaptureRow {
  id: number;
  source: CaptureSource;
  operation: string;
  payload: string;
  requestUrl: string | null;
  requestBody: string | null;
  captureKey: string | null;
  receivedAt: number;
}

const SELECT_RAW_CAPTURE = `
  SELECT id, source, operation, payload,
         request_url AS requestUrl, request_body AS requestBody,
         capture_key AS captureKey, received_at AS receivedAt
  FROM raw_captures`;

function fromRow(row: RawCaptureRow): RawCapture {
  return { ...row, receivedAt: new Date(row.receivedAt) };
}

function assertKnownSource(source: string): void {
  if (!(CAPTURE_SOURCES as readonly string[]).includes(source)) {
    throw new TypeError(
      `Unknown capture source "${source}". Known sources: ${CAPTURE_SOURCES.join(", ")}.`,
    );
  }
}

/** Stores a response verbatim. The stored row can never be changed or removed. */
export function insertRawCapture(
  store: Store,
  capture: NewRawCapture,
): RawCapture {
  assertKnownSource(capture.source);
  const receivedAt = capture.receivedAt ?? new Date();
  const { lastInsertRowid } = connectionOf(store)
    .prepare(
      `INSERT INTO raw_captures (source, operation, request_url, request_body, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      capture.source,
      capture.operation,
      capture.requestUrl ?? null,
      capture.requestBody ?? null,
      capture.payload,
      receivedAt.getTime(),
    );
  return {
    id: Number(lastInsertRowid),
    source: capture.source,
    operation: capture.operation,
    payload: capture.payload,
    requestUrl: capture.requestUrl ?? null,
    requestBody: capture.requestBody ?? null,
    captureKey: null,
    receivedAt,
  };
}

/**
 * Stores a response verbatim unless a capture with the same source and
 * `captureKey` is already stored. Use it where a capture can be delivered more
 * than once, such as a queue that retries.
 *
 * Returns the stored capture and whether this call stored it. On a repeat the
 * first delivery stands and nothing of the second is kept, even when it
 * differs: stored captures are never changed.
 */
export function insertRawCaptureOnce(
  store: Store,
  capture: KeyedRawCapture,
): { capture: RawCapture; inserted: boolean } {
  assertKnownSource(capture.source);
  const db = connectionOf(store);
  const insertOnce = db.transaction(() => {
    const { changes } = db
      .prepare(
        `INSERT INTO raw_captures (
           source, operation, request_url, request_body, payload, received_at, capture_key
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, capture_key) WHERE capture_key IS NOT NULL DO NOTHING`,
      )
      .run(
        capture.source,
        capture.operation,
        capture.requestUrl ?? null,
        capture.requestBody ?? null,
        capture.payload,
        (capture.receivedAt ?? new Date()).getTime(),
        capture.captureKey,
      );
    const row = db
      .prepare<[string, string], RawCaptureRow>(
        `${SELECT_RAW_CAPTURE} WHERE source = ? AND capture_key = ?`,
      )
      .get(capture.source, capture.captureKey);
    if (row === undefined) {
      throw new Error(
        `Raw capture with key "${capture.captureKey}" is missing after insert.`,
      );
    }
    return { capture: fromRow(row), inserted: changes === 1 };
  });
  return insertOnce.immediate();
}

export function getRawCapture(
  store: Store,
  id: number,
): RawCapture | undefined {
  const row = connectionOf(store)
    .prepare<[number], RawCaptureRow>(`${SELECT_RAW_CAPTURE} WHERE id = ?`)
    .get(id);
  return row && fromRow(row);
}

/**
 * The id of every stored capture, oldest received first. This is the order
 * captures are replayed in for a re-parse, so that each bookmark's first-seen
 * time comes from the earliest capture that holds it.
 */
export function listRawCaptureIds(store: Store): number[] {
  return connectionOf(store)
    .prepare<[], number>("SELECT id FROM raw_captures ORDER BY received_at, id")
    .pluck()
    .all() as number[];
}

/** How many captures are stored, from one source or from all, and the latest. */
export function summariseRawCaptures(
  store: Store,
  source?: CaptureSource,
): RawCaptureSummary {
  const row = connectionOf(store)
    .prepare<
      { source: CaptureSource | null },
      { count: number; lastReceivedAt: number | null }
    >(
      `SELECT count(*) AS count, max(received_at) AS lastReceivedAt
       FROM raw_captures
       WHERE @source IS NULL OR source = @source`,
    )
    .get({ source: source ?? null });
  if (row === undefined) {
    throw new Error("An aggregate query returned no row.");
  }
  return {
    count: row.count,
    lastReceivedAt:
      row.lastReceivedAt === null ? null : new Date(row.lastReceivedAt),
  };
}
