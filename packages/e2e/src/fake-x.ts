/**
 * A fake X, and a fake everything else: the one server every hostname in the
 * test browser resolves to. It records each request in full, so a test can
 * say not only that nothing extra was sent but that what was sent is, byte
 * for byte and header for header, what the page sent.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  constants,
  createSecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from "node:http2";
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Appears only in responses the extension must ignore. */
export const NOT_ALLOWLISTED_MARKER = "MUST-NOT-BE-CAPTURED";
/** The body of every page served for a host other than x.com. */
export const OTHER_HOST_MARKER = "fake page for another host";

/**
 * The fake media CDN: the two hosts the library may have the browser load a
 * post's media from. Like every hostname here they lead to this server.
 */
export const MEDIA_HOSTS = {
  image: "pbs.twimg.com",
  video: "video.twimg.com",
} as const;
/** Asking a media host for this path sets `MEDIA_COOKIE` for that host. */
export const MEDIA_COOKIE_PATH = "/__cookie";
export const MEDIA_COOKIE = "media_session=fake";
/**
 * What the fake video host answers with: a clip that plays, nothing at all,
 * or the start of a clip that never continues, as on a connection that hangs.
 */
export type FakeVideo = "plays" | "missing" | "stalls";
/**
 * The clip: twelve seconds of a test pattern and a tone, 320 by 180, made by
 * ffmpeg from its own `testsrc2` and `sine` sources. It is WebM because the
 * test browser plays no H.264; the library asks for it by an address that
 * ends in `.mp4`, and the browser goes by what it is sent.
 */
const CLIP = readFileSync(new URL("clip.webm", import.meta.url));
/** A site whose page embeds `EMBEDDED_CONTROL_PATH` from the image host, plainly. */
export const EMBEDDER_HOST = "embedder.example";
export const EMBEDDED_CONTROL_PATH = "/__control.svg";

/**
 * Hosts Chromium itself calls, with or without any extension: its account
 * check, its component updater, and its autofill service, which it asks about
 * the shape of any form a page shows, the library's search field included.
 * Requests to them are the browser's own and are kept apart; a request to any
 * other host is a page's or the extension's.
 */
const CHROMIUM_OWN_HOSTS: readonly string[] = [
  "accounts.google.com",
  "update.googleapis.com",
  "content-autofill.googleapis.com",
];

export interface SeenRequest {
  scheme: "http" | "https";
  host: string;
  method: string;
  /** Path and query string. */
  path: string;
  /** Every header as sent, in order, HTTP/2 pseudo-headers included. */
  headers: [name: string, value: string][];
  /** The body, base64. */
  body: string;
}

// Shaped like the real timeline response, with what a JSON round-trip would
// damage: uneven whitespace, a sortIndex above 2^53, escapes, and non-ASCII
// text. The content is invented.
function timelinePage(label: string): string {
  return `{"data":{"bookmark_timeline_v2":{"timeline":{"instructions":[{"type":"TimelineAddEntries","entries":[
  { "entryId":"tweet-1861899614026727424", "sortIndex":1861899614026727424,
\t"content":{"itemContent":{"tweet_results":{"result":{"rest_id":"1861899614026727424","legacy":{"full_text":"${label}: caf\\u00e9 \u{1F516} ünïcode \\ud83d\\ude00","favorite_count":1.0}}}}} }
]}]}}}}\n`;
}

export const responses: Record<string, string> = {
  Bookmarks: timelinePage("bookmarks"),
  BookmarkFolderTimeline: timelinePage("folder"),
  BookmarkFoldersSlice: '{"data":{"viewer":{"user_results":{}}}}',
  CreateBookmark: '{"data":{"tweet_bookmark_put":"Done"}}',
  DeleteBookmark: '{"data":{"tweet_bookmark_delete":"Done"}}',
  HomeTimeline: `{"data":{"home":"${NOT_ALLOWLISTED_MARKER}"}}`,
  BookmarkSearchTimeline: `{"data":{"search":"${NOT_ALLOWLISTED_MARKER}"}}`,
};

/**
 * One page of the bookmarks timeline in the shape the real X sends, for the
 * `fixture` query parameter: a redacted real response, the fixture core's
 * parser is tested against. It is read as a file because it is data, and
 * core exports no fixtures outside its tests.
 */
export const realShapedPage = readFileSync(
  join(
    import.meta.dirname,
    "../../core/src/parsers/fixtures/x-web-client/Bookmarks/2026-10-12-text-posts.json",
  ),
  "utf8",
);

/** A response body of exactly `bytes` bytes, for the `size` query parameter. */
export function sizedResponse(bytes: number): string {
  const frame = '{"data":{"filler":""}}';
  return `{"data":{"filler":"${"x".repeat(bytes - frame.length)}"}}`;
}

// The page's own code, standing in for X's web client. `load()` returns what
// the page itself received, to show the extension changed nothing.
const pageScript = `
  window.load = (via, method, url, body) =>
    via === "fetch"
      ? fetch(url, { method, body }).then((response) => response.text())
      : new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open(method, url);
          xhr.onload = () => resolve(xhr.responseText);
          xhr.onerror = reject;
          xhr.send(body);
        });
`;

export function fakeXPages(shapesScript: string): Record<string, string> {
  return {
    "/home": `<!doctype html><title>fake x</title><script>${pageScript}</script><p>fake home</p>`,
    // Requests its first page from an inline script in <head>, the earliest a
    // page can ask, to show the hook is in place before any page script runs.
    "/i/bookmarks": `<!doctype html><title>fake x</title><script>${pageScript}
      window.firstPage = window.load("xhr", "GET", "/i/api/graphql/tF6KOjmZM0WGcB2Q0mfwhw/Bookmarks?variables=%7B%22count%22%3A20%7D&features=%7B%7D");
    </script><p>fake bookmarks</p>`,
    "/shapes": `<!doctype html><title>fake x</title><script>${shapesScript}</script><p>fake shapes</p>`,
  };
}

type AnyRequest = IncomingMessage | Http2ServerRequest;
type AnyResponse = ServerResponse | Http2ServerResponse;
/** What the HTTP/1.1 and HTTP/2 response objects have in common. */
interface Reply {
  writeHead(status: number, headers?: Record<string, string | string[]>): Reply;
  write(chunk: string | Uint8Array): unknown;
  end(chunk?: string | Uint8Array): unknown;
}

export async function startFakeX(directory: string, shapesScript: string) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=x.com",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const pages = fakeXPages(shapesScript);
  const seen: SeenRequest[] = [];
  const browserOwn: SeenRequest[] = [];
  /** How the media hosts answer. A test sets it before the press it is about. */
  const media: { video: FakeVideo } = { video: "plays" };

  async function handle(request: AnyRequest, raw: AnyResponse) {
    const response = raw as unknown as Reply;
    const scheme =
      "scheme" in request
        ? (request.scheme as "http" | "https")
        : (request.socket as { encrypted?: boolean }).encrypted
          ? "https"
          : "http";
    const host = String(request.headers[":authority"] ?? request.headers.host);
    const url = new URL(request.url ?? "/", `${scheme}://${host}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (url.pathname === "/favicon.ico") {
      // Asked for by the browser itself, not by a page or the extension.
      response.writeHead(204).end();
      return;
    }
    const headers: SeenRequest["headers"] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.push([
        String(request.rawHeaders[index]),
        String(request.rawHeaders[index + 1]),
      ]);
    }
    (CHROMIUM_OWN_HOSTS.includes(host) ? browserOwn : seen).push({
      scheme,
      host,
      method: request.method ?? "",
      path: url.pathname + url.search,
      headers,
      body: Buffer.concat(chunks).toString("base64"),
    });

    // Fixed, so that what a page reads from the headers is the same each run.
    const fixed = {
      date: "Mon, 12 Oct 2026 08:00:00 GMT",
      "cache-control": "no-store",
    };
    if (host === MEDIA_HOSTS.image || host === MEDIA_HOSTS.video) {
      if (url.pathname === MEDIA_COOKIE_PATH) {
        // A cookie for the media host that the browser would send with any
        // request to it, from any site, unless the request says not to.
        response.writeHead(200, {
          ...fixed,
          "content-type": "text/html",
          "set-cookie": [`${MEDIA_COOKIE}; Path=/; Secure; SameSite=None`],
        });
        response.end("<!doctype html><p>media cookie set</p>");
        return;
      }
      if (host === MEDIA_HOSTS.video && media.video !== "missing") {
        // The clip, whole or the part a `Range` asks for, as a CDN serves a
        // file a player may seek in.
        const [, first, last] =
          /^bytes=([0-9]+)-([0-9]*)$/.exec(
            String(request.headers.range ?? ""),
          ) ?? [];
        const from = Math.min(Number(first ?? 0), CLIP.length - 1);
        const to =
          last === undefined || last === ""
            ? CLIP.length - 1
            : Math.min(Number(last), CLIP.length - 1);
        response.writeHead(first === undefined ? 200 : 206, {
          ...fixed,
          "content-type": "video/webm",
          "accept-ranges": "bytes",
          "content-length": String(to - from + 1),
          ...(first === undefined
            ? {}
            : { "content-range": `bytes ${from}-${to}/${CLIP.length}` }),
          "access-control-allow-origin": "*",
        });
        if (media.video === "stalls") {
          // Too little to show a frame, and then nothing more.
          response.write(CLIP.subarray(from, Math.min(to + 1, from + 512)));
          return;
        }
        response.end(CLIP.subarray(from, to + 1));
        return;
      }
      // A picture any page may read. That the real CDN answers a request
      // without credentials this way is an assumption no test here can check,
      // since no test may ask it.
      response.writeHead(host === MEDIA_HOSTS.image ? 200 : 404, {
        ...fixed,
        "content-type": "image/svg+xml",
        "access-control-allow-origin": "*",
      });
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#888"/></svg>',
      );
      return;
    }
    if (host === EMBEDDER_HOST) {
      // The control: a page that embeds a picture from the media host the
      // ordinary way, to show what the browser sends when nothing stops it.
      response.writeHead(200, { ...fixed, "content-type": "text/html" });
      response.end(
        `<!doctype html><img src="https://${MEDIA_HOSTS.image}${EMBEDDED_CONTROL_PATH}" alt=""><p>embedder</p>`,
      );
      return;
    }
    if (host !== "x.com") {
      response.writeHead(200, { ...fixed, "content-type": "text/html" });
      response.end(`<!doctype html><p>${OTHER_HOST_MARKER}</p>`);
      return;
    }
    const page = pages[url.pathname];
    if (page !== undefined) {
      response.writeHead(200, {
        ...fixed,
        "content-type": "text/html; charset=utf-8",
        // What a logged-in session looks like to the requests that follow.
        "set-cookie": [
          "auth_token=fake-session; Path=/; Secure; HttpOnly",
          "ct0=fake-csrf; Path=/; Secure",
        ],
      });
      response.end(page);
      return;
    }
    const operation = url.pathname.split("/").at(-1) ?? "";
    const size = Number(url.searchParams.get("size"));
    const body = url.pathname.startsWith("/i/api/graphql/")
      ? size > 0
        ? sizedResponse(size)
        : url.searchParams.has("fixture")
          ? realShapedPage
          : responses[operation]
      : undefined;
    if (body === undefined) {
      response.writeHead(404, fixed).end();
      return;
    }
    await sleep(Number(url.searchParams.get("delay")));
    if (url.searchParams.has("reset") && "stream" in raw) {
      // The request dies without an answer, as on a dropped connection.
      raw.stream.close(constants.NGHTTP2_INTERNAL_ERROR);
      return;
    }
    if (url.searchParams.has("fail")) {
      response.writeHead(Number(url.searchParams.get("fail")), {
        ...fixed,
        "content-type": "text/plain; charset=utf-8",
        "x-rate-limit-limit": "50",
        "x-rate-limit-remaining": "0",
      });
      response.end("Rate limit exceeded");
      return;
    }
    response.writeHead(200, {
      ...fixed,
      "content-type": "application/json; charset=utf-8",
      "x-response-time": "12",
    });
    if (url.searchParams.has("slowbody")) {
      response.write(body.slice(0, 40));
      await sleep(600);
    }
    response.end(url.searchParams.has("slowbody") ? body.slice(40) : body);
  }
  const onRequest = (request: AnyRequest, response: AnyResponse) => {
    handle(request, response).catch(() => response.destroy());
  };

  const key = readFileSync(join(directory, "key.pem"));
  const cert = readFileSync(join(directory, "cert.pem"));
  // HTTP/2, as the real x.com speaks, and HTTP/1.1 for anything that asks.
  const secure = createSecureServer({ key, cert, allowHTTP1: true }, onRequest);
  const plain = createHttpServer(onRequest);
  // One port takes both: a TLS connection opens with byte 0x16.
  const sockets = new Set<Socket>();
  const front = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("readable", () => {
      const first: Buffer | null = socket.read(1);
      if (first === null) return;
      socket.unshift(first);
      (first[0] === 0x16 ? secure : plain).emit("connection", socket);
    });
    socket.on("error", () => {});
  });

  // A second site, standing in for any other page the user has open. Unlike
  // the fake X it is left in the loopback address space, where Chrome applies
  // no Local Network Access check, so its requests reach the app and it is
  // the app's own defences that are tested.
  const otherSite = createSecureServer(
    { key, cert, allowHTTP1: true },
    (_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>another site</title>");
    },
  );

  const listening = (target: typeof front | typeof otherSite) =>
    new Promise<number>((resolve) => {
      target.listen(0, "127.0.0.1", () =>
        resolve((target.address() as AddressInfo).port),
      );
    });
  const [port, otherSitePort] = await Promise.all([
    listening(front),
    listening(otherSite),
  ]);
  return {
    port,
    otherSitePort,
    /** Every request from a page or an extension, to any host. */
    seen,
    /** Chromium's own background requests. */
    browserOwn,
    media,
    close: () => {
      front.close();
      otherSite.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
