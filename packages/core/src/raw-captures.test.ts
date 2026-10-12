import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { applyMigrations } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import {
  getRawCapture,
  insertRawCapture,
  insertRawCaptureOnce,
  listRawCaptureIds,
  summariseRawCaptures,
} from "./raw-captures.ts";
import { connectionOf } from "./store.ts";
import { openTempStore, tempDatabasePath } from "./testing/temp-database.ts";

// Odd spacing, an integer beyond Number.MAX_SAFE_INTEGER, escapes, and
// non-ASCII text: everything a JSON round-trip would normalise or corrupt.
const payload =
  '{ "sortIndex":1861899614026727424,\n\t"text" : "caf\\u00e9 \u{1F516} ünïcode" , "n": 1.0 }\n';

// A request body with the same hazards: a post id beyond 2^53 and odd spacing.
const requestBody =
  '{"variables":{ "tweet_id":"1861899614026727424" },"queryId":"abc"}';

test("a raw capture round-trips byte for byte, across a reopen", () => {
  const path = tempDatabasePath();
  const receivedAt = new Date("2026-10-12T08:30:00.123Z");
  const writer = openTempStore(path);

  const inserted = insertRawCapture(writer, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%7D",
    requestBody,
    receivedAt,
  });
  writer.close();

  const stored = getRawCapture(openTempStore(path), inserted.id);
  expect(stored).toEqual({
    id: inserted.id,
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%7D",
    requestBody,
    captureKey: null,
    receivedAt,
  });
  expect(stored).toEqual(inserted);
});

test("receivedAt defaults to now, and requestUrl and requestBody to null", () => {
  const store = openTempStore();
  const before = Date.now();

  const { id } = insertRawCapture(store, {
    source: "x-api-v2",
    operation: "GET /2/users/:id/bookmarks",
    payload,
  });

  const stored = getRawCapture(store, id);
  expect(stored?.requestUrl).toBeNull();
  expect(stored?.requestBody).toBeNull();
  expect(stored?.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(stored?.receivedAt.getTime()).toBeLessThanOrEqual(Date.now());
});

test("identical payloads are stored as separate captures", () => {
  const store = openTempStore();
  const capture = {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
  } as const;

  const first = insertRawCapture(store, capture);
  const second = insertRawCapture(store, capture);

  expect(second.id).not.toBe(first.id);
});

test("an unknown id reads as undefined", () => {
  expect(getRawCapture(openTempStore(), 1)).toBeUndefined();
});

test("an unknown source, an empty operation, and an empty payload are rejected", () => {
  const store = openTempStore();
  const valid = {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
  } as const;

  expect(() =>
    // @ts-expect-error: not a CaptureSource
    insertRawCapture(store, { ...valid, source: "somewhere-else" }),
  ).toThrow(/Unknown capture source/);
  expect(() => insertRawCapture(store, { ...valid, operation: "" })).toThrow(
    /CHECK constraint failed/,
  );
  expect(() => insertRawCapture(store, { ...valid, payload: "" })).toThrow(
    /CHECK constraint failed/,
  );
});

test("the database refuses to update or delete a stored capture", () => {
  const store = openTempStore();
  const { id } = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
  });
  const db = connectionOf(store);

  expect(() =>
    db.prepare("UPDATE raw_captures SET payload = '{}' WHERE id = ?").run(id),
  ).toThrow(/never updated/);
  expect(() =>
    db.prepare("DELETE FROM raw_captures WHERE id = ?").run(id),
  ).toThrow(/never deleted/);
  expect(getRawCapture(store, id)?.payload).toBe(payload);
});

test("a keyed capture is stored once however often it is delivered", () => {
  const path = tempDatabasePath();
  const store = openTempStore(path);
  const capture = {
    source: "x-web-client",
    operation: "CreateBookmark",
    payload,
    requestUrl: "https://x.com/i/api/graphql/abc/CreateBookmark",
    requestBody,
    receivedAt: new Date("2026-10-12T08:30:00.123Z"),
    captureKey: "0b9d6f4e-6a55-4c0e-9a51-0d6f8b1c2e3f",
  } as const;

  const first = insertRawCaptureOnce(store, capture);
  const second = insertRawCaptureOnce(store, capture);
  store.close();
  const third = insertRawCaptureOnce(openTempStore(path), capture);

  expect(first.inserted).toBe(true);
  expect(first.capture).toEqual({ id: first.capture.id, ...capture });
  expect(second).toEqual({ capture: first.capture, inserted: false });
  expect(third).toEqual({ capture: first.capture, inserted: false });
  expect(summariseRawCaptures(openTempStore(path)).count).toBe(1);
});

test("a repeated key keeps the first delivery even when the second differs", () => {
  const store = openTempStore();
  const capture = {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    captureKey: "key-1",
  } as const;

  const first = insertRawCaptureOnce(store, capture);
  const second = insertRawCaptureOnce(store, {
    ...capture,
    payload: '{"different":true}',
  });

  expect(second.inserted).toBe(false);
  expect(second.capture).toEqual(first.capture);
  expect(getRawCapture(store, first.capture.id)?.payload).toBe(payload);
});

test("a capture key is scoped to its source, and different keys are different captures", () => {
  const store = openTempStore();
  const capture = {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    captureKey: "key-1",
  } as const;

  insertRawCaptureOnce(store, capture);
  const otherKey = insertRawCaptureOnce(store, {
    ...capture,
    captureKey: "key-2",
  });
  const otherSource = insertRawCaptureOnce(store, {
    ...capture,
    source: "x-api-v2",
  });

  expect(otherKey.inserted).toBe(true);
  expect(otherSource.inserted).toBe(true);
  expect(summariseRawCaptures(store).count).toBe(3);
});

test("an empty capture key and an unknown source are rejected", () => {
  const store = openTempStore();
  const valid = {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    captureKey: "key-1",
  } as const;

  expect(() =>
    insertRawCaptureOnce(store, { ...valid, captureKey: "" }),
  ).toThrow(/CHECK constraint failed/);
  expect(() =>
    // @ts-expect-error: not a CaptureSource
    insertRawCaptureOnce(store, { ...valid, source: "somewhere-else" }),
  ).toThrow(/Unknown capture source/);
  expect(summariseRawCaptures(store).count).toBe(0);
});

test("the summary counts captures and reports the latest received time, per source or overall", () => {
  const store = openTempStore();
  expect(summariseRawCaptures(store)).toEqual({
    count: 0,
    lastReceivedAt: null,
  });

  const earlier = new Date("2026-10-11T09:00:00.000Z");
  const later = new Date("2026-10-12T09:00:00.000Z");
  // Stored out of order, as a draining queue can deliver them.
  insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    receivedAt: later,
  });
  insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    receivedAt: earlier,
  });
  insertRawCapture(store, {
    source: "x-api-v2",
    operation: "GET /2/users/:id/bookmarks",
    payload,
    receivedAt: earlier,
  });

  expect(summariseRawCaptures(store)).toEqual({
    count: 3,
    lastReceivedAt: later,
  });
  expect(summariseRawCaptures(store, "x-web-client")).toEqual({
    count: 2,
    lastReceivedAt: later,
  });
  expect(summariseRawCaptures(store, "x-api-v2")).toEqual({
    count: 1,
    lastReceivedAt: earlier,
  });
});

test("captures stored before the capture-key migration survive it unchanged", () => {
  const path = tempDatabasePath();
  const db = new Database(path);
  applyMigrations(db, migrations.slice(0, 1));
  db.prepare(
    "INSERT INTO raw_captures (source, operation, payload, received_at) VALUES (?, ?, ?, ?)",
  ).run("x-web-client", "Bookmarks", payload, 1760257800123);
  db.close();

  const store = openTempStore(path);

  expect(getRawCapture(store, 1)).toEqual({
    id: 1,
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    requestUrl: null,
    requestBody: null,
    captureKey: null,
    receivedAt: new Date(1760257800123),
  });
  // Unkeyed rows do not collide with each other under the unique index.
  insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
  });
  expect(summariseRawCaptures(store).count).toBe(2);
});

test("captures are listed oldest received first, whatever order they were stored in", () => {
  const store = openTempStore();
  expect(listRawCaptureIds(store)).toEqual([]);
  const at = (receivedAt: string) =>
    insertRawCapture(store, {
      source: "x-web-client",
      operation: "Bookmarks",
      payload,
      receivedAt: new Date(receivedAt),
    }).id;
  const third = at("2026-10-12T09:00:00.000Z");
  const first = at("2026-10-10T09:00:00.000Z");
  const second = at("2026-10-11T09:00:00.000Z");
  const alsoThird = at("2026-10-12T09:00:00.000Z");

  expect(listRawCaptureIds(store)).toEqual([first, second, third, alsoThird]);
});
