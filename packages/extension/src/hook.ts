import { type CapturedOperation, capturedOperationOf } from "./operations.ts";
import type { CaptureProblem, HookEvent } from "./protocol.ts";

/** The parts of a page's `window` the hook touches. */
export interface HookTarget {
  XMLHttpRequest: { prototype: XMLHttpRequest };
  fetch: typeof fetch;
  location: { href: string };
}

interface WatchedRequest {
  operation: CapturedOperation;
  requestUrl: string;
  requestBody: string | null;
}

// Taken when the hook is installed, before any page script runs, so the
// wrappers never go through a `Reflect`, `Promise.prototype.then` or
// `addEventListener` that the page replaced later. Pages do wrap these, for
// error reporting among other things, and the hook must neither depend on
// such a wrapper nor show up in it as a call the page did not make.
const { apply } = Reflect;
const promiseThen = Promise.prototype.then;
const { addEventListener } = EventTarget.prototype;

/**
 * Wraps the page's `XMLHttpRequest` and `fetch` so that responses to the
 * allowlisted operations are reported to `emit`.
 *
 * The wrappers are read-only taps. Every call goes to the browser's own
 * function with the page's own `this` and arguments, and for a request that
 * is not allowlisted the page gets back exactly what that function returned;
 * the hook does nothing with it beyond reading the URL. The hook starts no
 * request and changes none. Nothing it does can throw into the page.
 *
 * Each wrapper is a method, written with the parameter count of the function
 * it stands in for, so that like the browser's own it has that `length` and
 * `name`, has no `prototype`, and cannot be constructed. What still differs
 * from the browser's functions is listed in the extension's README.
 */
export function installHook(
  target: HookTarget,
  emit: (event: HookEvent) => void,
): void {
  const report = (event: HookEvent): void => {
    try {
      emit(event);
    } catch {
      // A failure to report must never reach the page.
    }
  };
  const problem = (operation: CapturedOperation, detail: string): void =>
    report({ kind: "problem", problem: { operation, detail } });
  const watch = (url: unknown): WatchedRequest | undefined => {
    try {
      const requestUrl = new URL(String(url), target.location.href).href;
      const operation = capturedOperationOf(requestUrl);
      return operation && { operation, requestUrl, requestBody: null };
    } catch {
      return undefined;
    }
  };

  const xhr = target.XMLHttpRequest.prototype;
  const nativeOpen = xhr.open;
  const nativeSend = xhr.send;
  const nativeFetch = target.fetch;
  const watched = new WeakMap<XMLHttpRequest, WatchedRequest>();

  function onLoad(this: XMLHttpRequest): void {
    try {
      const request = watched.get(this);
      if (request === undefined) return;
      const unreadable = unreadableReason(this.status, this.responseType);
      if (unreadable !== undefined) {
        problem(request.operation, unreadable);
        return;
      }
      report({
        kind: "capture",
        capture: { ...request, payload: this.responseText },
      });
    } catch {
      // Reading the response failed; the page is unaffected.
    }
  }

  /** Reads a fetch response from a copy and reports it. Never throws. */
  function tap(request: WatchedRequest, body: unknown, response: Response) {
    try {
      const unreadable = unreadableReason(response.status, "");
      if (unreadable !== undefined) {
        problem(request.operation, unreadable);
        return;
      }
      // Copied now, before the page can start reading the original.
      const copy = response.clone();
      void (async () => {
        try {
          const payload = await copy.text();
          const requestBody = (await body) ?? null;
          report({
            kind: "capture",
            capture: {
              ...request,
              requestBody: typeof requestBody === "string" ? requestBody : null,
              payload,
            },
          });
        } catch {
          // The body failed or was aborted; the page sees that itself.
        }
      })();
    } catch {
      // The response could not be copied; the page still gets it.
    }
  }

  const wrappers = {
    // `arguments` and not rest parameters: the browser's function must see
    // the very arguments the page passed, however many, and a rest parameter
    // would change the wrapper's `length`.
    open(this: XMLHttpRequest, _method: string, url: string | URL): unknown {
      try {
        const request = watch(url);
        if (request === undefined) {
          watched.delete(this);
        } else {
          watched.set(this, request);
          // The same function every time, so a reused request gets one
          // listener.
          apply(addEventListener, this, ["load", onLoad]);
        }
      } catch {
        // Not a real request object; the browser's own open reports that.
      }
      // biome-ignore lint/complexity/noArguments: see the comment above.
      return apply(nativeOpen, this, arguments);
    },

    send(this: XMLHttpRequest): unknown {
      try {
        const request = watched.get(this);
        // biome-ignore lint/complexity/noArguments: see the comment above.
        const body: unknown = arguments[0];
        if (request !== undefined && typeof body === "string") {
          request.requestBody = body;
        }
      } catch {
        // Not a real request object; the browser's own send reports that.
      }
      // biome-ignore lint/complexity/noArguments: see the comment above.
      return apply(nativeSend, this, arguments);
    },

    fetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
      let request: WatchedRequest | undefined;
      let body: unknown;
      try {
        // biome-ignore lint/complexity/noArguments: see the comment above.
        const init: RequestInit | undefined = arguments[1];
        request = watch(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        // A Request's body can be read only before fetch consumes it, and
        // only from a copy, so the page's own Request stays untouched.
        if (request !== undefined) {
          if (typeof init?.body === "string") {
            body = init.body;
          } else if (init?.body === undefined && isRequestWithBody(input)) {
            body = readText(input.clone());
          }
        }
      } catch {
        // Arguments the hook cannot read are the browser's to accept or
        // reject.
        request = undefined;
      }
      // biome-ignore lint/complexity/noArguments: see the comment above.
      const response: Promise<Response> = apply(nativeFetch, this, arguments);
      if (request === undefined) return response;
      const watchedRequest = request;
      // The page gets a promise that follows the browser's: same response,
      // same rejection. Only a fulfilment handler is attached, so a rejection
      // the page leaves unhandled is still unhandled on the promise it holds,
      // and `unhandledrejection` fires as it would without the extension.
      return apply(promiseThen, response, [
        (received: Response) => {
          tap(watchedRequest, body, received);
          return received;
        },
      ]);
    },
  };

  xhr.open = wrappers.open as XMLHttpRequest["open"];
  xhr.send = wrappers.send as XMLHttpRequest["send"];
  target.fetch = wrappers.fetch;
}

function isRequestWithBody(input: RequestInfo | URL): input is Request {
  return (
    typeof input === "object" &&
    "clone" in input &&
    input.method !== "GET" &&
    input.method !== "HEAD"
  );
}

async function readText(request: Request): Promise<string | undefined> {
  try {
    return await request.text();
  } catch {
    return undefined;
  }
}

/** Why a response cannot be captured verbatim, or undefined when it can. */
function unreadableReason(
  status: number,
  responseType: XMLHttpRequestResponseType,
): CaptureProblem["detail"] | undefined {
  if (status < 200 || status >= 300) {
    return `X answered HTTP ${status}; nothing was captured.`;
  }
  if (responseType !== "" && responseType !== "text") {
    return `The response was requested as "${responseType}", so its text could not be read.`;
  }
  return undefined;
}
