// Runs in the fake X page, standing in for X's web client at its most varied.
// `runShapes()` makes one request of every shape below and returns everything
// the page can observe about each. The test runs it in a browser with the
// extension and in one without, and requires the two results, and the two
// sets of requests the server received, to be identical.
(() => {
  const GQL = "/i/api/graphql/tF6KOjmZM0WGcB2Q0mfwhw";
  const BOOKMARKS = `${GQL}/Bookmarks?variables=%7B%22count%22%3A20%7D&features=%7B%7D`;
  const MUTATION = `${GQL}/CreateBookmark`;
  const MUTATION_BODY =
    '{"variables":{ "tweet_id":"1861899614026727424" },"queryId":"aoDbu3RHznuiSkQ9aNM67Q"}';
  const HEADERS = [
    ["authorization", "Bearer fake-web-client-token"],
    ["x-csrf-token", "fake-csrf"],
    ["x-twitter-active-user", "yes"],
    ["content-type", "application/json"],
    ["x-client-transaction-id", "fake-transaction"],
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hex = (buffer) =>
    [...new Uint8Array(buffer)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  const describeError = (error) => `${error?.name}: ${error?.message}`;

  function xhrShape(options) {
    return new Promise((resolve) => {
      const xhr = options.reuse ?? new XMLHttpRequest();
      const events = [];
      let thrown;
      let done = false;
      // Consecutive repeats are folded: how many times LOADING is announced
      // depends on how the network chunks the body.
      const note = (event) => {
        if (events.at(-1) !== event) events.push(event);
      };
      const onState = () => note(`readyState ${xhr.readyState}`);
      const onEvent = (event) => {
        note(event.type);
        if (event.type === "loadend") finish();
      };
      const types = [
        "loadstart",
        "load",
        "error",
        "abort",
        "timeout",
        "loadend",
      ];
      xhr.addEventListener("readystatechange", onState);
      for (const type of types) xhr.addEventListener(type, onEvent);

      async function finish() {
        if (done) return;
        done = true;
        xhr.removeEventListener("readystatechange", onState);
        for (const type of types) xhr.removeEventListener(type, onEvent);
        let response;
        try {
          const type = xhr.responseType;
          if (type === "" || type === "text") response = xhr.responseText;
          else if (type === "json") response = JSON.stringify(xhr.response);
          else if (type === "arraybuffer")
            response = xhr.response && hex(xhr.response);
          else if (type === "blob")
            response = xhr.response && [
              xhr.response.type,
              await xhr.response.text(),
            ];
          else if (type === "document")
            response = xhr.response?.documentElement.outerHTML ?? null;
        } catch (error) {
          response = `unreadable: ${describeError(error)}`;
        }
        resolve({
          events,
          readyState: xhr.readyState,
          status: xhr.status,
          statusText: xhr.statusText,
          responseURL: xhr.responseURL,
          headers: xhr.getAllResponseHeaders(),
          response,
          thrown,
        });
      }

      try {
        if (options.sendBeforeOpen) xhr.send();
        // Two arguments or three: the browser tells them apart.
        if (options.async === undefined)
          xhr.open(options.method ?? "GET", options.url);
        else xhr.open(options.method ?? "GET", options.url, options.async);
        if (options.responseType) xhr.responseType = options.responseType;
        if (options.timeout) xhr.timeout = options.timeout;
        if (options.withCredentials) xhr.withCredentials = true;
        for (const [name, value] of options.headers ?? [])
          xhr.setRequestHeader(name, value);
        xhr.send(options.body);
        if (options.abortAfter !== undefined)
          setTimeout(() => xhr.abort(), options.abortAfter);
        if (options.async === false) finish();
      } catch (error) {
        thrown = describeError(error);
        finish();
      }
    });
  }

  async function fetchShape(make, read = (response) => response.text()) {
    try {
      const response = await make();
      const seen = {
        status: response.status,
        statusText: response.statusText,
        type: response.type,
        url: response.url,
        redirected: response.redirected,
        headers: [...response.headers],
        bodyUsedBefore: response.bodyUsed,
      };
      try {
        seen.body = await read(response);
      } catch (error) {
        seen.bodyError = describeError(error);
      }
      seen.bodyUsedAfter = response.bodyUsed;
      return seen;
    } catch (error) {
      return { thrown: describeError(error) };
    }
  }

  async function readInChunks(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  }

  /** Which rejected fetches the page hears about when it handles none of them. */
  async function unhandledRejections() {
    const heard = [];
    const listen = (event) => {
      heard.push(describeError(event.reason));
      event.preventDefault();
    };
    addEventListener("unhandledrejection", listen);
    // One at a time, so the server receives them in the same order each run.
    fetch(`${GQL}/Bookmarks?reset`); // allowlisted, left unhandled
    await sleep(300);
    fetch(`${GQL}/HomeTimeline?reset`); // not allowlisted, left unhandled
    await sleep(300);
    fetch(`${GQL}/Bookmarks?reset`).catch(() => {}); // handled by the page
    await sleep(500);
    removeEventListener("unhandledrejection", listen);
    return heard.sort();
  }

  function thrownBy(action) {
    try {
      action();
      return "did not throw";
    } catch (error) {
      return describeError(error);
    }
  }

  /**
   * What a page sees when it has wrapped its own event plumbing, as error
   * reporting scripts do: every listener added to a request and every event
   * dispatched on the window, during one allowlisted XHR and one fetch.
   */
  async function instrumentedPage() {
    const calls = [];
    const targets = [
      [EventTarget.prototype, "addEventListener"],
      [EventTarget.prototype, "dispatchEvent"],
      [XMLHttpRequest.prototype, "addEventListener"],
      [window, "dispatchEvent"],
    ];
    const originals = targets.map(([holder, key]) => [
      holder,
      key,
      Object.getOwnPropertyDescriptor(holder, key),
    ]);
    for (const [holder, key] of targets) {
      const original = holder[key];
      holder[key] = function (...args) {
        const what = key === "dispatchEvent" ? args[0]?.type : args[0];
        calls.push(`${this?.constructor?.name}.${key}(${what})`);
        return original.apply(this, args);
      };
    }
    try {
      await xhrShape({ url: BOOKMARKS });
      await fetchShape(() => fetch(BOOKMARKS));
      await sleep(200);
    } finally {
      for (const [holder, key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(holder, key, descriptor);
        else delete holder[key];
      }
    }
    return calls;
  }

  /** Whether a script on the page can hear the extension's own event. */
  async function hookEventHeard() {
    const heard = [];
    const listen = (event) => heard.push(typeof event.detail);
    addEventListener("x-bookmarks:hook", listen);
    await xhrShape({ url: BOOKMARKS });
    await xhrShape({ url: `${GQL}/HomeTimeline` });
    await sleep(200);
    removeEventListener("x-bookmarks:hook", listen);
    return heard;
  }

  function shapeOf(holder, key) {
    const fn = holder[key];
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    let construct;
    try {
      new fn();
      construct = "constructed";
    } catch (error) {
      construct = error.name;
    }
    return {
      name: fn.name,
      length: fn.length,
      ownProperties: Object.getOwnPropertyNames(fn).sort(),
      typeOf: typeof fn,
      tag: Object.prototype.toString.call(fn),
      isPlainFunction: Object.getPrototypeOf(fn) === Function.prototype,
      writable: descriptor.writable,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
      construct,
    };
  }

  window.runShapes = async () => {
    const shapes = {};
    const run = async (name, shape) => {
      shapes[name] = await shape;
    };

    // XMLHttpRequest, every way of reading the response.
    for (const responseType of [
      "",
      "text",
      "json",
      "arraybuffer",
      "blob",
      "document",
    ]) {
      await run(
        `xhr GET allowlisted, responseType "${responseType}"`,
        xhrShape({ url: BOOKMARKS, responseType, headers: HEADERS }),
      );
    }
    await run(
      "xhr GET allowlisted, async passed as true",
      xhrShape({ url: BOOKMARKS, async: true }),
    );
    await run(
      "xhr GET allowlisted, synchronous",
      xhrShape({ url: BOOKMARKS, async: false }),
    );
    await run(
      "xhr GET allowlisted, with credentials",
      xhrShape({ url: BOOKMARKS, withCredentials: true }),
    );
    await run(
      "xhr GET not allowlisted",
      xhrShape({ url: `${GQL}/HomeTimeline`, headers: HEADERS }),
    );
    await run(
      "xhr GET allowlisted, rate limited",
      xhrShape({ url: `${GQL}/Bookmarks?fail=429` }),
    );
    await run(
      "xhr GET allowlisted, aborted",
      xhrShape({ url: `${GQL}/Bookmarks?delay=500`, abortAfter: 150 }),
    );
    await run(
      "xhr GET allowlisted, timed out",
      xhrShape({ url: `${GQL}/Bookmarks?delay=500`, timeout: 150 }),
    );
    await run(
      "xhr GET allowlisted, connection dropped",
      xhrShape({ url: `${GQL}/Bookmarks?reset` }),
    );
    await run(
      "xhr send before open",
      xhrShape({ url: BOOKMARKS, sendBeforeOpen: true }),
    );
    await run(
      "xhr open with an invalid method",
      xhrShape({ url: BOOKMARKS, method: "BAD METHOD" }),
    );
    // Called on things that are not requests: the browser's own complaint
    // must come through.
    shapes["xhr open called on a plain object"] = thrownBy(() =>
      XMLHttpRequest.prototype.open.call({}, "GET", BOOKMARKS),
    );
    shapes["xhr send called on nothing"] = thrownBy(() =>
      XMLHttpRequest.prototype.send.call(null),
    );
    const reused = new XMLHttpRequest();
    await run(
      "xhr reused, first allowlisted",
      xhrShape({ reuse: reused, url: BOOKMARKS }),
    );
    await run(
      "xhr reused, then not allowlisted",
      xhrShape({ reuse: reused, url: `${GQL}/HomeTimeline` }),
    );
    await run(
      "xhr reused, then allowlisted again",
      xhrShape({ reuse: reused, url: `${GQL}/BookmarkFoldersSlice` }),
    );

    // XMLHttpRequest mutations, every kind of body.
    const bodies = {
      string: MUTATION_BODY,
      URLSearchParams: new URLSearchParams({ tweet_id: "1861899614026727424" }),
      Blob: new Blob([MUTATION_BODY], { type: "application/json" }),
      ArrayBuffer: new TextEncoder().encode(MUTATION_BODY).buffer,
      FormData: (() => {
        const form = new FormData();
        form.append("tweet_id", "1861899614026727424");
        return form;
      })(),
    };
    for (const [kind, body] of Object.entries(bodies)) {
      await run(
        `xhr POST allowlisted mutation, ${kind} body`,
        xhrShape({
          method: "POST",
          url: MUTATION,
          body,
          headers:
            kind === "string"
              ? HEADERS
              : HEADERS.filter(([name]) => name !== "content-type"),
        }),
      );
    }

    // fetch, every way of reading the response.
    const get = () => fetch(BOOKMARKS, { headers: HEADERS });
    await run("fetch GET allowlisted, text()", fetchShape(get));
    await run(
      "fetch GET allowlisted, json()",
      fetchShape(get, async (r) => JSON.stringify(await r.json())),
    );
    await run(
      "fetch GET allowlisted, arrayBuffer()",
      fetchShape(get, async (r) => hex(await r.arrayBuffer())),
    );
    await run(
      "fetch GET allowlisted, blob()",
      fetchShape(get, async (r) => {
        const blob = await r.blob();
        return [blob.type, await blob.text()];
      }),
    );
    await run(
      "fetch GET allowlisted, read in chunks",
      fetchShape(get, readInChunks),
    );
    await run(
      "fetch GET allowlisted, cloned by the page",
      fetchShape(get, async (r) => [await r.clone().text(), await r.text()]),
    );
    await run(
      "fetch GET allowlisted, never read",
      fetchShape(get, async () => "not read"),
    );
    await run(
      "fetch GET allowlisted, Request object",
      fetchShape(() => fetch(new Request(BOOKMARKS, { headers: HEADERS }))),
    );
    await run(
      "fetch GET allowlisted, URL object and options",
      fetchShape(() =>
        fetch(new URL(BOOKMARKS, location.href), {
          credentials: "include",
          cache: "no-store",
          mode: "same-origin",
          keepalive: true,
        }),
      ),
    );
    await run(
      "fetch GET not allowlisted",
      fetchShape(() => fetch(`${GQL}/HomeTimeline`, { headers: HEADERS })),
    );
    await run(
      "fetch GET allowlisted, rate limited",
      fetchShape(() => fetch(`${GQL}/Bookmarks?fail=429`)),
    );
    await run(
      "fetch GET allowlisted, connection dropped",
      fetchShape(() => fetch(`${GQL}/Bookmarks?reset`)),
    );
    await run(
      "fetch GET not allowlisted, connection dropped",
      fetchShape(() => fetch(`${GQL}/HomeTimeline?reset`)),
    );
    await run(
      "fetch GET allowlisted, aborted before the response",
      fetchShape(() => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 150);
        return fetch(`${GQL}/Bookmarks?delay=500`, {
          signal: controller.signal,
        });
      }),
    );
    {
      const controller = new AbortController();
      await run(
        "fetch GET allowlisted, aborted while the body arrives",
        fetchShape(
          () =>
            fetch(`${GQL}/Bookmarks?slowbody`, { signal: controller.signal }),
          (response) => {
            setTimeout(() => controller.abort(), 100);
            return response.text();
          },
        ),
      );
    }

    // fetch mutations, every kind of body.
    const post =
      (body, extra = {}) =>
      () =>
        fetch(MUTATION, { method: "POST", body, headers: HEADERS, ...extra });
    await run(
      "fetch POST allowlisted mutation, string body",
      fetchShape(post(MUTATION_BODY)),
    );
    await run(
      "fetch POST allowlisted mutation, Blob body",
      fetchShape(post(bodies.Blob)),
    );
    await run(
      "fetch POST allowlisted mutation, ArrayBuffer body",
      fetchShape(post(bodies.ArrayBuffer)),
    );
    await run(
      "fetch POST allowlisted mutation, URLSearchParams body",
      fetchShape(() =>
        fetch(MUTATION, { method: "POST", body: bodies.URLSearchParams }),
      ),
    );
    await run(
      "fetch POST allowlisted mutation, stream body",
      fetchShape(
        post(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(MUTATION_BODY.slice(0, 20)));
              controller.enqueue(encoder.encode(MUTATION_BODY.slice(20)));
              controller.close();
            },
          }),
          { duplex: "half" },
        ),
      ),
    );
    await run(
      "fetch POST allowlisted mutation, Request object with a body",
      fetchShape(() =>
        fetch(
          new Request(MUTATION, {
            method: "POST",
            body: MUTATION_BODY,
            headers: HEADERS,
          }),
        ),
      ),
    );
    {
      const request = new Request(MUTATION, {
        method: "POST",
        body: MUTATION_BODY,
        headers: HEADERS,
      });
      const result = await fetchShape(() => fetch(request));
      // The page's own Request, after the fetch: used up by the browser, as
      // it would be anyway, and by nothing else first.
      result.requestBodyUsed = request.bodyUsed;
      shapes[
        "fetch POST allowlisted mutation, Request object kept by the page"
      ] = result;
    }
    // Request objects, which carry their body as a stream whatever it was
    // made from, so the hook reads them from a copy.
    const requestWith =
      (body, extra = {}) =>
      () =>
        fetch(
          new Request(MUTATION, {
            method: "POST",
            body,
            headers: HEADERS,
            ...extra,
          }),
        );
    await run(
      "fetch POST allowlisted mutation, Request object with a Blob body",
      fetchShape(requestWith(bodies.Blob)),
    );
    await run(
      "fetch POST allowlisted mutation, Request object with a URLSearchParams body",
      fetchShape(() =>
        fetch(
          new Request(MUTATION, {
            method: "POST",
            body: new URLSearchParams({ a: "1", b: "é" }),
          }),
        ),
      ),
    );
    await run(
      "fetch POST allowlisted mutation, Request object with a typed-array body",
      fetchShape(requestWith(new TextEncoder().encode(MUTATION_BODY))),
    );
    await run(
      "fetch POST allowlisted mutation, Request object with a stream body",
      fetchShape(
        requestWith(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(MUTATION_BODY.slice(0, 20)));
              controller.enqueue(encoder.encode(MUTATION_BODY.slice(20)));
              controller.close();
            },
          }),
          { duplex: "half" },
        ),
      ),
    );
    {
      // The page copies its own request before sending it, as a retry layer
      // might, and reads the copy afterwards.
      const request = new Request(MUTATION, {
        method: "POST",
        body: MUTATION_BODY,
        headers: HEADERS,
      });
      const kept = request.clone();
      const result = await fetchShape(() => fetch(request));
      result.keptCopy = await kept.text();
      shapes[
        "fetch POST allowlisted mutation, Request object the page copied first"
      ] = result;
    }
    await run(
      "fetch GET allowlisted, signal already aborted",
      fetchShape(() => fetch(BOOKMARKS, { signal: AbortSignal.abort() })),
    );
    await run(
      "fetch to another origin, which its lack of CORS headers refuses",
      fetchShape(() => fetch(`https://elsewhere.example${BOOKMARKS}`)),
    );
    await run(
      "fetch with a URL that cannot be fetched",
      fetchShape(() => fetch("https://x.com:99999/")),
    );
    await run(
      "fetch with no arguments",
      fetchShape(() => fetch()),
    );

    shapes["a page that has wrapped its own event plumbing"] =
      await instrumentedPage();

    return {
      shapes,
      unhandledRejections: await unhandledRejections(),
      functions: {
        open: shapeOf(XMLHttpRequest.prototype, "open"),
        send: shapeOf(XMLHttpRequest.prototype, "send"),
        fetch: shapeOf(window, "fetch"),
      },
      // What is known to differ with the extension loaded. The test pins
      // these too, so that the README's list of differences stays true.
      known: {
        sourceIsNative: [
          XMLHttpRequest.prototype.open,
          XMLHttpRequest.prototype.send,
          window.fetch,
        ].map((fn) =>
          Function.prototype.toString.call(fn).includes("[native code]"),
        ),
        // One event per allowlisted response, none for any other.
        hookEventHeard: await hookEventHeard(),
        extensionFrameInStack: (() => {
          try {
            new XMLHttpRequest().send();
            return "did not throw";
          } catch (error) {
            return String(error.stack).includes("chrome-extension://");
          }
        })(),
      },
    };
  };
})();
