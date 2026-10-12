import { getEventListeners } from "node:events";
import { expect, onTestFinished, test, vi } from "vitest";
import { type HookTarget, installHook } from "./hook.ts";
import type { HookEvent } from "./protocol.ts";

// Odd spacing, an integer beyond Number.MAX_SAFE_INTEGER, escapes and
// non-ASCII text: everything a JSON round-trip would normalise or corrupt.
const payload =
  '{ "sortIndex":1861899614026727424,\n\t"text" : "caf\\u00e9 \u{1F516} ünïcode" , "n": 1.0 }\n';
const bookmarksUrl =
  "https://x.com/i/api/graphql/tF6KOjmZM0WGcB2Q0mfwhw/Bookmarks?variables=%7B%22count%22%3A20%7D";

/** A stand-in for a page's window, recording every call that reaches the "browser". */
function fakePage() {
  const opened: unknown[][] = [];
  const sent: unknown[][] = [];
  const textReads: FakeXhr[] = [];

  class FakeXhr extends EventTarget {
    status = 0;
    responseType = "";
    body = "";
    get responseText(): string {
      textReads.push(this);
      return this.body;
    }
    open(...args: unknown[]): void {
      opened.push(args);
    }
    send(...args: unknown[]): void {
      sent.push(args);
    }
    respond(status: number, body: string): void {
      this.status = status;
      this.body = body;
      this.dispatchEvent(new Event("load"));
    }
  }

  const nativeFetch = vi.fn<typeof fetch>(async () => new Response(payload));
  const target = {
    XMLHttpRequest: FakeXhr,
    fetch: nativeFetch,
    location: { href: "https://x.com/i/bookmarks" },
  };
  const events: HookEvent[] = [];
  installHook(target as unknown as HookTarget, (event) => events.push(event));
  return { FakeXhr, target, nativeFetch, events, opened, sent, textReads };
}

/** Lets the hook's reading of a fetch response finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an allowlisted XHR response is captured exactly as received", () => {
  const { FakeXhr, events } = fakePage();
  const xhr = new FakeXhr();

  xhr.open("GET", bookmarksUrl);
  xhr.send(null);
  xhr.respond(200, payload);

  expect(events).toEqual([
    {
      kind: "capture",
      capture: {
        operation: "Bookmarks",
        requestUrl: bookmarksUrl,
        requestBody: null,
        payload,
      },
    },
  ]);
});

test("a relative request URL is resolved against the page", () => {
  const { FakeXhr, events } = fakePage();
  const xhr = new FakeXhr();

  xhr.open("GET", "/i/api/graphql/abc/BookmarkFoldersSlice?variables=%7B%7D");
  xhr.send();
  xhr.respond(200, payload);

  expect(events).toMatchObject([
    {
      capture: {
        operation: "BookmarkFoldersSlice",
        requestUrl:
          "https://x.com/i/api/graphql/abc/BookmarkFoldersSlice?variables=%7B%7D",
      },
    },
  ]);
});

test("a mutation's request body is kept with its response", () => {
  const { FakeXhr, events } = fakePage();
  const body =
    '{"variables":{ "tweet_id":"1861899614026727424" },"queryId":"abc"}';
  const xhr = new FakeXhr();

  xhr.open("POST", "https://x.com/i/api/graphql/abc/CreateBookmark");
  xhr.send(body);
  xhr.respond(200, '{"data":{"tweet_bookmark_put":"Done"}}');

  expect(events).toMatchObject([
    { capture: { operation: "CreateBookmark", requestBody: body } },
  ]);
});

test.each([
  ["another operation", "https://x.com/i/api/graphql/abc/HomeTimeline"],
  ["a longer name", "https://x.com/i/api/graphql/abc/BookmarksAllDelete"],
  ["another host", "https://example.com/i/api/graphql/abc/Bookmarks"],
  ["a look-alike host", "https://notx.com/i/api/graphql/abc/Bookmarks"],
  ["a non-GraphQL path", "https://x.com/i/api/1.1/Bookmarks"],
])("a request for %s is left alone: its response is never read", (_, url) => {
  const { FakeXhr, events, textReads } = fakePage();
  const xhr = new FakeXhr();

  xhr.open("GET", url);
  xhr.send('{"private":"body"}');
  xhr.respond(200, payload);

  expect(events).toEqual([]);
  expect(textReads).toEqual([]);
  expect(getEventListeners(xhr, "load")).toEqual([]);
});

test("the page's XHR calls reach the browser unchanged, and the hook adds none", () => {
  const { FakeXhr, opened, sent, nativeFetch } = fakePage();
  const xhr = new FakeXhr();

  xhr.open("POST", bookmarksUrl, true, "user", "password");
  xhr.send("body");
  xhr.respond(200, payload);
  const other = new FakeXhr();
  other.open("GET", "https://x.com/i/api/graphql/abc/HomeTimeline");
  other.send();
  other.respond(200, payload);

  expect(opened).toEqual([
    ["POST", bookmarksUrl, true, "user", "password"],
    ["GET", "https://x.com/i/api/graphql/abc/HomeTimeline"],
  ]);
  expect(sent).toEqual([["body"], []]);
  expect(nativeFetch).not.toHaveBeenCalled();
});

test("a failed response is reported as a problem and not captured", () => {
  const { FakeXhr, events, textReads } = fakePage();
  const xhr = new FakeXhr();

  xhr.open("GET", bookmarksUrl);
  xhr.send();
  xhr.respond(429, "Rate limit exceeded");

  expect(events).toEqual([
    {
      kind: "problem",
      problem: {
        operation: "Bookmarks",
        detail: "X answered HTTP 429; nothing was captured.",
      },
    },
  ]);
  expect(textReads).toEqual([]);
});

test("a response whose text cannot be read is reported as a problem", () => {
  const { FakeXhr, events, textReads } = fakePage();
  const xhr = new FakeXhr();
  xhr.responseType = "json";

  xhr.open("GET", bookmarksUrl);
  xhr.send();
  xhr.respond(200, payload);

  expect(events).toMatchObject([
    { kind: "problem", problem: { operation: "Bookmarks" } },
  ]);
  expect(textReads).toEqual([]);
});

test("a reused request is captured once per response, under its latest URL", () => {
  const { FakeXhr, events } = fakePage();
  const xhr = new FakeXhr();

  xhr.open("GET", bookmarksUrl);
  xhr.send();
  xhr.respond(200, payload);
  xhr.open("GET", "https://x.com/i/api/graphql/abc/HomeTimeline");
  xhr.send();
  xhr.respond(200, "{}");
  xhr.open("GET", bookmarksUrl);
  xhr.send();
  xhr.respond(200, payload);

  expect(events).toHaveLength(2);
});

test("an allowlisted fetch response is captured from a copy, leaving the page's response unread", async () => {
  const { target, nativeFetch, events } = fakePage();
  const original = new Response(payload);
  nativeFetch.mockResolvedValue(original);
  const init = { method: "GET", headers: { "x-csrf-token": "abc" } };

  const received = await target.fetch(bookmarksUrl, init);
  await settled();

  expect(received).toBe(original);
  expect(nativeFetch.mock.calls).toEqual([[bookmarksUrl, init]]);
  expect(events).toEqual([
    {
      kind: "capture",
      capture: {
        operation: "Bookmarks",
        requestUrl: bookmarksUrl,
        requestBody: null,
        payload,
      },
    },
  ]);
  expect(original.bodyUsed).toBe(false);
  expect(await original.text()).toBe(payload);
});

test("a fetch mutation's body is kept, from init or from a Request", async () => {
  const { target, nativeFetch, events } = fakePage();
  const url = "https://x.com/i/api/graphql/abc/DeleteBookmark";
  const body = '{"variables":{"tweet_id":"1861899614026727424"}}';
  const request = new Request(url, { method: "POST", body });

  await target.fetch(url, { method: "POST", body });
  await target.fetch(request);
  await settled();

  expect(events).toMatchObject([
    { capture: { operation: "DeleteBookmark", requestBody: body } },
    { capture: { operation: "DeleteBookmark", requestBody: body } },
  ]);
  // The page's own Request went to the browser unread.
  expect(nativeFetch.mock.calls[1]).toEqual([request]);
  expect(request.bodyUsed).toBe(false);
});

test("any other fetch goes straight through: its response is never copied or read", async () => {
  const { target, nativeFetch, events } = fakePage();
  const original = new Response(payload);
  const clone = vi.spyOn(original, "clone");
  nativeFetch.mockResolvedValue(original);

  const returned = target.fetch(
    new URL("https://x.com/i/api/graphql/abc/HomeTimeline"),
  );
  const response = await returned;
  await settled();

  // The very promise the browser's fetch returned, not one derived from it.
  expect(returned).toBe(nativeFetch.mock.results[0]?.value);
  expect(response).toBe(original);
  expect(clone).not.toHaveBeenCalled();
  expect(original.bodyUsed).toBe(false);
  expect(events).toEqual([]);
});

test("a fetch that fails, or answers with an error, reaches the page as it is", async () => {
  const { target, nativeFetch, events } = fakePage();
  const failure = new TypeError("Failed to fetch");
  nativeFetch.mockRejectedValueOnce(failure);
  nativeFetch.mockResolvedValueOnce(new Response("nope", { status: 403 }));

  await expect(target.fetch(bookmarksUrl)).rejects.toBe(failure);
  const refused = await target.fetch(bookmarksUrl);
  await settled();

  expect(refused.status).toBe(403);
  expect(refused.bodyUsed).toBe(false);
  expect(events).toEqual([
    {
      kind: "problem",
      problem: {
        operation: "Bookmarks",
        detail: "X answered HTTP 403; nothing was captured.",
      },
    },
  ]);
});

test("a failure while reporting never reaches the page", () => {
  const opened: unknown[][] = [];
  class FakeXhr extends EventTarget {
    status = 200;
    responseType = "";
    responseText = payload;
    open(...args: unknown[]): void {
      opened.push(args);
    }
    send(): void {}
  }
  const target = {
    XMLHttpRequest: FakeXhr,
    fetch,
    location: { href: "https://x.com/home" },
  };
  installHook(target as unknown as HookTarget, () => {
    throw new Error("the extension was reloaded");
  });
  const xhr = new FakeXhr();

  xhr.open("GET", bookmarksUrl);
  xhr.send();

  expect(() => xhr.dispatchEvent(new Event("load"))).not.toThrow();
  expect(opened).toHaveLength(1);
});

test("the wrappers have the shape of the functions they stand in for", () => {
  const { FakeXhr, target } = fakePage();
  const shapes = [
    [FakeXhr.prototype.open, "open", 2],
    [FakeXhr.prototype.send, "send", 0],
    [target.fetch, "fetch", 1],
  ] as const;

  for (const [wrapper, name, length] of shapes) {
    expect(wrapper.name).toBe(name);
    expect(wrapper.length).toBe(length);
    // Like a built-in: nothing but name and length, so no prototype, and not
    // a constructor.
    expect(Object.getOwnPropertyNames(wrapper).sort()).toEqual([
      "length",
      "name",
    ]);
    expect(() => Reflect.construct(wrapper, [])).toThrow(TypeError);
  }
});

test("the browser's functions get the page's own this and argument count", async () => {
  const calls: { self: unknown; args: unknown[] }[] = [];
  class FakeXhr extends EventTarget {
    open(...args: unknown[]): string {
      calls.push({ self: this, args });
      return "open result";
    }
    send(...args: unknown[]): string {
      calls.push({ self: this, args });
      return "send result";
    }
  }
  const fromBrowser = Promise.resolve(new Response("{}"));
  const target = {
    XMLHttpRequest: FakeXhr,
    fetch(this: unknown, ...args: unknown[]) {
      calls.push({ self: this, args });
      return fromBrowser;
    },
    location: { href: "https://x.com/home" },
  };
  installHook(target as unknown as HookTarget, () => {});
  const xhr = new FakeXhr();
  const detached = target.fetch as (...args: unknown[]) => unknown;

  // Two arguments, not five with three undefined: the browser reads a
  // missing third argument as "asynchronous" and a present undefined as not.
  const opened = xhr.open("GET", "https://x.com/home");
  const sent = xhr.send();
  const fetched = detached("https://x.com/home");
  const withExtras = detached("https://x.com/home", undefined, "extra");

  expect([opened, sent]).toEqual(["open result", "send result"]);
  expect(fetched).toBe(fromBrowser);
  expect(withExtras).toBe(fromBrowser);
  expect(calls).toEqual([
    { self: xhr, args: ["GET", "https://x.com/home"] },
    { self: xhr, args: [] },
    { self: undefined, args: ["https://x.com/home"] },
    { self: undefined, args: ["https://x.com/home", undefined, "extra"] },
  ]);
});

test("a rejected allowlisted fetch stays unhandled when the page does not handle it", async () => {
  const { target, nativeFetch } = fakePage();
  const failure = new TypeError("Failed to fetch");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  onTestFinished(() => void process.off("unhandledRejection", onUnhandled));

  // Left unhandled: with no extension the page's promise would report it.
  nativeFetch.mockRejectedValueOnce(failure);
  void target.fetch(bookmarksUrl);
  await settled();
  // Handled by the page: nothing may be reported.
  nativeFetch.mockRejectedValueOnce(new TypeError("handled by the page"));
  await target.fetch(bookmarksUrl).catch(() => {});
  await settled();

  expect(unhandled).toEqual([failure]);
});

test("the hook listens through the browser's own addEventListener, not one the page has wrapped", () => {
  const { FakeXhr, events } = fakePage();
  // What an error-reporting script does to every event target on the page.
  const pageSaw: string[] = [];
  const browsers = FakeXhr.prototype.addEventListener;
  FakeXhr.prototype.addEventListener = function (
    this: EventTarget,
    ...args: Parameters<EventTarget["addEventListener"]>
  ) {
    pageSaw.push(args[0]);
    return browsers.apply(this, args);
  };
  const xhr = new FakeXhr();

  xhr.open("GET", bookmarksUrl);
  xhr.addEventListener("load", () => {});
  xhr.send();
  xhr.respond(200, payload);
  xhr.open("GET", bookmarksUrl);

  // Only the page's own call went through the page's wrapper.
  expect(pageSaw).toEqual(["load"]);
  expect(events).toHaveLength(1);
  // One listener of the hook's, however often the request is reused.
  expect(getEventListeners(xhr, "load")).toHaveLength(2);
});
