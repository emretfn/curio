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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  getBookmark,
  getCaptureParse,
  getRawCapture,
  openStore,
  type RawCapture,
  type Store,
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
import { type BrowserContext, chromium, type Page } from "playwright";
import {
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

  for (const path of ["/", "/pair", "/pair?_rsc=1", "/api/pairing"]) {
    const response = await requestToApp("GET", path);
    assert.ok(response.status > 0, `${path} answered`);
    assert.ok(
      !response.body.includes(token),
      `${path} must not contain the token`,
    );
  }
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

  // Everything else this run captured is the fake X's invented shape or an
  // operation with no parser: a timeline whose one entry is not a post the
  // parser knows, a response that is no timeline at all, a mutation. Each was
  // stored first and then recorded as what it is, and none became a bookmark.
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
  await status.goto(APP_ORIGIN);
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
});
