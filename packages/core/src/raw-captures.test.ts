import { expect, test } from "vitest";
import { getRawCapture, insertRawCapture } from "./raw-captures.ts";
import { connectionOf } from "./store.ts";
import { openTempStore, tempDatabasePath } from "./testing/temp-database.ts";

// Odd spacing, an integer beyond Number.MAX_SAFE_INTEGER, escapes, and
// non-ASCII text: everything a JSON round-trip would normalise or corrupt.
const payload =
  '{ "sortIndex":1861899614026727424,\n\t"text" : "caf\\u00e9 \u{1F516} ünïcode" , "n": 1.0 }\n';

test("a raw capture round-trips byte for byte, across a reopen", () => {
  const path = tempDatabasePath();
  const receivedAt = new Date("2026-10-12T08:30:00.123Z");
  const writer = openTempStore(path);

  const inserted = insertRawCapture(writer, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload,
    requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%7D",
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
    receivedAt,
  });
  expect(stored).toEqual(inserted);
});

test("receivedAt defaults to now and requestUrl to null", () => {
  const store = openTempStore();
  const before = Date.now();

  const { id } = insertRawCapture(store, {
    source: "x-api-v2",
    operation: "GET /2/users/:id/bookmarks",
    payload,
  });

  const stored = getRawCapture(store, id);
  expect(stored?.requestUrl).toBeNull();
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
