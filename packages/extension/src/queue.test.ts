import { expect, test } from "vitest";
import { NONCE_HEADER } from "./auth.ts";
import type { SeenResponse } from "./protocol.ts";
import { createCaptureQueue } from "./queue.ts";
import { fakeApp, memoryStorage, TOKEN } from "./testing.ts";

const payload =
  '{ "sortIndex":1861899614026727424,\n\t"text" : "caf\\u00e9 \u{1F516} ünïcode" , "n": 1.0 }\n';
const seen: SeenResponse = {
  operation: "Bookmarks",
  requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%7D",
  requestBody: null,
  payload,
};

function setUp(options: { token?: string; squatter?: boolean } = {}) {
  const storage = memoryStorage();
  storage.data.set("token", TOKEN);
  const app = fakeApp(options);
  let clock = 1760257900000;
  const queue = createCaptureQueue({
    storage,
    fetch: app.fetch,
    now: () => clock++,
  });
  return { storage, app, queue };
}

test("a capture is dated by the queue's own clock, whatever the caller passes", async () => {
  const { queue } = setUp();
  const forged = {
    ...seen,
    capturedAt: Date.parse("2017-01-01T00:00:00Z"),
  } as SeenResponse;

  const first = await queue.enqueue(forged);
  const second = await queue.enqueue(seen);

  expect(first.capturedAt).toBe(1760257900000);
  expect(second.capturedAt).toBeGreaterThan(first.capturedAt);
  expect(await queue.status()).toMatchObject({
    captured: 2,
    lastCapturedAt: second.capturedAt,
  });
});

test("a capture is sent only after the app has proved itself, signed, and exactly as queued", async () => {
  const { queue, app } = setUp();

  const queued = await queue.enqueue(seen);
  const status = await queue.deliver();

  expect(app.requests.map(({ path, body }) => [path, body])).toEqual([
    ["/api/pairing", "{}"],
    ["/api/ingest", JSON.stringify(queued)],
  ]);
  expect(JSON.parse(app.requests[1]?.body ?? "").payload).toBe(payload);
  expect(status).toMatchObject({
    pairing: "paired",
    captured: 1,
    delivered: 1,
    pending: 0,
    rejected: 0,
    lastError: null,
  });
});

test("the pairing token itself is never sent", async () => {
  const { queue, app } = setUp();

  await queue.enqueue(seen);
  await queue.deliver();

  expect(app.requests).toHaveLength(2);
  for (const request of app.requests) {
    expect(JSON.stringify(request)).not.toContain(TOKEN);
    expect(request.headers.authorization).toMatch(
      /^CURIO1-HMAC-SHA256 [0-9a-f]{64}$/,
    );
  }
  // A fresh nonce per request, so no answer can be replayed for another.
  expect(app.requests[0]?.headers[NONCE_HEADER]).not.toBe(
    app.requests[1]?.headers[NONCE_HEADER],
  );
});

test("captures taken while the app is closed wait, and arrive once it is back", async () => {
  const { queue, app } = setUp();
  app.goDown();

  await queue.enqueue(seen);
  const down = await queue.deliver();
  await queue.enqueue(seen);
  const stillDown = await queue.deliver();
  app.comeUp();
  const up = await queue.deliver();

  expect(down).toMatchObject({ captured: 1, delivered: 0, pending: 1 });
  expect(down.lastError?.message).toMatch(/did not answer/);
  expect(stillDown).toMatchObject({ captured: 2, delivered: 0, pending: 2 });
  expect(up).toMatchObject({ delivered: 2, pending: 0, lastError: null });
  expect(app.stored.size).toBe(2);
});

test("something else on the app's port gets no capture and no secret, and deletes nothing", async () => {
  const { queue, app } = setUp({ squatter: true });

  const queued = await queue.enqueue(seen);
  const status = await queue.deliver();

  // It answered 200 to the opening check, without proof, and that was all it
  // was ever sent.
  expect(app.requests.map(({ path, body }) => [path, body])).toEqual([
    ["/api/pairing", "{}"],
  ]);
  expect(JSON.stringify(app.requests)).not.toContain(TOKEN);
  expect(JSON.stringify(app.requests)).not.toContain(queued.id);
  expect(status).toMatchObject({
    pairing: "refused",
    delivered: 0,
    pending: 1,
  });
  expect(status.lastError?.message).toMatch(/did not prove/);
});

test("an app holding a different token is treated the same way", async () => {
  const { queue, app } = setUp({
    token: "Zq3vX2mB8sYt0aLr5nWc7dHf1gJz4pQe9uTi6oVbNxM",
  });

  await queue.enqueue(seen);
  const status = await queue.deliver();

  expect(app.captureIds()).toEqual([]);
  expect(status).toMatchObject({ pairing: "refused", pending: 1 });
});

test("an answer that looks like the app's but carries no valid proof removes nothing", async () => {
  const { queue, app } = setUp();
  app.answer("mimic");

  const queued = await queue.enqueue(seen);
  const fooled = await queue.deliver();
  const retried = await queue.deliver();

  expect(fooled).toMatchObject({ delivered: 0, pending: 1 });
  expect(fooled.lastError?.message).toMatch(/did not prove/);
  expect(retried).toMatchObject({ delivered: 1, pending: 0 });
  expect([...app.stored.keys()]).toEqual([queued.id]);
});

test("the app's proven answer removes a capture only when it confirms that capture", async () => {
  const { queue, app } = setUp();
  app.answer("wrong-id", 202);

  await queue.enqueue(seen);
  const wrongId = await queue.deliver();
  const notStored = await queue.deliver();
  const confirmed = await queue.deliver();

  expect(wrongId).toMatchObject({ delivered: 0, pending: 1 });
  expect(wrongId.lastError?.message).toMatch(/without confirming/);
  expect(notStored).toMatchObject({ delivered: 0, pending: 1 });
  expect(notStored.lastError?.message).toMatch(/HTTP 202 without confirming/);
  expect(confirmed).toMatchObject({ delivered: 1, pending: 0 });
});

test("a capture whose acknowledgement was lost is sent again under the same id, so the app stores it once", async () => {
  const { queue, app } = setUp();
  app.answer("stored-then-lost");

  const queued = await queue.enqueue(seen);
  const lost = await queue.deliver();
  const retried = await queue.deliver();

  expect(lost).toMatchObject({ delivered: 0, pending: 1 });
  expect(retried).toMatchObject({ delivered: 1, pending: 0 });
  expect(app.captureIds()).toEqual([queued.id, queued.id]);
  expect([...app.stored]).toEqual([[queued.id, payload]]);
});

test("captures are delivered oldest first, and nothing is sent past the first failure", async () => {
  const { queue, app, storage } = setUp();
  const first = await queue.enqueue(seen);
  const second = await queue.enqueue(seen);
  const third = await queue.enqueue(seen);
  // Storage hands keys back in no particular order.
  const entries = [...storage.data].reverse();
  storage.data.clear();
  for (const [key, value] of entries) storage.data.set(key, value);
  app.answer(200, "unreachable");

  const status = await queue.deliver();

  expect(app.captureIds()).toEqual([first.id, second.id]);
  expect(status).toMatchObject({ delivered: 1, pending: 2 });
  await queue.deliver();
  expect([...app.stored.keys()]).toEqual([first.id, second.id, third.id]);
});

test("the queue and its counters survive the service worker being restarted", async () => {
  const { queue, storage, app } = setUp();
  app.goDown();
  const queued = await queue.enqueue(seen);
  await queue.deliver();
  app.comeUp();

  const restarted = createCaptureQueue({ storage, fetch: app.fetch });
  const status = await restarted.deliver();

  expect(status).toMatchObject({ captured: 1, delivered: 1, pending: 0 });
  expect([...app.stored.keys()]).toEqual([queued.id]);
});

test("deliveries asked for at the same time send each capture once", async () => {
  const { queue, app } = setUp();

  const queued = [
    await queue.enqueue(seen),
    await queue.enqueue(seen),
    await queue.enqueue(seen),
  ];
  const statuses = await Promise.all([
    queue.deliver(),
    queue.deliver(),
    queue.enqueue(seen).then(() => queue.deliver()),
  ]);

  const sentIds = app.captureIds();
  expect(sentIds).toHaveLength(4);
  expect(new Set(sentIds).size).toBe(4);
  expect(sentIds.slice(0, 3)).toEqual(queued.map(({ id }) => id));
  expect(statuses[2]).toMatchObject({ captured: 4, delivered: 4, pending: 0 });
});

test("without a token nothing is sent", async () => {
  const { queue, app, storage } = setUp();
  storage.data.delete("token");

  await queue.enqueue(seen);
  const status = await queue.deliver();

  expect(app.fetch).not.toHaveBeenCalled();
  expect(status).toMatchObject({ pairing: "none", pending: 1 });
  expect(status.lastError?.message).toMatch(/Not paired/);
});

test("with nothing waiting, a delivery contacts no one", async () => {
  const { queue, app } = setUp();

  const status = await queue.deliver();

  expect(app.fetch).not.toHaveBeenCalled();
  expect(status).toMatchObject({ pending: 0, lastError: null });
});

test("a server error stops delivery and keeps every capture", async () => {
  const { queue, app } = setUp();
  app.answer(500);

  await queue.enqueue(seen);
  await queue.enqueue(seen);
  const status = await queue.deliver();

  expect(app.captureIds()).toHaveLength(1);
  expect(status).toMatchObject({ delivered: 0, pending: 2, rejected: 0 });
  expect(status.lastError?.message).toMatch(/HTTP 500/);
});

test("a capture the app refuses is set aside, kept, and does not hold up the rest", async () => {
  const { queue, app } = setUp();
  app.answer(422);

  const refused = await queue.enqueue(seen);
  const fine = await queue.enqueue(seen);
  const status = await queue.deliver();

  expect(status).toMatchObject({ delivered: 1, pending: 0, rejected: 1 });
  expect(status.lastError?.message).toMatch(/refused a capture \(HTTP 422\)/);
  expect([...app.stored.keys()]).toEqual([fine.id]);

  // An ordinary delivery leaves it aside; asking for refused ones re-sends it.
  await queue.deliver();
  expect(app.captureIds()).toHaveLength(2);
  const retried = await queue.deliver({ retryRejected: true });
  expect(retried).toMatchObject({ delivered: 2, rejected: 0, lastError: null });
  expect([...app.stored.keys()]).toEqual([fine.id, refused.id]);
});

test("a problem reported by the page hook shows as the last error until a newer one replaces it", async () => {
  const { queue } = setUp();

  await queue.noteProblem({
    operation: "Bookmarks",
    detail: "X answered HTTP 429; nothing was captured.",
  });
  await queue.enqueue(seen);
  const status = await queue.deliver();

  expect(status.delivered).toBe(1);
  expect(status.lastError?.message).toBe(
    "Bookmarks: X answered HTTP 429; nothing was captured.",
  );
});

test("each error says what it is about, so that the popup need not read its prose", async () => {
  const troubleAfter = async (
    arrange: (the: ReturnType<typeof setUp>) => void | Promise<void>,
    options?: Parameters<typeof setUp>[0],
  ) => {
    const the = setUp(options);
    await arrange(the);
    await the.queue.enqueue(seen);
    return (await the.queue.deliver()).lastError?.trouble;
  };

  expect(
    await troubleAfter(({ storage }) => void storage.data.delete("token")),
  ).toBe("not-paired");
  expect(await troubleAfter(({ app }) => app.goDown())).toBe("app-unreachable");
  expect(await troubleAfter(() => {}, { squatter: true })).toBe("app-unproven");
  expect(await troubleAfter(({ app }) => app.answer(422))).toBe(
    "capture-refused",
  );
  expect(await troubleAfter(({ app }) => app.answer(500))).toBe(
    "capture-unconfirmed",
  );

  const { queue, storage } = setUp();
  await queue.noteProblem({ operation: "Bookmarks", detail: "X was busy." });
  expect((await queue.status()).lastError?.trouble).toBe("not-captured");

  // An error an earlier version stored says nothing of the kind, and reads as that.
  storage.data.set("stats", {
    captured: 0,
    lastCapturedAt: null,
    lastDeliveredAt: null,
    lastError: { at: 1760257900000, message: "From before.", from: "delivery" },
  });
  expect((await queue.status()).lastError).toEqual({
    at: 1760257900000,
    message: "From before.",
    trouble: null,
  });
});

test("checking the pairing again confirms a token saved while the app was closed, and delivers what waited", async () => {
  const { queue, app } = setUp();
  app.goDown();
  const closed = await queue.pair(TOKEN);
  await queue.enqueue(seen);
  const stillClosed = await queue.checkPairing();
  expect(app.requests).toEqual([]);

  app.comeUp();
  const open = await queue.checkPairing();

  expect(closed.pairing).toBe("unconfirmed");
  expect(stillClosed).toMatchObject({ pairing: "unconfirmed", pending: 1 });
  expect(stillClosed.lastError?.trouble).toBe("app-unreachable");
  expect(open).toMatchObject({
    pairing: "paired",
    delivered: 1,
    pending: 0,
    lastError: null,
  });
  // The same signed greeting a delivery opens with, then the delivery.
  expect(
    app.requests.map(({ path, body }) => [path, body.slice(0, 2)]),
  ).toEqual([
    ["/api/pairing", "{}"],
    ["/api/pairing", "{}"],
    ["/api/ingest", '{"'],
  ]);
  for (const request of app.requests) {
    expect(JSON.stringify(request)).not.toContain(TOKEN);
  }
});

test("checking the pairing again sends nothing without a token, and changes nothing about a token the app turns down", async () => {
  const unpaired = setUp();
  unpaired.storage.data.delete("token");
  await unpaired.queue.enqueue(seen);

  expect(await unpaired.queue.checkPairing()).toMatchObject({
    pairing: "none",
    pending: 1,
  });
  expect(unpaired.app.fetch).not.toHaveBeenCalled();

  const stale = setUp({ token: "the-app-holds-another-token" });
  await stale.queue.enqueue(seen);
  const refused = await stale.queue.checkPairing();

  expect(refused).toMatchObject({ pairing: "refused", pending: 1 });
  expect(refused.lastError?.trouble).toBe("app-unproven");
  expect(stale.app.captureIds()).toEqual([]);
  expect(stale.storage.data.get("token")).toBe(TOKEN);
});

test("pairing stores the token, has the app prove itself, and delivers what was waiting", async () => {
  const { queue, app, storage } = setUp();
  storage.data.delete("token");
  await queue.enqueue(seen);

  const status = await queue.pair(`  ${TOKEN}\n`);

  expect(app.requests.map(({ path }) => path)).toEqual([
    "/api/pairing",
    "/api/pairing",
    "/api/ingest",
  ]);
  expect(status).toMatchObject({
    pairing: "paired",
    delivered: 1,
    lastError: null,
  });
});

test("a token the app does not hold shows as refused, and keeps showing so", async () => {
  const { queue } = setUp();

  const refused = await queue.pair("not-the-apps-token");
  const afterIdleDelivery = await queue.deliver();

  expect(refused.pairing).toBe("refused");
  expect(refused.lastError?.message).toMatch(/did not prove/);
  expect(afterIdleDelivery).toMatchObject({
    pairing: "refused",
    lastError: refused.lastError,
  });
});

test("pairing while the app is closed is unconfirmed, then confirmed by the next delivery", async () => {
  const { queue, app } = setUp();
  app.goDown();

  const closed = await queue.pair(TOKEN);
  app.comeUp();
  await queue.enqueue(seen);
  const open = await queue.deliver();

  expect(closed.pairing).toBe("unconfirmed");
  expect(closed.lastError?.message).toMatch(/did not answer/);
  expect(open).toMatchObject({ pairing: "paired", delivered: 1 });
});

test("the delivered count stays true when the worker stops between removing a capture and anything else", async () => {
  const { queue, storage, app } = setUp();
  await queue.enqueue(seen);
  await queue.enqueue(seen);
  // The worker stops right after a delivered capture is taken off the queue:
  // every later write of that run is lost.
  const remove = storage.remove;
  let stopped = false;
  storage.remove = async (key) => {
    await remove(key);
    stopped = true;
  };
  const set = storage.set;
  storage.set = async (items) => {
    if (!stopped) await set(items);
  };
  await queue.deliver();
  storage.remove = remove;
  storage.set = set;

  const restarted = createCaptureQueue({ storage, fetch: app.fetch });
  const status = await restarted.deliver();

  expect(app.stored.size).toBe(2);
  expect(status).toMatchObject({ captured: 2, delivered: 2, pending: 0 });
});
