/**
 * End to end: the built extension, loaded in a real Chromium, captures from a
 * fake X and delivers to the real app, and the capture is read back from the
 * database.
 *
 * Nothing here can reach the real x.com, or any real site. Chromium is
 * started with a resolver rule that sends every hostname to a server in this
 * process, and the run stops before loading anything if that rule is not in
 * force.
 *
 * Nor does anything here touch an x-bookmarks that is in use on this machine.
 * The run builds the extension and the app into directories of its own, keeps
 * its database in a temporary directory, and starts its app on a free port.
 * The extension under test still asks for the app at its fixed address; the
 * same resolver rules send that address, in the test browser only, to the
 * test's app, and the run stops if they do not.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createTcpServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Bookmark,
  getBookmark,
  getCaptureParse,
  getRawCapture,
  insertRawCapture,
  listBookmarks,
  listParseIssues,
  listSnapshots,
  MAX_PAGE_SIZE,
  openStore,
  type PostContent,
  parsePendingCaptures,
  type RawCapture,
  type Store,
  searchBookmarks,
  summariseParsing,
  summariseRawCaptures,
} from "@x-bookmarks/core";
import {
  APP_HOST,
  APP_ORIGIN,
  APP_PORT,
  BODY_DIGEST_HEADER,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  INGEST_PATH,
  NONCE_HEADER,
  newNonce,
  PAIRING_PATH,
  SIGNATURE_SCHEME,
  sha256Hex,
  signRequest,
} from "@x-bookmarks/extension";
import {
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";
import {
  EMBEDDED_CONTROL_PATH,
  EMBEDDER_HOST,
  MEDIA_COOKIE,
  MEDIA_COOKIE_PATH,
  MEDIA_HOSTS,
  NOT_ALLOWLISTED_MARKER,
  OTHER_HOST_MARKER,
  realShapedPage,
  responses,
  type SeenRequest,
  sizedResponse,
  startFakeX,
} from "./fake-x.ts";

const repoRoot = join(import.meta.dirname, "../../..");
const webDirectory = join(repoRoot, "packages/web");
/** Next's build directory for this run, beside the one `pnpm app` serves from. */
const NEXT_DIRECTORY = ".next-e2e";
const shapesScript = readFileSync(
  join(import.meta.dirname, "shapes-page.js"),
  "utf8",
);

const GQL = "/i/api/graphql/tF6KOjmZM0WGcB2Q0mfwhw";
const BOOKMARKS = `${GQL}/Bookmarks?variables=%7B%22count%22%3A20%7D&features=%7B%7D`;
const MB = 1024 * 1024;
/** No single test takes this long; one that does has hung. */
const TEST_TIMEOUT_MS = 180_000;
/** The request shapes in shapes-page.js, and how many of them end in a capture. */
const SHAPES = 58;
const SHAPES_CAPTURED = 36;

// --- The real app ---------------------------------------------------------

/**
 * The port this run's app listens on: a free one, not `APP_PORT`, which an
 * app in real use may hold. Set before anything is started.
 */
let appPort = 0;
/** The app's address as the extension and every page know it. */
const APP_AUTHORITY = `${APP_HOST}:${APP_PORT}`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once("error", reject);
    probe.listen(0, APP_HOST, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function portIsOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(appPort, APP_HOST);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor<T>(
  what: string,
  check: () => Promise<T | false | undefined> | T | false | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== false && result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}.`, { cause: lastError });
}

const scratch = mkdtempSync(join(tmpdir(), "x-bookmarks-e2e-"));
const dataDirectory = join(scratch, "data");
const extensionDirectory = join(scratch, "extension");
const appEnvironment = {
  ...process.env,
  X_BOOKMARKS_DATA_DIR: dataDirectory,
  X_BOOKMARKS_NEXT_DIR: NEXT_DIRECTORY,
};
const nextBinary = join(webDirectory, "node_modules/next/dist/bin/next");

/** Builds the extension and the app into this run's own directories. */
function build(): void {
  execFileSync(process.execPath, ["build.ts", extensionDirectory], {
    cwd: join(repoRoot, "packages/extension"),
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync(process.execPath, [nextBinary, "build"], {
    cwd: webDirectory,
    env: appEnvironment,
    stdio: ["ignore", "ignore", "inherit"],
  });
}
let app: ChildProcess | undefined;

async function startApp(): Promise<void> {
  app = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", APP_HOST, "--port", String(appPort)],
    {
      cwd: webDirectory,
      env: appEnvironment,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  await waitFor("the app to listen", portIsOpen);
}

async function stopApp(): Promise<void> {
  const running = app;
  app = undefined;
  if (running === undefined || running.exitCode !== null) return;
  const exited = new Promise((resolve) => running.once("exit", resolve));
  running.kill("SIGTERM");
  await exited;
  await waitFor("the app's port to close", async () => !(await portIsOpen()));
}

/**
 * A request to the app from this process: a program, not a browser. It
 * connects to this run's port and names the app by its fixed address, as a
 * program reaching the app in real use would.
 */
function requestToApp(
  method: "GET" | "POST",
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `http://${APP_HOST}:${appPort}${path}`,
      { method, headers: { host: APP_AUTHORITY, ...headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

const postToApp = (
  path: string,
  body: string,
  headers: Record<string, string>,
) => requestToApp("POST", path, body, headers);

async function signedHeaders(token: string, path: string, body: string) {
  const nonce = newNonce();
  const bodyDigest = await sha256Hex(body);
  const signature = await signRequest(token, {
    method: "POST",
    path,
    nonce,
    bodyDigest,
  });
  return {
    authorization: `${SIGNATURE_SCHEME} ${signature}`,
    [NONCE_HEADER]: nonce,
    [BODY_DIGEST_HEADER]: bodyDigest,
    "content-type": "application/json",
  };
}

// --- The run --------------------------------------------------------------

let fakeX: Awaited<ReturnType<typeof startFakeX>>;
let context: BrowserContext;
let xPage: Page;
let popup: Page;
let token: string;
let store: Store | undefined;
/** What the pages of this run asked the fake X for, in order. */
const asked: Pick<SeenRequest, "method" | "path">[] = [];
/** Captures expected in the database so far. */
let expectedCaptures = 0;

function browserArguments(): string[] {
  return [
    // Every hostname is the fake server in this process, so that nothing can
    // reach a real site and a request to any host is seen by the test. The
    // app's own address is the one exception: it leads to this run's app, on
    // this run's port, and so never to an app in real use on the fixed one.
    // The first rule that matches applies.
    `--host-resolver-rules=MAP other-site.example 127.0.0.1:${fakeX.otherSitePort}, MAP ${APP_AUTHORITY} ${APP_HOST}:${appPort}, MAP * 127.0.0.1:${fakeX.port}`,
    // The fake server's certificate is self-signed.
    "--ignore-certificate-errors",
    // Treat the fake X as the public site the real one is, so that Chrome's
    // Local Network Access rules apply to it as they would to x.com.
    `--ip-address-space-overrides=127.0.0.1:${fakeX.port}=public`,
  ];
}

async function openPopup(): Promise<void> {
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
}

/** What the popup shows, as numbers. */
async function popupCounts(): Promise<Record<string, number>> {
  const read = async (id: string) =>
    Number(await popup.locator(`#${id}`).textContent());
  return {
    captured: await read("captured"),
    delivered: await read("delivered"),
    pending: await read("pending"),
    rejected: await read("rejected"),
  };
}

async function popupShows(
  expected: Record<string, number>,
  timeoutMs?: number,
): Promise<void> {
  let last: Record<string, number> = {};
  try {
    await waitFor(
      `the popup to show ${JSON.stringify(expected)}`,
      async () => {
        last = await popupCounts();
        return Object.entries(expected).every(
          ([key, value]) => last[key] === value,
        );
      },
      timeoutMs,
    );
  } catch (error) {
    throw new Error(
      `The popup shows ${JSON.stringify(last)}, expected ${JSON.stringify(expected)}; its error line reads "${await popup.locator("#last-error").textContent()}".`,
      { cause: error },
    );
  }
}

const pairing = () => popup.locator("#paired").getAttribute("data-pairing");
/** Waits for the popup's error line to read as expected. */
async function lastErrorMatches(expected: RegExp): Promise<void> {
  let last = "";
  try {
    await waitFor(`the popup's error line to match ${expected}`, async () => {
      last = (await popup.locator("#last-error").textContent()) ?? "";
      return expected.test(last);
    });
  } catch (error) {
    throw new Error(`The popup's error line reads "${last}".`, {
      cause: error,
    });
  }
}
const sendNow = () =>
  popup.getByRole("button", { name: "Send waiting captures now" }).click();

async function visit(path: string): Promise<void> {
  asked.push({ method: "GET", path });
  await xPage.goto(`https://x.com${path}`);
}

/** Has the page make a request, as X's client would, and returns what the page received. */
function load(
  via: "xhr" | "fetch",
  method: string,
  path: string,
  body?: string,
): Promise<string> {
  asked.push({ method, path });
  return xPage.evaluate(
    ([via, method, path, body]) =>
      (
        window as unknown as {
          load(...args: (string | undefined)[]): Promise<string>;
        }
      ).load(via, method, path, body),
    [via, method, path, body] as const,
  );
}

function storedCaptures(): RawCapture[] {
  store ??= openStore(join(dataDirectory, "bookmarks.db"));
  const { count } = summariseRawCaptures(store);
  return Array.from({ length: count }, (_, index) => {
    const capture = getRawCapture(store as Store, index + 1);
    assert.ok(capture, `raw capture ${index + 1} exists`);
    return capture;
  });
}

function storedCount(): number {
  store ??= openStore(join(dataDirectory, "bookmarks.db"));
  return summariseRawCaptures(store).count;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Shows that, in the test browser, the app's fixed address leads to this
 * run's port, and so never to an app in real use. It throws otherwise, which
 * fails the `before` hook: no test runs.
 */
async function appAddressLeadsHere(): Promise<void> {
  assert.notEqual(appPort, APP_PORT);
  const marker = `x-bookmarks e2e ${scratch}`;
  const standIn = createServer((request, response) => {
    response.end(`${marker} ${request.headers.host}`);
  });
  await new Promise<void>((resolve) =>
    standIn.listen(appPort, APP_HOST, resolve),
  );
  const page = await context.newPage();
  try {
    await page.goto(`${APP_ORIGIN}/`);
    // The stand-in answered, and was asked for the app by its fixed address.
    assert.equal(
      await page.locator("body").textContent(),
      `${marker} ${APP_AUTHORITY}`,
      "the resolver rule for the app's address is not in force, so the run stops here",
    );
  } finally {
    await page.close();
    standIn.closeAllConnections();
    await new Promise((resolve) => standIn.close(resolve));
  }
}

before(async () => {
  build();
  appPort = await freePort();
  fakeX = await startFakeX(scratch, shapesScript);
  context = await chromium.launchPersistentContext(join(scratch, "profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      ...browserArguments(),
    ],
  });
  context.setDefaultTimeout(20_000);
  await appAddressLeadsHere();
});

after(async () => {
  store?.close();
  await context?.close();
  await stopApp();
  fakeX?.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("the browser cannot reach any real site: every hostname is the fake", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  for (const url of ["https://example.com/", "http://api.x.com/1.1/"]) {
    const page = await context.newPage();
    await page.goto(url);
    assert.equal(
      await page.locator("p").textContent(),
      OTHER_HOST_MARKER,
      "the resolver rule is not in force, so the run stops here",
    );
    await page.close();
  }
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  assert.equal(await page.locator("p").textContent(), "fake home");
  await page.close();

  assert.deepEqual(
    fakeX.seen.map(({ scheme, host, path }) => `${scheme}://${host}${path}`),
    ["https://example.com/", "http://api.x.com/1.1/", "https://x.com/home"],
  );
  fakeX.seen.length = 0;
});

test("the extension loads under its fixed id, unpaired", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  assert.equal(new URL(worker.url()).host, EXTENSION_ID);
  await openPopup();
  await popupShows({ captured: 0, delivered: 0, pending: 0, rejected: 0 });
  assert.equal(await pairing(), "none");
});

test("with the app closed, a capture made after in-app navigation waits in the extension", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  xPage = await context.newPage();
  await visit("/home");

  // Not allowlisted: must leave no trace anywhere.
  const home = await load("xhr", "GET", "/i/api/graphql/abc123/HomeTimeline");
  assert.ok(home.includes(NOT_ALLOWLISTED_MARKER));
  await popupShows({ captured: 0, pending: 0 });

  // The single-page app moves to the bookmarks page without a page load.
  await xPage.evaluate(() => history.pushState({}, "", "/i/bookmarks"));
  const received = await load("xhr", "GET", BOOKMARKS);

  assert.equal(
    received,
    responses.Bookmarks,
    "the page got X's response unchanged",
  );
  await popupShows({ captured: 1, delivered: 0, pending: 1 });
  await lastErrorMatches(/Not paired/);
});

test("the pairing token comes from the terminal and is on no page of the app", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await startApp();
  const printed = execFileSync(process.execPath, ["pair.ts"], {
    cwd: webDirectory,
    env: appEnvironment,
    encoding: "utf8",
  });
  token = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(printed)?.[1] ?? "";
  assert.notEqual(token, "", `pnpm pair printed no token:\n${printed}`);

  for (const path of [
    "/",
    "/status",
    "/pair",
    "/pair?_rsc=1",
    "/api/pairing",
    "/api/library",
  ]) {
    const response = await requestToApp("GET", path);
    assert.ok(response.status > 0, `${path} answered`);
    assert.ok(
      !response.body.includes(token),
      `${path} must not contain the token`,
    );
  }
});

test("before the first capture arrives the library is empty, says how it fills, and reports nothing wrong", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const page = await context.newPage();
  await page.goto(APP_ORIGIN);

  await page.getByText("No bookmarks yet").waitFor();
  assert.equal(
    await page
      .getByRole("main")
      .getByRole("link", { name: "Pair the extension" })
      .getAttribute("href"),
    "/pair",
  );
  const status = page.getByTestId("status-line");
  assert.equal(await status.getAttribute("data-level"), "ok");
  assert.match((await status.textContent()) ?? "", /No captures yet/);
  assert.equal(await page.getByTestId("status-banner").count(), 0);
  assert.equal(await page.locator("[data-post]").count(), 0);
  await page.close();
});

test("after pairing, the waiting capture reaches the database byte for byte, dated when it was captured", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const before = Date.now();
  await popup.locator("#token").fill(token);
  await popup.getByRole("button", { name: "Pair" }).click();

  await popupShows({ captured: 1, delivered: 1, pending: 0, rejected: 0 });
  assert.equal(await pairing(), "paired");
  assert.equal(await popup.locator("#last-error").isHidden(), true);

  const [capture, ...others] = storedCaptures();
  expectedCaptures = 1;
  assert.equal(others.length, 0);
  assert.ok(capture);
  assert.deepEqual(
    Buffer.from(capture.payload, "utf8"),
    Buffer.from(responses.Bookmarks ?? "", "utf8"),
    "the stored payload is the bytes the fake X served",
  );
  assert.equal(capture.source, "x-web-client");
  assert.equal(capture.operation, "Bookmarks");
  assert.equal(capture.requestUrl, `https://x.com${BOOKMARKS}`);
  assert.equal(capture.requestBody, null);
  // Taken in the previous test, before pairing: not the delivery time.
  assert.ok(capture.receivedAt.getTime() < before);
  assert.ok(capture.receivedAt.getTime() > before - 120_000);
});

test("with the app running, fetch and mutation captures arrive at once, and other requests never do", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const folder = await load(
    "fetch",
    "GET",
    "/i/api/graphql/KJIQpsvxrTfRIlbaRIySHQ/BookmarkFolderTimeline?variables=%7B%22bookmark_collection_id%22%3A%221%22%7D",
  );
  const mutationBody =
    '{"variables":{ "tweet_id":"1861899614026727424" },"queryId":"aoDbu3RHznuiSkQ9aNM67Q"}';
  await load(
    "xhr",
    "POST",
    "/i/api/graphql/aoDbu3RHznuiSkQ9aNM67Q/CreateBookmark",
    mutationBody,
  );
  await load("fetch", "GET", "/i/api/graphql/abc123/HomeTimeline");
  await load("xhr", "GET", "/i/api/graphql/abc123/BookmarkSearchTimeline");

  assert.equal(folder, responses.BookmarkFolderTimeline);
  await popupShows({ captured: 3, delivered: 3, pending: 0, rejected: 0 });

  const captures = storedCaptures();
  expectedCaptures = 3;
  assert.deepEqual(
    captures.map(({ operation }) => operation),
    ["Bookmarks", "BookmarkFolderTimeline", "CreateBookmark"],
  );
  assert.equal(captures[1]?.payload, responses.BookmarkFolderTimeline);
  assert.equal(captures[2]?.payload, responses.CreateBookmark);
  assert.equal(captures[2]?.requestBody, mutationBody);
  for (const capture of captures) {
    assert.ok(!capture.payload.includes(NOT_ALLOWLISTED_MARKER));
  }
});

test("a full page load of the bookmarks page is captured from its very first request", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await visit("/i/bookmarks");
  asked.push({ method: "GET", path: BOOKMARKS });
  const received = await xPage.evaluate(
    () => (window as unknown as { firstPage: Promise<string> }).firstPage,
  );

  assert.equal(received, responses.Bookmarks);
  expectedCaptures = 4;
  await popupShows({ captured: 4, delivered: 4, pending: 0 });
});

test("while the app is closed, another program on its port is sent no capture and no secret, and deletes nothing", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await stopApp();
  const received: string[] = [];
  const squatter = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push(
        [
          request.method,
          request.url,
          JSON.stringify(request.headers),
          Buffer.concat(chunks).toString(),
        ].join("\n"),
      );
      // Exactly what the app answers to a stored capture, minus the proof it
      // cannot make.
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"status":"stored","id":"anything"}');
    });
  });
  await new Promise<void>((resolve) =>
    squatter.listen(appPort, APP_HOST, resolve),
  );

  await load("xhr", "GET", `${GQL}/Bookmarks?cursor=while-squatted`);
  await sendNow();
  await popupShows({ captured: 5, delivered: 4, pending: 1 });

  await lastErrorMatches(/did not prove it holds this pairing token/);
  assert.equal(await pairing(), "refused");
  assert.ok(received.length > 0, "the squatter was contacted");
  for (const request of received) {
    assert.match(request, /^POST\n\/api\/pairing\n/, "only the opening check");
    assert.ok(!request.includes(token), "the token is never sent");
    assert.ok(!request.includes("bookmark_timeline_v2"), "no payload is sent");
  }

  squatter.closeAllConnections();
  await new Promise((resolve) => squatter.close(resolve));
});

test("captures taken while the app was away are delivered once it is back, each exactly once", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await sendNow();
  await popupShows({ captured: 5, delivered: 4, pending: 1 });
  await lastErrorMatches(/did not answer/);

  await startApp();
  await sendNow();

  await popupShows({ captured: 5, delivered: 5, pending: 0, rejected: 0 });
  assert.equal(await pairing(), "paired");
  expectedCaptures = 5;
  const captures = storedCaptures();
  assert.equal(captures.length, 5);
  assert.equal(new Set(captures.map(({ captureKey }) => captureKey)).size, 5);
});

test("a capture larger than the 10 MB at which Next would cut a request body is stored whole", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const size = 12 * MB;
  const received = await load("xhr", "GET", `${GQL}/Bookmarks?size=${size}`);
  assert.equal(Buffer.byteLength(received), size);

  expectedCaptures = 6;
  await popupShows({ captured: 6, delivered: 6, pending: 0, rejected: 0 });
  const stored = storedCaptures().at(-1);
  assert.equal(Buffer.byteLength(stored?.payload ?? ""), size);
  assert.equal(sha256(stored?.payload ?? ""), sha256(sizedResponse(size)));
});

test("a service worker stopped in the middle of a delivery leaves a queue that drains unaided", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  // Enough, and large enough, that delivering them takes a while.
  const total = 40;
  await stopApp();
  for (let index = 0; index < total; index++) {
    await load("xhr", "GET", `${GQL}/Bookmarks?size=${MB}&n=${index}`);
  }
  await popupShows({ captured: 6 + total, pending: total }, 60_000);
  await startApp();

  // DevTools' own control over the worker, reached through a page of the
  // extension that runs no script and so never wakes it.
  const bystander = await context.newPage();
  await bystander.goto(`chrome-extension://${EXTENSION_ID}/manifest.json`);
  const devtools = await context.newCDPSession(bystander);
  const states: string[] = [];
  let versionId: string | undefined;
  devtools.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
    for (const version of versions) {
      versionId = version.versionId;
      if (states.at(-1) !== version.runningStatus) {
        states.push(version.runningStatus);
      }
    }
  });
  await devtools.send("ServiceWorker.enable");
  await waitFor("the worker to be listed", () => versionId !== undefined);

  // Start the delivery, let it get under way, then stop the worker, as
  // Chrome may at any time. The popup is closed first: it asks the worker for
  // its status every two seconds, and that would start the worker again.
  await sendNow();
  await waitFor("the delivery to get under way", () => storedCount() > 6 + 2);
  await popup.close();
  states.length = 0;
  await devtools.send("ServiceWorker.stopWorker", {
    versionId: versionId ?? "",
  });
  await waitFor("the worker to stop", () => states.includes("stopped"));
  const atStop = storedCount();
  assert.ok(
    atStop < 6 + total,
    `the worker was stopped mid-delivery (${atStop - 6} of ${total} delivered)`,
  );
  await sleep(3000);
  assert.equal(
    storedCount(),
    atStop,
    "with the worker stopped, nothing is delivering",
  );
  assert.equal(states.at(-1), "stopped");

  // Nothing touches the extension from here: no page, no popup, no capture.
  // Only its retry alarm can finish the job.
  await waitFor(
    "the rest of the queue to be delivered by the retry alarm",
    () => storedCount() === 6 + total,
    100_000,
  );
  expectedCaptures = 6 + total;
  const keys = storedCaptures().map(({ captureKey }) => captureKey);
  assert.equal(new Set(keys).size, expectedCaptures, "each stored once");
  assert.ok(states.includes("running"), "the alarm started the worker again");
  await bystander.close();

  await openPopup();
  await popupShows({
    captured: expectedCaptures,
    delivered: expectedCaptures,
    pending: 0,
    rejected: 0,
  });
});

test("a page script that forges the hook's event can plant a capture, but only one dated now", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const before = Date.now();
  await xPage.evaluate(() => {
    const fire = (event: unknown) =>
      window.dispatchEvent(
        new CustomEvent("x-bookmarks:hook", { detail: JSON.stringify(event) }),
      );
    const forged = {
      operation: "Bookmarks",
      requestUrl: "https://x.com/i/api/graphql/forged/Bookmarks",
      requestBody: null,
      payload: '{"forged":true}',
      // Every way a script might try to date it.
      capturedAt: Date.parse("2017-01-01T00:00:00Z"),
      receivedAt: Date.parse("2017-01-01T00:00:00Z"),
    };
    // Off the allowlist, and malformed: dropped.
    fire({
      kind: "capture",
      capture: {
        ...forged,
        operation: "HomeTimeline",
        requestUrl: "https://x.com/i/api/graphql/forged/HomeTimeline",
      },
    });
    fire({ kind: "capture", capture: { ...forged, payload: { a: 1 } } });
    window.dispatchEvent(
      new CustomEvent("x-bookmarks:hook", { detail: forged }),
    );
    // Well-formed: accepted, which is the limit of what this route can check.
    fire({ kind: "capture", capturedAt: forged.capturedAt, capture: forged });
  });

  expectedCaptures += 1;
  await popupShows({ captured: expectedCaptures, delivered: expectedCaptures });
  const captures = storedCaptures();
  assert.equal(captures.length, expectedCaptures);
  const planted = captures.at(-1);
  assert.equal(planted?.payload, '{"forged":true}');
  const storedAt = planted?.receivedAt.getTime() ?? 0;
  assert.ok(
    storedAt >= before && storedAt <= Date.now(),
    `the forged capture is dated ${planted?.receivedAt.toISOString()}, not 2017`,
  );
});

test("a program on this computer cannot write to the app without the token file, whatever headers it forges", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const delivered = storedCaptures()[0];
  assert.ok(delivered);
  const body = JSON.stringify({
    id: delivered.captureKey,
    operation: delivered.operation,
    requestUrl: delivered.requestUrl,
    requestBody: delivered.requestBody,
    payload: delivered.payload,
    capturedAt: delivered.receivedAt.getTime(),
  });
  const fresh = JSON.stringify({
    ...JSON.parse(body),
    id: "7c1f0d52-3b7e-4f0a-8d2c-5e6f7a8b9c0d",
  });
  const forgedOrigin = { origin: EXTENSION_ORIGIN };
  const signedWith = async (key: string, path: string, text: string) => ({
    ...forgedOrigin,
    ...(await signedHeaders(key, path, text)),
  });

  const attempts = {
    "no credentials": await postToApp(INGEST_PATH, fresh, {
      ...forgedOrigin,
      "content-type": "application/json",
    }),
    "a guessed token as a bearer": await postToApp(INGEST_PATH, fresh, {
      ...forgedOrigin,
      authorization: "Bearer guess",
      "content-type": "application/json",
    }),
    "a signature made with a guessed token": await postToApp(
      INGEST_PATH,
      fresh,
      await signedWith("a".repeat(43), INGEST_PATH, fresh),
    ),
    "a real signature replayed for another body": await postToApp(
      INGEST_PATH,
      fresh,
      await signedWith(token, INGEST_PATH, body),
    ),
    "a real signature without the extension's origin": await postToApp(
      INGEST_PATH,
      fresh,
      await signedHeaders(token, INGEST_PATH, fresh),
    ),
    "the pairing check, unsigned": await postToApp(PAIRING_PATH, "{}", {
      ...forgedOrigin,
    }),
  };

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(attempts).map(([name, { status }]) => [name, status]),
    ),
    {
      "no credentials": 401,
      "a guessed token as a bearer": 401,
      "a signature made with a guessed token": 401,
      // Let past the signature check, which covers the headers, and
      // refused as soon as the body is seen not to be the one signed.
      "a real signature replayed for another body": 400,
      "a real signature without the extension's origin": 403,
      "the pairing check, unsigned": 401,
    },
  );
  for (const { body: answer } of Object.values(attempts)) {
    assert.ok(!answer.includes(token));
  }
  assert.equal(storedCount(), expectedCaptures);

  // What is not defended, stated as a test: a program that can read the
  // token file, which means one running as this user, can sign as the
  // extension. Re-sending a delivered capture stores nothing new.
  const withTheFile = await postToApp(
    INGEST_PATH,
    body,
    await signedWith(token, INGEST_PATH, body),
  );
  assert.deepEqual(
    [withTheFile.status, JSON.parse(withTheFile.body)],
    [200, { status: "duplicate", id: delivered.captureKey }],
  );
  assert.equal(storedCount(), expectedCaptures);
});

test("a web page cannot write to the app, even with a valid signature in hand", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const body = JSON.stringify({
    id: "7c1f0d52-3b7e-4f0a-8d2c-5e6f7a8b9c0d",
    operation: "Bookmarks",
    requestUrl: "https://x.com/i/api/graphql/abc/Bookmarks",
    requestBody: null,
    payload: '{"forged":true}',
    capturedAt: Date.now(),
  });
  const signed = await signedHeaders(token, INGEST_PATH, body);
  const attack = (page: Page) =>
    page.evaluate(
      async ([url, signed, body]) => {
        const attempt = async (init: RequestInit) => {
          try {
            const response = await fetch(url, {
              method: "POST",
              body,
              ...init,
            });
            return `${response.type} ${response.status}`;
          } catch {
            return "blocked";
          }
        };
        return {
          loopbackPermission: await navigator.permissions
            .query({ name: "loopback-network" as PermissionName })
            .then(({ state }) => state as string),
          // A "simple" request: sent without a preflight, answer unreadable.
          simple: await attempt({
            mode: "no-cors",
            headers: { "content-type": "text/plain" },
          }),
          // Fully signed: the browser must ask the app's leave first.
          signed: await attempt({ headers: signed }),
        };
      },
      [`${APP_ORIGIN}${INGEST_PATH}`, signed, body] as const,
    );
  // How each request ended, seen from the network rather than from the page,
  // which is told nothing.
  const networkOutcomes = async (page: Page, run: () => Promise<unknown>) => {
    const outcomes: string[] = [];
    const isIngest = (url: string) => url === `${APP_ORIGIN}${INGEST_PATH}`;
    page.on("response", (response) => {
      if (isIngest(response.url())) outcomes.push(`HTTP ${response.status()}`);
    });
    page.on("requestfailed", (request) => {
      if (isIngest(request.url())) {
        outcomes.push(request.failure()?.errorText ?? "failed");
      }
    });
    return { page: await run(), network: outcomes };
  };

  // From a public site, as x.com is: Chrome's Local Network Access check
  // stops both requests before they are sent, because the site holds no
  // permission. The extension's deliveries above needed none.
  const refusedUnseen = {
    loopbackPermission: "prompt",
    simple: "blocked",
    signed: "blocked",
  };
  assert.deepEqual(await networkOutcomes(xPage, () => attack(xPage)), {
    page: refusedUnseen,
    // Neither request got as far as an answer.
    network: ["net::ERR_FAILED", "net::ERR_FAILED"],
  });

  // From a site Chrome lets through: the simple request reaches the app, is
  // refused there, and the refusal is then withheld from the page. The
  // signed one dies at the preflight, which the app refuses.
  const otherSite = await context.newPage();
  await otherSite.goto("https://other-site.example/");
  const fromOtherSite = await networkOutcomes(otherSite, () =>
    attack(otherSite),
  );
  await otherSite.close();
  assert.deepEqual(fromOtherSite, {
    page: refusedUnseen,
    network: ["net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin", "net::ERR_FAILED"],
  });

  assert.equal(storedCount(), expectedCaptures);
});

test("the extension's script inside an x.com tab can reach neither the queue, the token nor the popup's controls", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  // The relay's isolated world, entered through DevTools: the most a script
  // could get by breaking into the extension's side of the page.
  const devtools = await context.newCDPSession(xPage);
  const worlds: { id: number; auxData?: { type?: string } }[] = [];
  devtools.on("Runtime.executionContextCreated", ({ context }) =>
    worlds.push(context),
  );
  await devtools.send("Runtime.enable");
  const relayWorld = await waitFor("the relay's world to be listed", () =>
    worlds.find(({ auxData }) => auxData?.type === "isolated"),
  );
  const evaluate = async (expression: string) => {
    const { result } = await devtools.send("Runtime.evaluate", {
      contextId: relayWorld.id,
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.value as unknown;
  };

  assert.equal(await evaluate("typeof chrome.runtime.sendMessage"), "function");
  assert.match(
    String(
      await evaluate(
        "chrome.storage.local.get(null).then((all) => 'read ' + Object.keys(all).length + ' keys', (error) => 'denied: ' + error.message)",
      ),
    ),
    /^denied: /,
  );
  for (const message of [
    '{ type: "get-status" }',
    '{ type: "set-token", token: "attacker" }',
    '{ type: "deliver-now" }',
  ]) {
    // The worker answers with nothing, which arrives as null.
    assert.equal(
      await evaluate(
        `chrome.runtime.sendMessage(${message}).then((reply) => reply ?? "no answer")`,
      ),
      "no answer",
      message,
    );
  }
  await devtools.detach();
  assert.equal(await pairing(), "paired", "the token was not replaced");
});

test("the fake saw the pages' own requests to X and nothing else to any host", {
  timeout: TEST_TIMEOUT_MS,
}, () => {
  assert.deepEqual(
    fakeX.seen.map(({ scheme, host, method, path }) => ({
      to: `${scheme}://${host}`,
      method,
      path,
    })),
    asked.map((request) => ({ to: "https://x.com", ...request })),
  );
  fakeX.seen.length = 0;
});

test("every shape of request reaches X identically, and reads identically to the page, with and without the extension", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  interface ShapesResult {
    shapes: Record<string, unknown>;
    unhandledRejections: string[];
    functions: Record<string, unknown>;
    known: {
      sourceIsNative: boolean[];
      hookEventHeard: string[];
      extensionFrameInStack: boolean;
    };
  }
  const runShapes = async (page: Page) => {
    fakeX.seen.length = 0;
    await page.goto("https://x.com/shapes");
    const result = await page.evaluate(() =>
      (window as unknown as { runShapes(): Promise<unknown> }).runShapes(),
    );
    // A multipart boundary is random by design; everything else must match.
    const boundary = /----WebKitFormBoundary[A-Za-z0-9]{16}/g;
    const requests = fakeX.seen.splice(0).map((request) => ({
      ...request,
      headers: request.headers.map(([name, value]) => [
        name,
        value.replace(boundary, "(boundary)"),
      ]),
      body: Buffer.from(request.body, "base64")
        .toString("latin1")
        .replace(boundary, "(boundary)"),
    }));
    return { result: result as ShapesResult, requests };
  };

  // The same Chromium with the same flags, minus the extension.
  const plain = await chromium.launchPersistentContext(
    join(scratch, "profile-without-extension"),
    { channel: "chromium", headless: true, args: browserArguments() },
  );
  const plainPage = await plain.newPage();
  // Signed in, as the other browser's pages are, before the shapes run.
  await plainPage.goto("https://x.com/home");
  const without = await runShapes(plainPage);
  await plain.close();
  const before = storedCount();
  const withExtension = await runShapes(xPage);

  // The suite is only worth something if it really exercised the shapes.
  const names = Object.keys(without.result.shapes);
  assert.equal(names.length, SHAPES, "every shape ran");
  assert.ok(without.requests.length >= names.length - 10);
  for (const request of without.requests) {
    // One shape goes to another origin on purpose; the rest are X's own.
    if (request.host === "elsewhere.example") continue;
    assert.equal(request.host, "x.com");
    assert.ok(
      request.headers.some(([name]) => name === "cookie"),
      `${request.method} ${request.path} carries the session cookies`,
    );
  }

  // What X received: the same requests, in the same order, with the same
  // headers in the same order and the same bodies.
  assert.equal(withExtension.requests.length, without.requests.length);
  withExtension.requests.forEach((request, index) => {
    assert.deepEqual(
      request,
      without.requests[index],
      `request ${index + 1}, ${request.method} ${request.path}`,
    );
  });

  // What the page observed: statuses, headers, bodies by every way of
  // reading them, event sequences, errors, and unhandled rejections.
  for (const name of names) {
    assert.deepEqual(
      withExtension.result.shapes[name],
      without.result.shapes[name],
      name,
    );
  }
  assert.deepEqual(
    withExtension.result.unhandledRejections,
    without.result.unhandledRejections,
  );
  assert.equal(without.result.unhandledRejections.length, 2);
  // The wrappers' name, length, own properties, property flags and refusal
  // to be constructed are those of the browser's functions.
  assert.deepEqual(withExtension.result.functions, without.result.functions);

  // The differences that remain, pinned so the README's list stays true.
  assert.deepEqual(without.result.known, {
    sourceIsNative: [true, true, true],
    hookEventHeard: [],
    extensionFrameInStack: false,
  });
  assert.deepEqual(withExtension.result.known, {
    sourceIsNative: [false, false, false],
    hookEventHeard: ["string"],
    extensionFrameInStack: true,
  });

  // And the extension did capture while all this went through it: every
  // allowlisted response it could read as text, and nothing else.
  await waitFor(
    "the shapes' captures to be stored",
    () => storedCount() >= before + SHAPES_CAPTURED,
  );
  await sleep(1000);
  assert.equal(storedCount(), before + SHAPES_CAPTURED);
  expectedCaptures = before + SHAPES_CAPTURED;
  await popupShows({ delivered: expectedCaptures, pending: 0, rejected: 0 });
});

test("a real-shaped bookmarks page becomes bookmarks, and a response the parser cannot read is kept and recorded", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await visit("/home");
  const received = await load("xhr", "GET", `${GQL}/Bookmarks?fixture=1`);
  assert.equal(received, realShapedPage);
  expectedCaptures += 1;
  await popupShows({ delivered: expectedCaptures, pending: 0, rejected: 0 });

  const captures = storedCaptures();
  const page = captures.at(-1);
  assert.equal(page?.payload, realShapedPage);
  store ??= openStore(join(dataDirectory, "bookmarks.db"));
  assert.partialDeepStrictEqual(getCaptureParse(store, page?.id ?? 0), {
    outcome: "parsed",
    bookmarkCount: 5,
    failedEntryCount: 0,
    warningCount: 0,
  });
  const secondPost: string =
    JSON.parse(
      realShapedPage,
    ).data.bookmark_timeline_v2.timeline.instructions[0].entries[1].entryId.slice(
      6,
    );
  const bookmark = getBookmark(store, secondPost);
  assert.match(bookmark?.authorHandle ?? "", /^[a-z]+$/);
  assert.equal(bookmark?.card?.domain, "site6.example");
  assert.deepEqual(bookmark?.firstSeenAt, page?.receivedAt);

  // Everything else this run captured is the fake X's invented shape, a
  // mutation, or an operation with no parser: a timeline whose one entry is
  // not a post the parser knows, a response that is no timeline at all, a
  // folder's timeline. Each was stored first and then recorded as what it
  // is, and none became a bookmark.
  const summary = summariseParsing(store);
  assert.equal(summary.bookmarks, 5);
  assert.equal(summary.captures.pending, 0);
  assert.equal(
    summary.captures.parsed +
      summary.captures.failed +
      summary.captures.noParser,
    expectedCaptures,
  );
  assert.ok(summary.failedEntries > 0, "entries that failed are counted");
  assert.ok(summary.captures.failed > 0, "captures that failed are counted");
  assert.ok(
    summary.captures.noParser > 0,
    "captures with no parser are counted",
  );
});

test("the status page reports what arrived", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const status = await context.newPage();
  await status.goto(`${APP_ORIGIN}/status`);
  assert.equal(
    await status.getByTestId("capture-count").textContent(),
    String(expectedCaptures),
  );
  assert.notEqual(
    await status.getByTestId("last-capture").textContent(),
    "none yet",
  );
  const shown = async (id: string) =>
    Number(await status.getByTestId(id).textContent());
  store ??= openStore(join(dataDirectory, "bookmarks.db"));
  const summary = summariseParsing(store);
  assert.deepEqual(
    {
      bookmarks: await shown("bookmark-count"),
      parsed: await shown("captures-parsed"),
      failed: await shown("captures-failed"),
      noParser: await shown("captures-no-parser"),
      failedEntries: await shown("entries-failed"),
      waiting: await shown("captures-waiting"),
    },
    {
      bookmarks: 5,
      parsed: summary.captures.parsed,
      failed: summary.captures.failed,
      noParser: summary.captures.noParser,
      failedEntries: summary.failedEntries,
      waiting: 0,
    },
  );
  assert.notEqual(
    await status.getByTestId("last-parsed").textContent(),
    "none yet",
  );
  console.log(
    `Chromium ${context.browser()?.version() ?? "(version unknown)"}`,
  );
  await status.close();
});

test("the status page shows the library's backups, and every screen says so when one fails", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  // The app took a snapshot the first time it started with captures stored,
  // and none when it was restarted minutes later: one a day at most. They go
  // into this run's own directory: the data directory was moved, so its
  // snapshots are inside it and not beside the repo.
  const snapshots = join(dataDirectory, "backups");
  const [atStart] = listSnapshots(snapshots);
  assert.ok(atStart !== undefined, "the app took a snapshot when it started");
  const restored = openStore(atStart.path, { readOnly: true });
  const inSnapshot = summariseRawCaptures(restored).count;
  restored.close();
  assert.ok(inSnapshot > 0 && inSnapshot < expectedCaptures);

  const status = await context.newPage();
  const shown = async (id: string) =>
    (await status.getByTestId(id).textContent()) ?? "";
  await status.goto(`${APP_ORIGIN}/status`);
  assert.equal(await shown("backup-count"), "1");
  assert.match(
    await shown("backup-last-check"),
    /the latest snapshot is less than a day old$/,
  );
  assert.equal(await shown("backup-directory"), snapshots);
  assert.equal(await status.getByTestId("backup-failure").count(), 0);

  // `pnpm backup`: captures have arrived since, so there is something new.
  const printed = execFileSync(process.execPath, ["backup.ts"], {
    cwd: webDirectory,
    env: appEnvironment,
    encoding: "utf8",
  });
  assert.match(printed, /Snapshot written and verified: /);
  assert.match(printed, new RegExp(`${expectedCaptures} raw captures`));
  await status.reload();
  assert.equal(await shown("backup-count"), "2");
  // While the backups work, the library itself says nothing about them.
  await status.goto(APP_ORIGIN);
  await status.getByTestId("status-line").waitFor();
  assert.equal(await status.getByTestId("backup-banner").count(), 0);

  await status.close();

  // A second app on the same library, started where it cannot write its
  // snapshots: it still runs, its status page says that the library is not
  // being backed up, and so does the library, in its banner and in the
  // status line that leads to that page.
  const blocked = join(scratch, "a-file");
  writeFileSync(blocked, "");
  const port = await freePort();
  const second = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", APP_HOST, "--port", String(port)],
    {
      cwd: webDirectory,
      env: {
        ...appEnvironment,
        X_BOOKMARKS_BACKUP_DIR: join(blocked, "snapshots"),
      },
      // It logs the failure, which is the point of it and not of this run.
      stdio: "ignore",
    },
  );
  const fromSecond = (path: string) =>
    waitFor(
      `the second app to answer ${path}`,
      () =>
        new Promise<string | false>((resolve) => {
          httpRequest(
            `http://${APP_HOST}:${port}${path}`,
            { headers: { host: APP_AUTHORITY } },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () =>
                resolve(Buffer.concat(chunks).toString("utf8")),
              );
            },
          )
            .once("error", () => resolve(false))
            .end();
        }),
    );
  try {
    const page = await fromSecond("/status");
    assert.match(
      page,
      /role="alert" data-testid="backup-failure"[^>]*>The last backup failed, so the library is not being backed up:.{0,40}ENOTDIR/s,
    );
    assert.match(page, /data-testid="backup-last-check">.{0,200}it failed</s);
    assert.match(
      page,
      new RegExp(`data-testid="capture-count">${expectedCaptures}<`),
    );

    const library = await fromSecond("/");
    const [banner = ""] =
      /<div[^>]*data-testid="backup-banner".*?<\/div>\s*<\/div>/s.exec(
        library,
      ) ?? [];
    assert.match(banner, /role="alert"/);
    assert.match(banner, /The last backup failed/);
    assert.match(banner, /ENOTDIR/);
    assert.match(banner, /href="\/status"/);
    const [line = ""] =
      /<a[^>]*data-testid="status-line"[^>]*>/.exec(library) ?? [];
    assert.match(line, /data-level="problem"/);
    assert.match(line, /href="\/status"/);
  } finally {
    const exited = new Promise((resolve) => second.once("exit", resolve));
    second.kill("SIGTERM");
    await exited;
  }
});

// --- The library ------------------------------------------------------------

/**
 * More of core's redacted fixtures, for the tests of the library screen:
 * posts with photos, videos and a GIF, posts that quote, link cards, long
 * text, and posts X withholds. They are written straight into this run's
 * database. How a capture gets there is tested above; these tests are about
 * what the screen then shows, and what the browser then asks for.
 */
const LIBRARY_FIXTURES = [
  "media",
  "animated-gif",
  "quoted-posts",
  "links-and-cards",
  "long-posts",
  "withheld-posts",
];
let librarySeeded = false;

function seedLibrary(): Store {
  store ??= openStore(join(dataDirectory, "bookmarks.db"));
  if (librarySeeded) return store;
  for (const name of LIBRARY_FIXTURES) {
    insertRawCapture(store, {
      source: "x-web-client",
      operation: "Bookmarks",
      payload: readFileSync(
        join(
          repoRoot,
          "packages/core/src/parsers/fixtures/x-web-client/Bookmarks",
          `2026-10-12-${name}.json`,
        ),
        "utf8",
      ),
    });
  }
  parsePendingCaptures(store);
  librarySeeded = true;
  return store;
}

/** Every bookmark in the database, most recently bookmarked first, as core lists them. */
function libraryBookmarks(): Bookmark[] {
  const from = seedLibrary();
  const bookmarks: Bookmark[] = [];
  let after: string | undefined;
  do {
    const page = listBookmarks(from, { limit: MAX_PAGE_SIZE, after });
    bookmarks.push(...page.bookmarks);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined);
  return bookmarks;
}

type PostBody = Pick<PostContent, "postId" | "media" | "card" | "article">;

/** The post, bookmarked or quoted, with this id. */
function bodyOf(bookmarks: Bookmark[], postId: string | null): PostBody {
  for (const bookmark of bookmarks) {
    if (bookmark.postId === postId) return bookmark;
    if (bookmark.quoted?.available && bookmark.quoted.postId === postId) {
      return bookmark.quoted;
    }
  }
  throw new Error(`No post ${postId} is in the library.`);
}

const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

/**
 * What "Show media" on a post may load, as paths on the image host: its
 * photos, the poster frames of its videos, its card's picture and its
 * article's cover. Never a video file, and never an avatar.
 */
function picturesOf(body: PostBody): string[] {
  return [
    ...body.media.map((media) => media.imageUrl),
    body.card?.imageUrl,
    body.article?.coverImageUrl,
  ]
    .filter((url) => typeof url === "string")
    .filter((url) => new URL(url).host === MEDIA_HOSTS.image)
    .map(pathOf);
}

const header = (request: SeenRequest, name: string) =>
  request.headers.find(([key]) => key.toLowerCase() === name)?.[1];

/** Requests to the fake media hosts since `mark`. */
const toMediaHosts = (mark: number) =>
  fakeX.seen
    .slice(mark)
    .filter(
      ({ host }) => host === MEDIA_HOSTS.image || host === MEDIA_HOSTS.video,
    );

const unique = (values: string[]) => [...new Set(values)].sort();

async function openLibrary(
  path: string,
  viewport = { width: 1280, height: 800 },
): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByTestId("result-count").waitFor();
  await listIsLive(page);
  return page;
}

/**
 * The list arrives as the server laid it out and is then drawn row by row,
 * only the rows near the screen. A test waits for that before it counts.
 */
const listIsLive = (page: Page) =>
  page.waitForFunction(
    () => document.querySelector('[data-list="static"]') === null,
  );

const resultCount = (page: Page) =>
  page.getByTestId("result-count").textContent();
/** The posts in the page now: those near the screen, and any kept in it. */
const shownPosts = (page: Page) =>
  page
    .locator("[data-post]")
    .evaluateAll((posts) =>
      posts.map((post) => post.getAttribute("data-post-id") ?? ""),
    );

/**
 * Every post of the list, in the list's order. Only the rows near the screen
 * are in the page, so this reads the whole of it as a reader would: by
 * scrolling to its end, noting each post and the place it says it has.
 */
async function everyPost(page: Page): Promise<string[]> {
  const seen = new Map<number, string>();
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let step = 0; step < 3000; step += 1) {
    const { posts, ended } = await page.evaluate(() => ({
      posts: [...document.querySelectorAll("[data-post]")].map(
        (post) =>
          [
            Number(post.getAttribute("aria-posinset")),
            post.getAttribute("data-post-id") ?? "",
          ] as const,
      ),
      ended:
        [...document.querySelectorAll("p")].some(
          (line) => line.textContent === "End of the list.",
        ) &&
        window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 2,
    }));
    for (const [position, postId] of posts) seen.set(position, postId);
    if (ended) break;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.7));
    await sleep(50);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(100);
  const positions = [...seen.keys()].sort((a, b) => a - b);
  assert.deepEqual(
    positions,
    positions.map((_, index) => index + 1),
    "every place in the list was passed, from the first",
  );
  return positions.map((position) => seen.get(position) ?? "");
}

/** Two frames: long enough for the list to draw the rows a scroll landed on. */
const drawn = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/** Scrolls down the list until a post is in the page, and brings it on screen. */
async function findPost(page: Page, postId: string): Promise<Locator> {
  const post = page.locator(`[data-post-id="${postId}"]`).first();
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitFor(`post ${postId} to come into the page`, async () => {
    // Asked once the rows for where the page now is have been drawn: just
    // after a scroll the page still holds the rows it had before it.
    await drawn(page);
    if ((await post.count()) > 0) return true;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.7));
    return false;
  });
  await post.scrollIntoViewIfNeeded();
  await drawn(page);
  return post;
}

test("the library lists every bookmark newest saved first, and shows on the same screen that a capture was not understood", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const mark = fakeX.seen.length;
  const page = await openLibrary("/");

  await waitFor(
    "the whole library to be counted",
    async () => (await resultCount(page)) === `${bookmarks.length} bookmarks`,
  );
  const newestFirst = bookmarks.map((bookmark) => bookmark.postId);
  const saved = bookmarks.map((bookmark) => bookmark.bookmarkedAt.getTime());
  assert.deepEqual(
    saved,
    saved.toSorted((a, b) => b - a),
  );
  // The page holds the rows near the screen, the first ones first, and not
  // the whole list; read to its end, the list is every bookmark, in order.
  const shown = await shownPosts(page);
  assert.ok(shown.length >= 2 && shown.length < newestFirst.length);
  assert.deepEqual(shown, newestFirst.slice(0, shown.length));
  assert.deepEqual(await everyPost(page), newestFirst);

  // Earlier tests left captures the parser could not read. The library says
  // so itself, without a visit to the status page.
  const summary = summariseParsing(seedLibrary());
  assert.ok(summary.captures.failed > 0);
  const banner = page.getByTestId("status-banner");
  assert.match((await banner.textContent()) ?? "", /not understood/);
  assert.equal(await banner.getByRole("link").getAttribute("href"), "/status");
  assert.equal(
    await page.getByTestId("status-line").getAttribute("data-level"),
    "problem",
  );

  // A post's own page on X is a plain link, opened by a click, in a new tab
  // that is told nothing about this one.
  const first = bodyOf(bookmarks, shown[0] ?? null) as Bookmark;
  const open = page
    .locator("[data-post]")
    .first()
    .getByRole("link", { name: /^Open on X/ });
  assert.equal(
    await open.getAttribute("href"),
    `https://x.com/${first.authorHandle}/status/${first.postId}`,
  );
  assert.deepEqual(
    fakeX.seen.slice(mark),
    [],
    "showing the library asked no other host for anything",
  );
  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    open.click(),
  ]);
  // The fake has no such post and answers 404; what matters is what the new
  // tab asked for, and that it knows nothing of the tab it came from.
  const visit = await waitFor("the new tab to ask X for the post", () =>
    fakeX.seen.slice(mark).at(0),
  );
  assert.equal(
    `https://${visit.host}${visit.path}`,
    await open.getAttribute("href"),
  );
  assert.equal(header(visit, "referer"), undefined);
  assert.equal(await opened.evaluate(() => window.opener), null);
  await opened.close();
  await page.close();
});

test("search and filters narrow the library, and a search that finds nothing says so and offers the way back", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const total = bookmarks.length;
  const page = await openLibrary("/");
  const search = page.getByRole("searchbox", { name: "Search bookmarks" });

  // `/` reaches the search field from anywhere.
  await page.keyboard.press("/");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "library-search",
  );
  const author = bookmarks.find((bookmark) => bookmark.media.length > 0);
  assert.ok(author, "a fixture bookmark has media");
  const handle = `@${author.authorHandle}`;
  await page.keyboard.type(handle.toUpperCase());
  await page.waitForURL(
    (url) => url.searchParams.get("q") === handle.toUpperCase(),
  );
  await waitFor("the search to narrow the list", async () =>
    /^[0-9]+ of /.test((await resultCount(page)) ?? ""),
  );
  const [, matches = "0"] =
    /^([0-9]+) of ([0-9,]+) bookmarks$/.exec((await resultCount(page)) ?? "") ??
    [];
  assert.ok(Number(matches) >= 1 && Number(matches) < total);
  assert.ok((await shownPosts(page)).includes(author.postId));
  for (const text of await page.locator("[data-post]").allTextContents()) {
    assert.ok(text.toLowerCase().includes(handle.toLowerCase()));
  }
  // The screen's search is core's search, which the MCP server runs too: the
  // same matches, in the same order, best first and not by time.
  const found = searchBookmarks(seedLibrary(), {
    query: handle.toUpperCase(),
    limit: MAX_PAGE_SIZE,
  });
  assert.equal(Number(matches), found.total);
  assert.deepEqual(
    await everyPost(page),
    found.hits.map(({ bookmark }) => bookmark.postId),
  );
  await page.getByRole("heading", { name: "Best match first" }).waitFor();

  // Nothing matches: the screen says what was searched for, and how to leave.
  await search.fill("zzqqxxnothingholdsthis");
  const nothing = page.getByTestId("no-results");
  await nothing.waitFor();
  assert.match(
    (await nothing.textContent()) ?? "",
    /No bookmarks match “zzqqxxnothingholdsthis”/,
  );
  assert.equal(await resultCount(page), `0 of ${total} bookmarks`);
  await nothing.getByRole("link", { name: "Clear search" }).click();
  await waitFor(
    "the whole library again",
    async () => (await resultCount(page)) === `${total} bookmarks`,
  );
  assert.equal(await search.inputValue(), "");

  // A filter is a link. It narrows the list to what has the feature, and the
  // same link takes it off again.
  const withMedia = bookmarks.filter((bookmark) => bookmark.media.length > 0);
  const filters = page.getByRole("navigation", { name: "Library" });
  await filters.getByRole("link", { name: /^Media/ }).click();
  await page.waitForURL((url) => url.searchParams.get("has") === "media");
  await waitFor(
    "the media filter",
    async () =>
      (await resultCount(page)) === `${withMedia.length} of ${total} bookmarks`,
  );
  assert.deepEqual(
    unique(await everyPost(page)),
    unique(withMedia.map((bookmark) => bookmark.postId)),
  );
  const active = filters.getByRole("link", { name: /^Media/ });
  assert.equal(await active.getAttribute("aria-current"), "true");
  await active.click();
  await waitFor(
    "the filter to come off",
    async () => (await resultCount(page)) === `${total} bookmarks`,
  );

  // A long post is shortened, and opens where it stands.
  await page.goto(`${APP_ORIGIN}/?has=long`);
  const expand = page.locator("[data-expand]").first();
  const text = page.locator(
    `[id="${await expand.getAttribute("aria-controls")}"]`,
  );
  const shortened = (await text.boundingBox())?.height ?? 0;
  assert.equal(await expand.getAttribute("aria-expanded"), "false");
  await expand.click();
  assert.equal(await expand.getAttribute("aria-expanded"), "true");
  assert.ok(((await text.boundingBox())?.height ?? 0) > shortened);
  await page.close();
});

test("a post X withholds is listed apart, by its id, with the way to it on X", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const withheld = unique(
    listParseIssues(seedLibrary())
      .filter((issue) => issue.kind === "post-unavailable")
      .map((issue) => issue.postId ?? ""),
  );
  assert.ok(withheld.length > 0, "a fixture holds a withheld post");
  // The library never held them, so none is among its bookmarks.
  for (const postId of withheld) {
    assert.ok(!bookmarks.some((bookmark) => bookmark.postId === postId));
  }

  const all = await openLibrary("/");
  const offered = all
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: /^Withheld by X/ });
  assert.match(
    (await offered.textContent()) ?? "",
    new RegExp(`${withheld.length}$`),
  );
  await offered.click();
  await all.waitForURL((url) => url.searchParams.get("on") === "withheld");
  await waitFor(
    "the withheld posts",
    async () => (await resultCount(all)) === `${withheld.length} bookmarks`,
  );

  assert.deepEqual(unique(await everyPost(all)), withheld);
  for (const postId of withheld) {
    const row = all.locator(`[data-post-id="${postId}"]`);
    assert.match((await row.textContent()) ?? "", new RegExp(postId));
    assert.equal(
      await row.getByRole("link", { name: /^Open on X/ }).getAttribute("href"),
      `https://x.com/i/web/status/${postId}`,
    );
  }
  await all.close();
});

test("the library works from the keyboard, and on a narrow screen its filters and status are one press away", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const page = await openLibrary("/");
  const focusedPost = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-post]")].indexOf(
        document.activeElement as Element,
      ),
    );

  await page.keyboard.press("j");
  assert.equal(await focusedPost(), 0);
  await page.keyboard.press("j");
  assert.equal(await focusedPost(), 1);
  await page.keyboard.press("k");
  assert.equal(await focusedPost(), 0);
  // The first Tab stop is the way past the side column.
  await page.reload();
  await page.getByTestId("result-count").waitFor();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Skip to the bookmarks",
  );
  await page.keyboard.press("Enter");
  await waitFor(
    "the skip link to land on the list",
    async () =>
      (await page.evaluate(() => document.activeElement?.id)) === "content",
  );

  await page.setViewportSize({ width: 320, height: 640 });
  assert.equal(
    await page.getByRole("navigation", { name: "Library" }).isVisible(),
    false,
  );
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
    0,
    "nothing runs off the side of a 320px screen",
  );
  assert.ok(await page.getByTestId("status-banner").isVisible());
  await page.getByRole("button", { name: /^Filters/ }).click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await sheet.waitFor();
  assert.ok(await sheet.getByRole("link", { name: /^Media/ }).isVisible());
  assert.ok(await sheet.getByTestId("status-line").isVisible());
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await page.close();
});

test("only the rows near the screen are in the page, and nothing a row holds is lost when it leaves: open text, shown media, a playing video, focus, and the reader's place", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const page = await openLibrary("/", { width: 1280, height: 600 });
  const drawnPosts = () => page.locator("[data-post]").count();
  const toEnd = async () => {
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await sleep(400);
  };
  const isDrawn = (postId: string) =>
    page
      .locator(`[data-post-id="${postId}"]`)
      .count()
      .then((count) => count > 0);
  const leaveFocus = () =>
    page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // A window of the list, not the list: fewer rows than bookmarks, each
  // saying where it stands among all of them.
  assert.ok(bookmarks.length >= 20, "the fixtures make a list worth windowing");
  assert.ok((await drawnPosts()) < bookmarks.length / 2);
  const first = page.locator("[data-post]").first();
  assert.equal(await first.getAttribute("aria-posinset"), "1");
  assert.equal(
    await first.getAttribute("aria-setsize"),
    String(bookmarks.length),
  );
  assert.deepEqual(
    await everyPost(page),
    bookmarks.map((bookmark) => bookmark.postId),
  );

  // A long text opened in place grows downward: the post stays where it is
  // and so does the page. Scrolled away, the row leaves the page; back, the
  // text is still open.
  const long = bookmarks.find(
    (bookmark) =>
      [...bookmark.text].length > 700 || bookmark.text.split("\n").length > 12,
  );
  assert.ok(long, "the fixtures hold a post long enough to be shortened");
  const longPost = await findPost(page, long.postId);
  const expand = longPost.locator("[data-expand]").first();
  const where = async () => ({
    top: Math.round((await longPost.boundingBox())?.y ?? 0),
    scrolled: await page.evaluate(() => Math.round(window.scrollY)),
  });
  const before = await where();
  await expand.click();
  assert.equal(await expand.getAttribute("aria-expanded"), "true");
  await sleep(300);
  assert.deepEqual(await where(), before, "nothing moved but what is below");
  // The press left the keyboard's focus in the row, which keeps a row in
  // the page. The reader moves on to something else.
  await leaveFocus();
  await toEnd();
  assert.equal(await isDrawn(long.postId), false, "the row left the page");
  await findPost(page, long.postId);
  assert.equal(
    await longPost
      .locator("[data-expand]")
      .first()
      .getAttribute("aria-expanded"),
    "true",
    "the text is open as it was left",
  );

  // A row whose media is shown stays in the page however far the list is
  // scrolled, so coming back to it asks the media hosts for nothing: the
  // fake lets nothing be cached, and would be asked again by a new element.
  const photos = bookmarks.find(
    (bookmark) =>
      bookmark.media.length > 0 &&
      bookmark.media.every((media) => media.type === "photo"),
  );
  const video = bookmarks.find((bookmark) =>
    bookmark.media.some(
      (media) => media.type === "video" && media.videoUrl !== null,
    ),
  );
  assert.ok(photos && video);
  const photoPost = await findPost(page, photos.postId);
  let mark = fakeX.seen.length;
  await photoPost
    .locator(`[data-show-media][data-media-of="${photos.postId}"]`)
    .first()
    .click();
  await waitFor(
    "the pictures",
    () => toMediaHosts(mark).length >= unique(picturesOf(photos)).length,
  );
  await sleep(500);
  const shownMedia = await page.locator("[data-x-media]").count();
  mark = fakeX.seen.length;
  await toEnd();
  assert.equal(await isDrawn(photos.postId), true, "it is kept in the page");
  assert.equal(await page.locator("[data-x-media]").count(), shownMedia);
  await findPost(page, photos.postId);
  await sleep(500);
  assert.deepEqual(toMediaHosts(mark), [], "nothing was asked for again");

  // A video that is playing plays on while its row is far off screen, from
  // the same element: its time moves on, and the file is not asked for anew.
  const videoPost = await findPost(page, video.postId);
  await videoPost
    .locator(`[data-show-media][data-media-of="${video.postId}"]`)
    .first()
    .click();
  await videoPost.getByRole("button", { name: "Play video" }).first().click();
  const player = videoPost.locator('[data-player="video"]').first();
  const started = await waitFor("the video to play", async () => {
    const now = await videoState(player);
    return !now.paused && now.time > 0 ? now : false;
  });
  await sleep(300);
  mark = fakeX.seen.length;
  // Away, to whichever end of the list is the further from it.
  const away = await page.evaluate(() => {
    const far =
      window.scrollY > document.documentElement.scrollHeight / 2
        ? 0
        : document.documentElement.scrollHeight;
    window.scrollTo(0, far);
    return far;
  });
  await sleep(1500);
  assert.equal(
    await player.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.bottom < 0 || box.top > window.innerHeight;
    }),
    true,
    `the player is off screen, with the page at ${away}`,
  );
  const later = await videoState(player);
  assert.equal(later.paused, false, "it plays on");
  assert.ok(later.time > started.time + 1 || later.time < started.time);
  await findPost(page, video.postId);
  assert.equal((await videoState(player)).paused, false);
  assert.deepEqual(toMediaHosts(mark), [], "and nothing was asked for again");
  await player.locator("video").click({ position: { x: 30, y: 30 } });
  assert.equal((await videoState(player)).paused, true);

  // The row with the keyboard's focus stays too: scrolled away and back,
  // focus is where it was, and J moves on from there.
  await leaveFocus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await page.keyboard.press("j");
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-post-id"));
  const place = () =>
    page.evaluate(() =>
      Number(document.activeElement?.getAttribute("aria-posinset")),
    );
  const chosen = await focused();
  const stood = await place();
  assert.ok(chosen, "J chose a post");
  await toEnd();
  assert.equal(await focused(), chosen, "focus was not lost");
  await page.keyboard.press("j");
  await waitFor(
    "J to move on from it",
    async () => (await place()) === stood + 1,
  );
  assert.equal(
    await page.evaluate(() => {
      const box = document.activeElement?.getBoundingClientRect();
      return box !== undefined && box.top >= 0 && box.top < window.innerHeight;
    }),
    true,
    "and the post it moved to is on screen",
  );
  // J again and again reaches rows that were not drawn when it began.
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("j");
    await sleep(60);
  }
  await waitFor("twelve posts on", async () => (await place()) === stood + 13);

  // A reload returns to the same place, and so does Back from another list.
  const view = () =>
    page.evaluate(() => {
      const top = [...document.querySelectorAll("[data-post]")].find(
        (post) => post.getBoundingClientRect().bottom > 120,
      );
      return {
        postId: top?.getAttribute("data-post-id") ?? null,
        top: Math.round(top?.getBoundingClientRect().top ?? 0),
      };
    });
  const returned = async (was: Awaited<ReturnType<typeof view>>) => {
    await page.getByTestId("result-count").waitFor();
    await listIsLive(page);
    await waitFor("the place to be found again", async () => {
      const now = await view();
      return now.postId === was.postId && Math.abs(now.top - was.top) <= 2;
    });
  };
  await sleep(400);
  const there = await view();
  assert.ok(
    (await page.evaluate(() => window.scrollY)) > 1500,
    "the page is well down the list",
  );
  await page.reload();
  await returned(there);
  const filters = page.getByRole("navigation", { name: "Library" });
  await filters.getByRole("link", { name: /^Media/ }).click();
  await page.waitForURL((url) => url.searchParams.get("has") === "media");
  await waitFor(
    "the other list, from its top",
    async () => (await page.evaluate(() => window.scrollY)) < 200,
  );
  await page.goBack();
  await returned(there);
  // A visit by a link is a new one, and starts at the top.
  await filters.getByRole("link", { name: /^Links/ }).click();
  await page.waitForURL((url) => url.searchParams.get("has") === "link");
  await filters.getByRole("link", { name: /^All bookmarks/ }).click();
  await page.waitForURL((url) => !url.searchParams.has("has"));
  await listIsLive(page);
  await sleep(600);
  assert.ok((await page.evaluate(() => window.scrollY)) < 200);
  await page.close();
});

// --- Media: what the browser asks the media hosts for, and when -------------

test("with the setting off, the library loads no media: not on arrival, not while scrolling, not for rows off screen", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const mark = fakeX.seen.length;
  const page = await openLibrary("/?has=media", { width: 1280, height: 600 });

  assert.equal(
    await page
      .getByRole("switch", { name: "Load media on screen" })
      .getAttribute("aria-checked"),
    "false",
    "the setting is off until the owner turns it on",
  );
  assert.ok(
    (await page.locator("[data-show-media]").count()) >= 2,
    "the posts near the screen offer their media",
  );
  // Scrolled through from the first post to the last and back: every post
  // with media was drawn at some moment, on screen or just off it.
  const passed = await everyPost(page);
  assert.equal(
    passed.length,
    bookmarks.filter((bookmark) => bookmark.media.length > 0).length,
  );
  assert.ok(passed.length >= 6, "several posts offer media");
  await sleep(1000);

  assert.equal(await page.locator("[data-x-media]").count(), 0);
  assert.equal(
    await page.locator("img, video, audio, picture, iframe").count(),
    0,
    "there is no media element in the page at all",
  );
  assert.ok((await page.locator("[data-show-media]").count()) >= 2);
  assert.deepEqual(
    fakeX.seen.slice(mark),
    [],
    "no host was asked for anything",
  );
  await page.close();
});

test("Show media on one post loads that post's pictures and no other's, with no cookie and no Referer; a video loads when it is played", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  // The media hosts hold a cookie, as they might in the owner's browser.
  const setup = await context.newPage();
  for (const host of [MEDIA_HOSTS.image, MEDIA_HOSTS.video]) {
    await setup.goto(`https://${host}${MEDIA_COOKIE_PATH}`);
  }
  // The control: a picture embedded the ordinary way, by another site's
  // page, is asked for with that cookie. So when the library's request
  // carries none, that is the library's doing and not the browser's.
  let mark = fakeX.seen.length;
  await setup.goto(`https://${EMBEDDER_HOST}/`);
  const control = await waitFor("the control picture", () =>
    fakeX.seen.slice(mark).find(({ path }) => path === EMBEDDED_CONTROL_PATH),
  );
  assert.equal(header(control, "cookie"), MEDIA_COOKIE);
  assert.equal(header(control, "referer"), `https://${EMBEDDER_HOST}/`);
  await setup.close();

  const page = await openLibrary("/?has=media");
  const video = bookmarks.find((bookmark) =>
    bookmark.media.some(
      (media) => media.type === "video" && media.videoUrl !== null,
    ),
  );
  const photos = bookmarks.find(
    (bookmark) =>
      bookmark.media.length > 0 &&
      bookmark.media.every((media) => media.type === "photo"),
  );
  assert.ok(video && photos, "the fixtures hold a video post and a photo post");

  // One press on the photo post.
  mark = fakeX.seen.length;
  const expected = unique(picturesOf(photos));
  assert.ok(expected.length > 0);
  await findPost(page, photos.postId);
  await page
    .locator(`[data-show-media][data-media-of="${photos.postId}"]`)
    .first()
    .click();
  await waitFor(
    "the post's pictures to be asked for",
    () => toMediaHosts(mark).length >= expected.length,
  );
  await sleep(1000);
  const asked = toMediaHosts(mark);
  assert.deepEqual(
    fakeX.seen.slice(mark).map(({ host }) => host),
    asked.map(() => MEDIA_HOSTS.image),
    "only the image host was asked, for anything",
  );
  assert.deepEqual(unique(asked.map(({ path }) => path)), expected);
  assert.ok(
    asked.length <= picturesOf(photos).length,
    "no picture is asked for twice",
  );
  for (const request of asked) {
    assert.equal(request.method, "GET");
    assert.equal(header(request, "cookie"), undefined, "no cookie");
    assert.equal(header(request, "referer"), undefined, "no Referer");
    assert.equal(header(request, "authorization"), undefined);
    // What a request without credentials still says: which page asked.
    assert.equal(header(request, "origin"), APP_ORIGIN);
    assert.equal(header(request, "sec-fetch-mode"), "cors");
  }
  assert.equal(
    await page.locator("[data-x-media]").count(),
    picturesOf(photos).length,
    "that post's media is in the page, and no other post's",
  );

  // The video post: its poster with the press, the file only with play.
  mark = fakeX.seen.length;
  const post = await findPost(page, video.postId);
  await post
    .locator(`[data-show-media][data-media-of="${video.postId}"]`)
    .first()
    .click();
  await waitFor(
    "the poster to be asked for",
    () => toMediaHosts(mark).length >= unique(picturesOf(video)).length,
  );
  await sleep(1000);
  assert.deepEqual(
    unique(toMediaHosts(mark).map(({ host, path }) => host + path)),
    unique(picturesOf(video).map((path) => MEDIA_HOSTS.image + path)),
    "no video file is asked for before play",
  );
  mark = fakeX.seen.length;
  await post.getByRole("button", { name: /^Play/ }).first().click();
  const file = await waitFor("the video file", () =>
    toMediaHosts(mark).find(({ host }) => host === MEDIA_HOSTS.video),
  );
  const played = video.media.find((media) => media.videoUrl !== null);
  assert.equal(file.path, pathOf(played?.videoUrl ?? ""));
  assert.equal(header(file, "cookie"), undefined, "no cookie");
  assert.equal(header(file, "referer"), undefined, "no Referer");

  // In all of it, nobody's avatar.
  const avatars = bookmarks
    .map((bookmark) => bookmark.authorAvatarUrl)
    .filter((url) => url !== null)
    .map(pathOf);
  assert.ok(avatars.length > 0);
  for (const { path } of fakeX.seen) assert.ok(!avatars.includes(path));
  assert.ok(!(await page.content()).includes("profile_images"));
  await page.close();
});

/** What a video element says of itself. */
const videoState = (player: Locator) =>
  player.locator("video").evaluate((video: HTMLVideoElement) => ({
    paused: video.paused,
    time: video.currentTime,
    duration: video.duration,
    muted: video.muted,
    volume: video.volume,
    rate: video.playbackRate,
    loop: video.loop,
    browserControls: video.controls,
  }));

/** Requests to the fake video host since `mark`. */
const toVideoHost = (mark: number) =>
  fakeX.seen.slice(mark).filter(({ host }) => host === MEDIA_HOSTS.video);

/** Every one of `requests` asks the video host for `path`, and says nothing of the owner. */
function assertPlainVideoRequests(requests: SeenRequest[], path: string) {
  assert.ok(requests.length > 0, "the video file was asked for");
  for (const request of requests) {
    assert.equal(request.host, MEDIA_HOSTS.video);
    assert.equal(request.path, path, "one address, and no other version");
    assert.equal(request.method, "GET");
    assert.equal(header(request, "cookie"), undefined, "no cookie");
    assert.equal(header(request, "referer"), undefined, "no Referer");
    assert.equal(header(request, "authorization"), undefined);
    assert.equal(header(request, "origin"), APP_ORIGIN);
  }
}

test("a video plays in the library's own player: only a press on play asks for the file, the video keys work, and the list keeps its own", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const video = bookmarks.find((bookmark) =>
    bookmark.media.some(
      (media) => media.type === "video" && media.videoUrl !== null,
    ),
  );
  assert.ok(video, "the fixtures hold a video post");
  const file = pathOf(
    video.media.find((media) => media.type === "video")?.videoUrl ?? "",
  );
  // The media hosts hold a cookie, as they might in the owner's browser.
  const setup = await context.newPage();
  await setup.goto(`https://${MEDIA_HOSTS.video}${MEDIA_COOKIE_PATH}`);
  await setup.close();

  const page = await openLibrary("/?has=video");
  const post = page.locator(`[data-post-id="${video.postId}"]`).first();
  const player = post.locator('[data-player="video"]').first();
  const state = () => videoState(player);
  const playing = (label: string) =>
    waitFor(label, async () => {
      const now = await state();
      return !now.paused && now.time > 0 ? now : false;
    });
  const show = async () => {
    await findPost(page, video.postId);
    await post
      .locator(`[data-show-media][data-media-of="${video.postId}"]`)
      .first()
      .click();
  };
  const play = post.getByRole("button", { name: "Play video" }).first();
  const opened = fakeX.seen.length;

  // The post's media is shown: its poster, and nothing of the video.
  await show();
  await play.waitFor();
  await sleep(1000);
  assert.deepEqual(
    toVideoHost(opened),
    [],
    "showing a post's media asks the video host for nothing",
  );
  assert.equal(await page.locator("video").count(), 0);

  // Play, by the keyboard. Now, and only now, the file is asked for: the one
  // address, with no cookie and no Referer. Nothing else is asked of any
  // host, the poster included, which is already there.
  let mark = fakeX.seen.length;
  await play.focus();
  await page.keyboard.press("Enter");
  await playing("the video to play");
  assert.deepEqual(
    fakeX.seen.slice(mark).map(({ host }) => host),
    toVideoHost(mark).map(() => MEDIA_HOSTS.video),
    "pressing play asked the video host, and no other",
  );
  assertPlainVideoRequests(toVideoHost(mark), file);

  // The controls are the app's own, each with a name, and focus is on them.
  assert.equal((await state()).browserControls, false);
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Pause",
  );
  for (const [role, name] of [
    ["button", "Pause"],
    ["slider", "Seek"],
    ["button", /^Playback speed, 1×/],
    ["button", /^Mute$/],
    ["slider", "Volume"],
    ["button", "Full screen"],
  ] as const) {
    assert.equal(await player.getByRole(role, { name }).count(), 1, `${name}`);
  }

  // The video keys, with focus in the player.
  await page.keyboard.press("Space");
  assert.equal((await state()).paused, true);
  const paused = await state();
  await page.keyboard.press("ArrowRight");
  await waitFor("the seek forward", async () => {
    const { time } = await state();
    return Math.abs(time - (paused.time + 5)) < 0.5;
  });
  await page.keyboard.press("ArrowLeft");
  await waitFor("the seek back", async () => {
    const { time } = await state();
    return Math.abs(time - paused.time) < 0.5;
  });
  await page.keyboard.press("ArrowDown");
  assert.equal((await state()).volume, 0.9);
  await page.keyboard.press("ArrowUp");
  assert.equal((await state()).volume, 1);
  await page.keyboard.press(">");
  assert.equal((await state()).rate, 1.25);
  await page.keyboard.press("<");
  assert.equal((await state()).rate, 1);
  await page.keyboard.press("f");
  await waitFor("the player to fill the screen", () =>
    page.evaluate(
      () => document.fullscreenElement?.getAttribute("data-player") === "video",
    ),
  );
  await page.keyboard.press("f");
  await waitFor("the player to leave full screen", () =>
    page.evaluate(() => document.fullscreenElement === null),
  );
  await page.keyboard.press("Space");
  await playing("the video to play again");

  // The list's keys stay the list's, from inside the player: M does not
  // mute, and J and K move between posts while the video plays on.
  const focusedPost = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-post]")].indexOf(
        document.activeElement?.closest("[data-post]") as Element,
      ),
    );
  const here = await focusedPost();
  await page.keyboard.press("m");
  assert.equal((await state()).muted, false);
  await page.keyboard.press("j");
  assert.equal(await focusedPost(), here + 1);
  await page.keyboard.press("k");
  assert.equal(await focusedPost(), here);
  assert.equal((await state()).paused, false);

  // The pointer. A press on the picture pauses and plays.
  await player.locator("video").click({ position: { x: 40, y: 40 } });
  assert.equal((await state()).paused, true);
  // A drag along the timeline seeks once, where it is let go.
  const before = await state();
  const rail = player.getByRole("slider", { name: "Seek" });
  const box = await rail.boundingBox();
  assert.ok(box);
  const middle = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.2, middle);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, middle, { steps: 8 });
  assert.equal(
    (await state()).time,
    before.time,
    "nothing is sought while the drag goes on",
  );
  await page.mouse.up();
  await waitFor("the seek where the drag ended", async () => {
    const { time, duration } = await state();
    return Math.abs(time - duration * 0.75) < 1;
  });
  await player.getByRole("button", { name: "Mute", exact: true }).click();
  assert.equal((await state()).muted, true);
  await player.getByRole("button", { name: "Unmute" }).waitFor();
  await player.getByRole("button", { name: /^Playback speed/ }).click();
  assert.equal((await state()).rate, 1.25);
  await player.getByRole("button", { name: "Playback speed, 1.25×" }).waitFor();
  // The next video starts as this one was left.
  assert.deepEqual(
    JSON.parse(
      (await page.evaluate(() =>
        window.localStorage.getItem("x-bookmarks:player"),
      )) ?? "{}",
    ),
    { volume: 1, muted: true, rate: 1.25 },
  );
  await page.evaluate(() =>
    window.localStorage.removeItem("x-bookmarks:player"),
  );

  // In all of it the video host was asked for that one file and nothing
  // else, plainly. The poster was never asked for a second time. The one
  // thing any other host was asked for is what M asks for anywhere in the
  // list: the media of the post this one quotes, when it quotes one.
  assertPlainVideoRequests(toVideoHost(mark), file);
  const quoted = video.quoted?.available ? picturesOf(video.quoted) : [];
  for (const request of fakeX.seen.slice(mark)) {
    if (request.host === MEDIA_HOSTS.video) continue;
    assert.equal(request.host, MEDIA_HOSTS.image);
    assert.ok(!picturesOf(video).includes(request.path), "not the poster");
    assert.ok(quoted.includes(request.path), "the quoted post's, shown by M");
  }

  try {
    // A video that is not there says so, and is asked for again only when
    // the owner asks.
    fakeX.media.video = "missing";
    await page.reload();
    await page.getByTestId("result-count").waitFor();
    await listIsLive(page);
    await show();
    await play.click();
    const failed = post.getByRole("alert");
    await failed.waitFor();
    assert.match((await failed.textContent()) ?? "", /did not load/);
    await sleep(1000);
    mark = fakeX.seen.length;
    fakeX.media.video = "plays";
    await sleep(500);
    assert.deepEqual(
      fakeX.seen.slice(mark),
      [],
      "nothing is tried again unasked",
    );
    await failed.getByRole("button", { name: "Try again" }).click();
    await playing("the video to play at the second asking");
    assertPlainVideoRequests(toVideoHost(mark), file);

    // A video that starts to arrive and stops says that it is loading, and
    // after a while offers to start over.
    fakeX.media.video = "stalls";
    await page.reload();
    await page.getByTestId("result-count").waitFor();
    await listIsLive(page);
    await show();
    await play.click();
    await waitFor(
      "the player to say it is loading",
      async () =>
        ((await player.getByRole("status").textContent()) ?? "") ===
        "Loading video",
    );
    const slow = player.locator('[data-player-notice="slow"]');
    await slow.waitFor({ timeout: 20_000 });
    assert.match(
      (await player.getByRole("status").textContent()) ?? "",
      /taking a while/,
    );
    mark = fakeX.seen.length;
    fakeX.media.video = "plays";
    await slow.getByRole("button", { name: "Try again" }).click();
    await playing("the video to play once it arrives");
    assertPlainVideoRequests(toVideoHost(mark), file);
  } finally {
    fakeX.media.video = "plays";
  }
  await page.close();
});

test("a GIF plays like a GIF: asked for at a press, silent and repeating, with no controls, and a press pauses it", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const gif = bookmarks.find((bookmark) =>
    bookmark.media.some(
      (media) => media.type === "animated_gif" && media.videoUrl !== null,
    ),
  );
  assert.ok(gif, "the fixtures hold a GIF");
  const file = pathOf(
    gif.media.find((media) => media.type === "animated_gif")?.videoUrl ?? "",
  );
  const page = await openLibrary("/?has=video");
  const post = page.locator(`[data-post-id="${gif.postId}"]`).first();
  const player = post.locator('[data-player="gif"]').first();
  const opened = fakeX.seen.length;

  await findPost(page, gif.postId);
  await post
    .locator(`[data-show-media][data-media-of="${gif.postId}"]`)
    .first()
    .click();
  const play = post.getByRole("button", { name: "Play GIF" }).first();
  await play.waitFor();
  await sleep(1000);
  assert.deepEqual(
    toVideoHost(opened),
    [],
    "a GIF's file is not asked for when its post's media is shown",
  );

  const mark = fakeX.seen.length;
  await play.click();
  await waitFor("the GIF to play", async () => {
    const now = await videoState(player);
    return !now.paused && now.time > 0;
  });
  assert.deepEqual(
    fakeX.seen.slice(mark).map(({ host }) => host),
    toVideoHost(mark).map(() => MEDIA_HOSTS.video),
  );
  assertPlainVideoRequests(toVideoHost(mark), file);

  const playing = await videoState(player);
  assert.equal(playing.loop, true);
  assert.equal(playing.muted, true);
  assert.equal(playing.browserControls, false);
  assert.equal(await player.getByRole("slider").count(), 0);
  assert.equal(await player.getByRole("button").count(), 1);
  // The one control is the GIF itself, which has the keyboard's focus.
  const pause = player.getByRole("button", { name: "Pause GIF" });
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Pause GIF",
  );
  await page.keyboard.press("Space");
  assert.equal((await videoState(player)).paused, true);
  await player.getByRole("button", { name: "Play GIF" }).click();
  assert.equal((await videoState(player)).paused, false);
  await pause.waitFor();
  await page.close();
});

test("with the setting on, media loads for the posts on screen and for no others, and a jump past posts loads none of them", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const start = fakeX.seen.length;
  const page = await openLibrary("/?has=media", { width: 1280, height: 600 });
  // Every post in this list that has pictures to show, a bookmarked post or
  // the post it quotes. The page holds only those near the screen, so which
  // are off screen is said from the library, not from the page.
  const withPictures = unique(
    bookmarks
      .filter((bookmark) => bookmark.media.length > 0)
      .flatMap((bookmark) => [
        bookmark.postId,
        ...(bookmark.quoted?.available ? [bookmark.quoted.postId] : []),
      ])
      .filter((postId) => picturesOf(bodyOf(bookmarks, postId)).length > 0),
  );
  /**
   * The posts whose placeholders are wholly on screen, wholly off it, and
   * far from it, measured a moment after the jump when there is one: once
   * the rows it landed on are drawn, and before any of them can have been
   * replaced by its media.
   */
  const placeholders = async (jumpToEnd = false) => {
    const drawn = await page.evaluate(async (jump) => {
      if (jump) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      const on: string[] = [];
      const touching: string[] = [];
      const near: string[] = [];
      for (const button of document.querySelectorAll("[data-show-media]")) {
        const box = button.getBoundingClientRect();
        const postId = button.getAttribute("data-media-of") ?? "";
        const screen = window.innerHeight;
        const onScreen = box.top >= 0 && box.bottom <= screen;
        // Marked, so the test can tell when this very placeholder is gone:
        // a post that is both bookmarked and quoted has one in each place.
        button.toggleAttribute("data-on-screen", onScreen);
        if (onScreen) on.push(postId);
        if (box.bottom >= 0 && box.top <= screen) touching.push(postId);
        // Within a screen of it, above or below.
        if (box.bottom >= -screen && box.top <= 2 * screen) near.push(postId);
      }
      return { on, touching, near };
    }, jumpToEnd);
    return {
      on: drawn.on,
      // A post that is not drawn at all is further off than any that is.
      off: withPictures.filter((postId) => !drawn.touching.includes(postId)),
      far: withPictures.filter((postId) => !drawn.near.includes(postId)),
    };
  };
  const pictures = (postIds: string[]) =>
    unique(postIds.flatMap((postId) => picturesOf(bodyOf(bookmarks, postId))));
  const askedFor = (mark: number) =>
    unique(toMediaHosts(mark).map(({ path }) => path));

  const atTop = await placeholders();
  assert.ok(atTop.on.length >= 1, "a post with media is on screen");
  assert.ok(atTop.off.length >= 3, "more posts with media are below the fold");

  // Turning the setting on loads what is on screen, after a moment, and
  // nothing below the fold. The topmost placeholder on screen is the one
  // that is certain to load: media appearing above another placeholder can
  // push that one off screen before its moment is up, and then it waits.
  const mark = fakeX.seen.length;
  await page.getByRole("switch", { name: "Load media on screen" }).click();
  await waitFor("the on-screen media", () =>
    pictures(atTop.on.slice(0, 1)).every((path) =>
      askedFor(mark).includes(path),
    ),
  );
  await sleep(1500);
  const first = askedFor(mark);
  for (const path of pictures(atTop.off)) {
    assert.ok(!first.includes(path), "a post below the fold was not loaded");
  }
  assert.ok(
    first.length < pictures([...atTop.on, ...atTop.off]).length,
    "the list was not loaded as a whole",
  );
  for (const request of toMediaHosts(mark)) {
    assert.equal(request.host, MEDIA_HOSTS.image, "no video file");
    assert.equal(header(request, "cookie"), undefined, "no cookie");
    assert.equal(header(request, "referer"), undefined, "no Referer");
  }

  // Jumping to the end passes every post in between. Only what the jump
  // lands on is loaded.
  const atEnd = await placeholders(true);
  assert.ok(atEnd.on.length >= 1, "a post with media is on screen at the end");
  await waitFor(
    "the media at the end",
    async () =>
      (await page
        .locator(`[data-on-screen][data-media-of="${atEnd.on[0]}"]`)
        .count()) === 0,
  );
  await sleep(1500);
  const everything = askedFor(start);
  // A picture already loaded on this page is not asked for a second time,
  // so what the end shows is among everything asked for, not after a mark.
  for (const path of pictures(atEnd.on.slice(0, 1))) {
    assert.ok(everything.includes(path), "what is on screen at the end loaded");
  }
  const passed = atTop.off.filter((postId) => atEnd.far.includes(postId));
  assert.ok(passed.length >= 1, "the jump passed at least one post");
  for (const path of pictures(passed)) {
    if (pictures([...atTop.on, ...atEnd.on]).includes(path)) continue;
    assert.ok(!everything.includes(path), "a post passed over was not loaded");
  }
  assert.ok(
    (await page.locator("[data-x-media]").count()) > 0,
    "some media is shown, and what was passed over is not",
  );

  // The choice is this browser's, and survives a reload.
  await page.reload();
  await page.getByTestId("result-count").waitFor();
  const setting = page.getByRole("switch", { name: "Load media on screen" });
  await waitFor(
    "the setting to be read back",
    async () => (await setting.getAttribute("aria-checked")) === "true",
  );
  await setting.click();
  assert.equal(await setting.getAttribute("aria-checked"), "false");
  await page.close();
});
