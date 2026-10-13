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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  addTag,
  type Bookmark,
  correctBookmark,
  finishDigestRun,
  getBookmark,
  getCaptureParse,
  getRawCapture,
  getVocabulary,
  insertRawCapture,
  latestWeekEnded,
  listBookmarks,
  listDigestRuns,
  listParseIssues,
  listSnapshots,
  listTaggingRuns,
  listTagProposals,
  listTags,
  MAX_PAGE_SIZE,
  type NewClassification,
  OTHER_CATEGORY,
  openStore,
  type PostContent,
  parsePendingCaptures,
  type RawCapture,
  recordClassification,
  resolveTag,
  retireTag,
  type Store,
  searchBookmarks,
  startDigestRun,
  summariseMatches,
  summariseParsing,
  summariseRawCaptures,
  summariseTagging,
  TAXONOMY,
  UNCLEAR_FORMAT,
  weekOf,
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
/**
 * A domain that, in the test browser, leads to the app: what a site has
 * after re-pointing its own name at 127.0.0.1 (DNS rebinding). The browser
 * takes a page on it and the app for one origin.
 */
const REBOUND_ORIGIN = "http://rebound.example";

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

/**
 * Stops the app, by asking it to unless told otherwise. Asked, Next first
 * waits for every connection to end, and late in a run the browser holds
 * some open for as long as it lives: a test that restarts the app then
 * says `SIGKILL`, which is also how an app that is killed stops.
 */
async function stopApp(
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
  const running = app;
  app = undefined;
  if (
    running === undefined ||
    running.exitCode !== null ||
    running.signalCode !== null
  ) {
    return;
  }
  const exited = new Promise((resolve) => running.once("exit", resolve));
  running.kill(signal);
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
    // One more name leads to the app, for the test of a rebound domain.
    `--host-resolver-rules=MAP other-site.example 127.0.0.1:${fakeX.otherSitePort}, MAP ${APP_AUTHORITY} ${APP_HOST}:${appPort}, MAP ${new URL(REBOUND_ORIGIN).host} ${APP_HOST}:${appPort}, MAP * 127.0.0.1:${fakeX.port}`,
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

const pairing = () => popup.locator("#status").getAttribute("data-pairing");
/**
 * Waits for the popup to be in a state, by the name `viewOf` gives it, and
 * returns what it then says: its title and the sentence under it.
 */
async function popupIs(...states: string[]): Promise<string> {
  let last: string | null = null;
  try {
    await waitFor(
      `the popup to be in the state ${states.join(" or ")}`,
      async () => {
        last = await popup.locator("#status").getAttribute("data-state");
        return last !== null && states.includes(last);
      },
    );
  } catch (error) {
    throw new Error(
      `The popup is in the state "${last}" and reads "${await popup.locator("#title").textContent()}".`,
      { cause: error },
    );
  }
  return `${await popup.locator("#title").textContent()}\n${await popup.locator("#detail").textContent()}`;
}
/**
 * Presses the one button the popup's state offers: "Send now" where captures
 * wait for the app, "Check again" where the app has not proved it holds the
 * token.
 */
const pressAction = (name: "Send now" | "Check again") =>
  popup.getByRole("button", { name, exact: true }).click();

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

  // What a stranger sees first: the name, what to do, and the field to do it
  // in, already holding the keyboard. Nothing to count, so nothing counted.
  assert.equal(await popup.title(), "Curio capture");
  assert.match(await popupIs("not-paired"), /^Not paired yet\n/);
  assert.deepEqual(await popup.locator("#steps li").allTextContents(), [
    "Start the app: pnpm app",
    "In a second terminal, run pnpm pair",
    "Paste the token it prints below",
  ]);
  assert.equal(await popup.evaluate(() => document.activeElement?.id), "token");
  assert.equal(await popup.locator("#counts").isHidden(), true);
  assert.equal(await popup.locator("#action").isHidden(), true);
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
  assert.match(await popupIs("not-paired"), /\n1 capture is kept here, /);
  assert.equal(await popup.locator("#counts").isVisible(), true);
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
  // The tab is named as the extension is, and wears the mark the toolbar's
  // icons were rendered from.
  assert.equal(await page.title(), "Curio");
  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  assert.match(icon ?? "", /^\/icon\.svg\?/);
  assert.equal(
    (await requestToApp("GET", icon ?? "")).body,
    readFileSync(join(repoRoot, "packages/extension/icons/icon.svg"), "utf8"),
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
  await popup.getByRole("button", { name: "Pair", exact: true }).click();

  await popupShows({ captured: 1, delivered: 1, pending: 0, rejected: 0 });
  assert.equal(await pairing(), "paired");
  assert.equal(await popup.locator("#last-error").isHidden(), true);
  // The token is not left on the page, and its field is folded away.
  await popupIs("up-to-date", "capturing");
  assert.equal(await popup.locator("#token").inputValue(), "");
  assert.equal(await popup.locator("#token").isHidden(), true);
  assert.equal(
    await popup.getByText("Pair with another token").isVisible(),
    true,
  );

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
  assert.match(
    await popupIs("refused"),
    /^The app did not accept this token\n.*so nothing was sent to it\./,
  );
  await pressAction("Check again");
  await popupShows({ captured: 5, delivered: 4, pending: 1 });

  await popupIs("refused");
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
  // Nothing is listening now. Checked again, the token is one the app has
  // not answered for, and the capture is still kept.
  await pressAction("Check again");
  assert.match(
    await popupIs("unconfirmed"),
    /^Waiting for the app\n.*nothing answered at 127\.0\.0\.1:47130\..* 1 capture is kept here/,
  );
  await popupShows({ captured: 5, delivered: 4, pending: 1 });

  await startApp();
  await pressAction("Check again");

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
  // its status every second, and that would start the worker again.
  assert.match(
    await popupIs("waiting"),
    new RegExp(`^${total} captures waiting for the app\\n`),
  );
  await pressAction("Send now");
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
    '{ type: "check-pairing" }',
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
  await listIsSettled(page);
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

/**
 * A row is placed by its measured height a frame or two after the list goes
 * live, and until then by a guess. A test that reads where things are, or
 * what is on screen, waits until nothing has moved for a few frames.
 */
const listIsSettled = (page: Page) =>
  page.evaluate(async () => {
    const places = () =>
      `${[...document.querySelectorAll("[data-row]")]
        .map((row) => Math.round(row.getBoundingClientRect().top))
        .join(",")}/${document.documentElement.scrollHeight}`;
    let last = "";
    let still = 0;
    for (let frame = 0; frame < 120 && still < 4; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = places();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  });

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
  // A row is drawn again when the list goes live, under new ids.
  await listIsLive(page);
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

test("a video plays in the library's own player: only a press on play asks for the file, the video keys work, M mutes, and the list keeps the rest of its own", {
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

  // M shows a post's media anywhere else in the list. Inside the player the
  // media is shown already, and M mutes and unmutes, as in any player; it
  // asks no host for anything. The list's other keys stay the list's: J and
  // K move between posts while the video plays on.
  const focusedPost = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-post]")].indexOf(
        document.activeElement?.closest("[data-post]") as Element,
      ),
    );
  const here = await focusedPost();
  await page.keyboard.press("m");
  assert.equal((await state()).muted, true);
  await player.getByRole("button", { name: "Unmute" }).waitFor();
  await page.keyboard.press("M");
  assert.equal((await state()).muted, false);
  await player.getByRole("button", { name: "Mute", exact: true }).waitFor();
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
  // else, plainly, and no other host was asked for anything: the poster was
  // never asked for a second time, and M, inside the player, showed no
  // further media.
  assertPlainVideoRequests(toVideoHost(mark), file);
  assert.deepEqual(
    fakeX.seen.slice(mark).filter(({ host }) => host !== MEDIA_HOSTS.video),
    [],
  );

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

test("the app tags nothing by itself until the owner's .env says so, and with that said and no API key the bookmarks still wait; nothing was sent or spent", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  // The app asks for a pass as it starts and a minute after a capture is
  // stored. By now it has made one over the bookmarks this run captured;
  // the wait is for a run that got here sooner.
  interface Status {
    appTagging: { on: boolean; message: string };
    lastAttempt: {
      status: string;
      message: string;
      waiting: number;
      classified: number;
      costUsd: number;
      problem: boolean;
    } | null;
    library: { classified: number; unclassified: number; spentUsd: number };
  }
  const passThatCameTo = (wanted: string) =>
    waitFor<Status>(
      `a tagging pass that came to "${wanted}"`,
      async () => {
        const answer = await requestToApp("GET", "/api/tagging");
        if (answer.status !== 200) return false;
        const read = JSON.parse(answer.body) as Status;
        return read.lastAttempt?.status === wanted ? read : false;
      },
      100_000,
    );
  const envFile = join(dataDirectory, ".env");
  store ??= openStore(join(dataDirectory, "bookmarks.db"));
  const untouched = (status: Status) => {
    const standing = summariseTagging(store as Store);
    assert.equal(status.lastAttempt?.problem, false);
    assert.ok((status.lastAttempt?.waiting ?? 0) >= 5);
    assert.equal(status.lastAttempt?.classified, 0);
    assert.equal(status.lastAttempt?.costUsd, 0);
    assert.deepEqual(status.library, {
      ...status.library,
      classified: 0,
      unclassified: standing.bookmarks,
      spentUsd: 0,
    });
    assert.ok(standing.bookmarks >= 5);
    assert.deepEqual(listTaggingRuns(store as Store), []);
  };

  // As installed, with nothing said: tagging by the app is off, which is a
  // state and not a failure, and every test above ran with it in this state.
  const off = await passThatCameTo("off");

  assert.equal(off.appTagging.on, false);
  for (const said of [off.appTagging.message, off.lastAttempt?.message ?? ""]) {
    assert.match(said, /^Tagging by the app is off/);
    // How to turn it on, in which file, and what does the same by hand.
    assert.ok(
      said.includes(`add the line X_BOOKMARKS_APP_TAGGING=on to ${envFile}`),
      "it says how to turn it on, beside this run's data and not in the repo",
    );
    assert.match(said, /pnpm tag classifies what is waiting/);
    assert.match(said, /pnpm tag --new-tags/);
  }
  untouched(off);
  // With its data directory moved, the app looks for the .env file there,
  // never at the repo's root, where the owner's is; and it makes none.
  assert.equal(existsSync(envFile), false, "the app does not create the file");

  // No request turns it on: the route has no way in but GET, and what a
  // GET carries changes nothing.
  const posted = await requestToApp(
    "POST",
    "/api/tagging",
    JSON.stringify({ appTagging: "on" }),
    { "content-type": "application/json" },
  );
  assert.equal(posted.status, 405);
  const asked = await requestToApp(
    "GET",
    "/api/tagging?appTagging=on&X_BOOKMARKS_APP_TAGGING=on",
  );
  assert.equal(asked.status, 200);
  const still = JSON.parse(
    (await requestToApp("GET", "/api/tagging")).body,
  ) as Status;
  assert.equal(still.appTagging.on, false);
  assert.equal(existsSync(envFile), false);

  // The owner writes the line, by hand, in their own file, and the app
  // reads it there as it stands: the status says so with nothing restarted.
  writeFileSync(envFile, "X_BOOKMARKS_APP_TAGGING=on\n", { mode: 0o600 });
  const edited = JSON.parse(
    (await requestToApp("GET", "/api/tagging")).body,
  ) as Status;
  assert.equal(edited.appTagging.on, true);
  assert.equal(edited.lastAttempt?.status, "off", "no pass has run since");

  // The next pass is the one an app makes as it starts. There is still no
  // key, so there is still nothing to send with, and the pass says that now.
  await stopApp("SIGKILL");
  await startApp();
  const on = await passThatCameTo("no-key");

  assert.equal(on.appTagging.on, true);
  assert.match(on.appTagging.message, /^Tagging by the app is on/);
  assert.match(on.lastAttempt?.message ?? "", /X_BOOKMARKS_ANTHROPIC_API_KEY/);
  assert.ok(
    on.lastAttempt?.message.includes(envFile),
    "the app looked for the key beside this run's data, not in the repo",
  );
  untouched(on);
  assert.equal(
    readFileSync(envFile, "utf8"),
    "X_BOOKMARKS_APP_TAGGING=on\n",
    "the app leaves the owner's file as the owner wrote it",
  );
  // Back to how the run found it, for whatever is tested after this.
  rmSync(envFile);
  const removed = JSON.parse(
    (await requestToApp("GET", "/api/tagging")).body,
  ) as Status;
  assert.equal(removed.appTagging.on, false);

  // Another site's page cannot read the status either.
  const fromElsewhere = await requestToApp("GET", "/api/tagging", undefined, {
    "sec-fetch-site": "cross-site",
  });
  assert.equal(fromElsewhere.status, 403);
});

// --- What a bookmark is filed under, before anything is ------------------

test("before anything is classified every screen says so, names the command, and holds no control that could start a run", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const from = seedLibrary();
  const standing = summariseTagging(from);
  assert.equal(standing.classified, 0, "nothing is classified yet in this run");

  // The library: one line in place of three lists of empty filters, and
  // every post says the same of itself.
  const page = await openLibrary("/");
  const nav = page.getByRole("navigation", { name: "Library" });
  assert.match((await nav.textContent()) ?? "", /Nothing is classified yet/);
  for (const group of ["Category", "Format", "Tags"]) {
    assert.equal(
      await nav.getByRole("heading", { name: group, exact: true }).count(),
      0,
    );
  }
  assert.equal(
    await nav.getByRole("link", { name: "status page" }).getAttribute("href"),
    "/status#tagging",
  );
  const firstPost = page.locator("[data-post]").first();
  assert.match(
    (await firstPost.locator('[data-edit="category"]').textContent()) ?? "",
    /Not classified yet/,
  );

  // The review queue and the proposals have nothing in them, and say why.
  await page.goto(`${APP_ORIGIN}/review`);
  const nothing = page.getByTestId("nothing-to-review");
  await nothing.waitFor();
  assert.match((await nothing.textContent()) ?? "", /Nothing to review yet/);
  for (const queue of ["little", "unfit", "unclear"]) {
    assert.equal(
      await page.getByTestId(`review-count-${queue}`).textContent(),
      "0",
    );
  }
  await page.goto(`${APP_ORIGIN}/tags`);
  await page.getByTestId("no-proposals").waitFor();
  assert.equal(
    await page.locator("[data-tag]").count(),
    listTags(from).length,
    "the vocabulary the library began with is listed all the same",
  );

  // The status page: the counts, the command, and nothing to press.
  await page.goto(`${APP_ORIGIN}/status`);
  const card = page.locator("#tagging");
  assert.equal(
    await card.getByTestId("tagging-classified").textContent(),
    `0 of ${standing.bookmarks}`,
  );
  assert.equal(
    await card.getByTestId("tagging-unclassified").textContent(),
    String(standing.bookmarks),
  );
  assert.equal(await card.getByTestId("tagging-spent").textContent(), "$0.00");
  // It says plainly that the app does not tag by itself, and how that is
  // changed: by a line of a file, which no control here writes.
  const byItself = card.getByTestId("tagging-app");
  assert.equal(await byItself.getAttribute("data-on"), null);
  assert.match(
    (await byItself.textContent()) ?? "",
    /^Off\. Tagging by the app is off: by itself the app sends nothing to the API and spends nothing\./,
  );
  assert.equal(
    await card.getByTestId("tagging-last-run").textContent(),
    "none yet",
  );
  const command =
    (await card.getByTestId("tagging-command").textContent()) ?? "";
  assert.match(command, /pnpm tag --dry-run/);
  assert.match(command, /pnpm tag(?! --dry-run)/);
  assert.equal(
    await card.locator("button, input, select, textarea, form").count(),
    0,
    "the card shows how tagging stands, and starts nothing",
  );
  assert.deepEqual(
    unique(
      await card
        .getByRole("link")
        .evaluateAll((links) =>
          links.map((link) => link.getAttribute("href") ?? ""),
        ),
    ),
    ["/review", "/tags"],
  );
  await page.close();
});

// --- The weekly digest ------------------------------------------------------

test("with no API key the digest page shows the week, says how a summary is written, and writes none; a stored summary is shown as text and points at posts on the page", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const from = seedLibrary();
  // The week most of the fixtures' posts were saved in.
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks) {
    const { key } = weekOf(bookmark.bookmarkedAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key = ""] = [...counts].toSorted((a, b) => b[1] - a[1])[0] ?? [];
  const inWeek = bookmarks.filter(
    (bookmark) => weekOf(bookmark.bookmarkedAt).key === key,
  );
  const ids = inWeek.map((bookmark) => bookmark.postId);
  const [first] = inWeek;
  assert.ok(first !== undefined && ids.length >= 4);
  const week = weekOf(first.bookmarkedAt);
  const mark = fakeX.seen.length;

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const weekShown = () =>
    page.getByTestId("digest-week").getAttribute("data-week");
  const postsShown = () =>
    page
      .getByTestId("digest-posts")
      .locator("[data-post]")
      .evaluateAll((posts) =>
        posts.map((post) => post.getAttribute("data-post-id") ?? ""),
      );

  // The free part: the week, its count and every post of it, newest first.
  await page.goto(`${APP_ORIGIN}/digest?week=${key}`);
  assert.equal(await weekShown(), key);
  assert.equal(
    await page.getByTestId("digest-count").textContent(),
    `${ids.length} bookmarks saved`,
  );
  assert.deepEqual(await postsShown(), ids);
  // Nothing is filed yet, so there is nothing to count or to suggest.
  assert.match(
    (await page.getByTestId("digest-unfiled").textContent()) ?? "",
    /is filed under a category yet/,
  );
  assert.match(
    (await page.getByTestId("digest-no-suggestions").textContent()) ?? "",
    /No bookmark has been filed yet/,
  );

  // The written part: there is none, the page says how the owner gets one,
  // and the app has made no attempt at one. There is no key to make it with.
  const howTo = page.getByTestId("digest-howto");
  assert.match(
    (await howTo.textContent()) ?? "",
    /No summary has been written for this week/,
  );
  assert.match(
    (await howTo.textContent()) ?? "",
    new RegExp(`pnpm digest --week ${key} --dry-run`),
  );
  assert.equal(await page.getByTestId("digest-written").count(), 0);
  assert.deepEqual(listDigestRuns(from), []);
  assert.equal(existsSync(join(dataDirectory, ".env")), false);

  // With no week named, it is the week that last reached its Sunday evening.
  await page.goto(`${APP_ORIGIN}/digest`);
  const latest = latestWeekEnded(new Date()).key;
  assert.equal(await weekShown(), latest);
  await page.goto(`${APP_ORIGIN}/digest?week=not-a-week`);
  assert.equal(await weekShown(), latest);

  // The library leads here.
  const library = await openLibrary("/");
  assert.equal(
    await library
      .getByRole("link", { name: "Weekly digest" })
      .getAttribute("href"),
    "/digest",
  );
  await library.close();

  // The classifier files four of the week's bookmarks, and the owner has a
  // summary written. Both are put in the library as core stores them; what
  // the summary says is what a model talked into anything might say.
  const [a = "", b = "", c = "", d = ""] = ids;
  const file = (
    postId: string,
    category: string,
    parts: { little?: boolean; proposed?: string[] } = {},
  ) =>
    recordClassification(from, {
      postId,
      category,
      format: "guide",
      tags: [],
      tooLittleText: parts.little === true,
      proposedTags: parts.proposed ?? [],
      instructionsVersion: 1,
      model: "a-model",
    });
  file(a, "web-dev", { proposed: ["drizzle"] });
  file(b, "web-dev", { proposed: ["drizzle"] });
  file(c, "other");
  file(d, "other", { little: true });
  const run = startDigestRun(from, {
    week,
    startedBy: "owner",
    model: "a-model",
    instructionsVersion: 1,
    bookmarksInWeek: ids.length,
    postIds: ids,
    capUsd: 0.5,
  });
  const hostile =
    'A week of walkthroughs. <img src="/pwned.png" onerror="window.pwned=1"><script>window.pwned=1</script>';
  finishDigestRun(from, run.id, {
    outcome: "written",
    text: {
      overview: hostile,
      themes: [
        {
          title: "Walkthroughs <b>in bold</b>",
          summary: "Two posts walk through one thing.",
          postIds: [b, a],
        },
      ],
      worthRevisiting: [{ postId: c, why: "It is the fullest." }],
    },
    inputTokens: 1000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 500,
    costUsd: 0.014,
    unansweredRequests: 0,
  });

  await page.goto(`${APP_ORIGIN}/digest?week=${key}`);
  const written = page.getByTestId("digest-written");
  // Shown as text: the markup is letters on the page, and nothing ran.
  assert.equal(
    await page.getByTestId("digest-overview").textContent(),
    hostile,
  );
  assert.equal(await written.locator("img, script, b").count(), 0);
  assert.equal(
    await page.evaluate(() => "pwned" in window),
    false,
    "nothing the summary said was run",
  );
  assert.match(
    (await written.textContent()) ?? "",
    /Walkthroughs <b>in bold<\/b>/,
  );
  assert.match(
    (await written.textContent()) ?? "",
    /Written by Claude \(a-model\)/,
  );
  assert.equal(await page.getByTestId("digest-howto").count(), 0);
  // It points at bookmarks by links to posts on this page, in its order.
  const references = written.locator("a[data-reference]");
  assert.deepEqual(
    await references.evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")),
    ),
    [b, a, c].map((id) => `#post-${id}`),
  );
  await references.first().click();
  await waitFor(
    "the reference to lead to its post",
    async () => new URL(page.url()).hash === `#post-${b}`,
  );
  assert.equal(
    await page.evaluate((id) => {
      const post = document.getElementById(`post-${id}`);
      if (post === null) return false;
      const { top, bottom } = post.getBoundingClientRect();
      return bottom > 0 && top < window.innerHeight;
    }, b),
    true,
    "the post it leads to is on screen",
  );

  // What was saved, by what it is filed under; and what that suggests.
  const saved = (await page.getByTestId("digest-counts").textContent()) ?? "";
  assert.match(saved, /Web development\s*2/);
  assert.match(saved, /Other\s*2/);
  assert.match(
    (await page.getByTestId("digest-unfitted").textContent()) ?? "",
    /^1 bookmark saved this week said enough and still fitted no category\./,
  );
  assert.equal(
    await page.getByTestId("digest-unfitted-link").getAttribute("href"),
    "/?cat=other&text=enough",
  );
  const proposal = page.locator('a[data-proposal="drizzle"]');
  assert.equal(await proposal.getAttribute("href"), "/?proposed=drizzle");
  assert.match((await proposal.textContent()) ?? "", /drizzle\s*2 bookmarks/);

  // On a narrow screen nothing is cut off, and the other weeks close the page.
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`${APP_ORIGIN}/digest?week=${key}`);
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
    0,
    "the page does not scroll sideways at 320 pixels",
  );
  const otherWeeks = page.getByRole("navigation", { name: "Other weeks" });
  const thisWeek = otherWeeks.locator('a[aria-current="page"]');
  assert.equal(await thisWeek.getAttribute("href"), `/digest?week=${key}`);
  assert.equal(
    await thisWeek.getByRole("img").getAttribute("aria-label"),
    "Summary written",
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Library", exact: true })
      .getAttribute("href"),
    "/",
  );

  // All of it from this app alone: no post's media, no avatar, nothing of X.
  assert.deepEqual(
    fakeX.seen.slice(mark),
    [],
    "the digest asked no other host for anything",
  );
  // And the page wrote nothing: the one run is the one this test stored.
  assert.deepEqual(
    listDigestRuns(from).map(({ id }) => id),
    [run.id],
  );
  await page.close();
});

// --- What a bookmark is filed under ------------------------------------------

/**
 * What the classifier is made to have said of the library's first bookmarks,
 * newest first: a few categories and formats, the two kinds of "other", two
 * unclear formats, and proposals, one of them under two spellings. No model
 * is asked and nothing is spent: the answers are written through core, as
 * the classifier writes them, into this run's own database.
 */
const ANSWERS: Omit<
  NewClassification,
  "postId" | "instructionsVersion" | "model"
>[] = [
  {
    category: "web-dev",
    format: "guide",
    tags: ["nextjs", "react"],
    proposedTags: ["server-actions"],
    tooLittleText: false,
  },
  {
    category: "web-dev",
    format: "tip",
    tags: ["react"],
    proposedTags: ["server-actions", "prisma-orm"],
    tooLittleText: false,
  },
  {
    category: "design",
    format: "showcase",
    tags: ["animation"],
    proposedTags: ["server-action"],
    tooLittleText: false,
  },
  { category: "other", format: "unclear", tags: [], tooLittleText: true },
  { category: "other", format: "discussion", tags: [], tooLittleText: false },
  {
    category: "tools",
    format: "unclear",
    tags: ["self-hosting"],
    proposedTags: ["htmx"],
    tooLittleText: false,
  },
];
let filedPosts: string[] | undefined;

/** Files the library's first bookmarks as `ANSWERS` says, once, and returns their ids in that order. */
function seedLabels(): string[] {
  if (filedPosts !== undefined) return filedPosts;
  const from = seedLibrary();
  const newest = libraryBookmarks().slice(0, ANSWERS.length);
  assert.equal(newest.length, ANSWERS.length);
  newest.forEach(({ postId }, index) => {
    const answer = ANSWERS[index];
    assert.ok(answer);
    recordClassification(from, {
      ...answer,
      postId,
      instructionsVersion: 1,
      model: "a-model",
    });
  });
  filedPosts = newest.map(({ postId }) => postId);
  return filedPosts;
}

function labelsOf(postId: string | undefined) {
  const bookmark = getBookmark(seedLibrary(), postId ?? "");
  assert.ok(bookmark, `bookmark ${postId} is in the library`);
  return bookmark.labels;
}

const categoryLabel = (id: string) =>
  TAXONOMY.categories.find((entry) => entry.id === id)?.label ?? id;
const formatLabel = (id: string) =>
  TAXONOMY.formats.find((entry) => entry.id === id)?.label ?? id;
/** The digit that chooses an entry in an open menu: its place in the taxonomy, from 1. */
const digitOf = (entries: readonly { id: string }[], id: string) =>
  String(entries.findIndex((entry) => entry.id === id) + 1);

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A filter in the side column, by the name it starts with. */
const filterLink = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: new RegExp(`^${escaped(name)}`) });

/** The number beside a filter. */
async function countBeside(link: Locator): Promise<number> {
  const [, count = ""] =
    /([0-9,]+)(?:Selected\. Select to remove\.)?$/.exec(
      (await link.textContent()) ?? "",
    ) ?? [];
  return Number(count.replaceAll(",", ""));
}

/** Every post id core lists for a filter, newest saved first. */
function listed(filter: Parameters<typeof listBookmarks>[1]): string[] {
  return listBookmarks(seedLibrary(), {
    ...filter,
    limit: MAX_PAGE_SIZE,
  }).bookmarks.map(({ postId }) => postId);
}

/** How many bookmarks core counts for a filter. */
const howMany = (filter: Parameters<typeof listBookmarks>[1]) =>
  listBookmarks(seedLibrary(), { ...filter, limit: 1 }).total;

const focusedPostId = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest("[data-post]")
        ?.getAttribute("data-post-id") ?? null,
  );

/**
 * Chooses a tag in a list that a button opens: waits for the list's field to
 * take the keyboard, types enough of the name to find it, and presses Enter.
 */
async function pickTag(page: Page, opener: Locator, text: string) {
  await opener.click();
  await waitFor("the list's field to take the keyboard", () =>
    page.evaluate(
      () =>
        document.activeElement?.tagName === "INPUT" &&
        document.activeElement.getAttribute("placeholder") === "Find a tag",
    ),
  );
  await page.keyboard.type(text);
  await page.getByRole("option").first().waitFor();
  await page.keyboard.press("Enter");
}

/** What the app was asked to change by a page, as paths. */
function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  return writes;
}

test("category, format and tag filters narrow the library with a count beside each, and compose with a search and every other filter", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const filed = seedLabels();
  const from = seedLibrary();
  const total = libraryBookmarks().length;
  const mark = fakeX.seen.length;
  const page = await openLibrary("/");
  /** What the count line reads for a filter, as core counts it. */
  const narrowedTo = (filter: Parameters<typeof listBookmarks>[1]) =>
    `${howMany(filter)} of ${total} bookmarks`;

  // Each category and format with the number core counts for it.
  const summary = summariseMatches(from);
  const counted = new Map<string | null, number>(
    summary.categories.map(({ category, bookmarks }) => [category, bookmarks]),
  );
  for (const { id } of TAXONOMY.categories) {
    if (id === OTHER_CATEGORY) continue;
    const link = filterLink(page, categoryLabel(id));
    if ((counted.get(id) ?? 0) === 0) {
      // A filter that would leave nothing is shown, and is not a link.
      assert.equal(await link.count(), 0, id);
    } else {
      assert.equal(await countBeside(link), counted.get(id), id);
    }
  }
  for (const { format, bookmarks } of summary.formats) {
    if (format === null) continue;
    assert.equal(
      await countBeside(filterLink(page, formatLabel(format))),
      bookmarks,
      format,
    );
  }
  // The two reasons a bookmark is under "other", apart; and what is filed
  // under nothing yet.
  const other = categoryLabel(OTHER_CATEGORY);
  assert.ok(summary.tooLittleText >= 1);
  assert.equal(
    await countBeside(filterLink(page, `${other}: too little text`)),
    summary.tooLittleText,
  );
  assert.equal(
    await countBeside(filterLink(page, `${other}: no category fits`)),
    (counted.get(OTHER_CATEGORY) ?? 0) - summary.tooLittleText,
  );
  assert.equal(
    await countBeside(filterLink(page, "Not classified yet")),
    counted.get(null),
  );
  assert.equal(counted.get(null), howMany({ classified: false }));

  // A category is a link, like every filter: it narrows the list to what
  // core lists under it, and each post says what it is filed under.
  await filterLink(page, categoryLabel("web-dev")).click();
  await page.waitForURL((url) => url.searchParams.get("cat") === "web-dev");
  await waitFor(
    "the category to narrow the list",
    async () =>
      (await resultCount(page)) === narrowedTo({ category: "web-dev" }),
  );
  assert.ok(howMany({ category: "web-dev" }) >= 2);
  assert.deepEqual(await everyPost(page), listed({ category: "web-dev" }));
  assert.equal(
    await filterLink(page, categoryLabel("web-dev")).getAttribute(
      "aria-current",
    ),
    "true",
  );
  const first = page.locator(`[data-post-id="${filed[0]}"]`).first();
  assert.equal(
    await first.locator('[data-edit="category"]').getAttribute("data-value"),
    "web-dev",
  );
  assert.match(
    (await first.locator('[data-edit="category"]').textContent()) ?? "",
    new RegExp(escaped(categoryLabel("web-dev"))),
  );
  assert.match(
    (await first.locator('[data-edit="format"]').textContent()) ?? "",
    new RegExp(escaped(formatLabel("guide"))),
  );
  assert.deepEqual(await first.locator("[data-labels] a").allTextContents(), [
    "#nextjs",
    "#react",
  ]);

  // A format and a tag on top of it: each narrows what the others left.
  const tips = { category: "web-dev", format: "tip" };
  await filterLink(page, formatLabel("tip")).click();
  await page.waitForURL((url) => url.searchParams.get("fmt") === "tip");
  await waitFor(
    "the format to narrow it further",
    async () => (await resultCount(page)) === narrowedTo(tips),
  );
  assert.equal(
    await countBeside(filterLink(page, "react")),
    howMany({ ...tips, tags: ["react"] }),
  );
  await filterLink(page, "react").click();
  await page.waitForURL((url) => url.searchParams.get("tag") === "react");
  await listIsLive(page);
  assert.deepEqual(
    await shownPosts(page),
    listed({ ...tips, tags: ["react"] }),
  );
  assert.ok((await shownPosts(page)).includes(filed[1] ?? ""));
  const chips = await page
    .getByRole("link", { name: /^Remove filter: / })
    .allTextContents();
  assert.deepEqual(
    chips.map((chip) => chip.replace("Remove filter: ", "")),
    [categoryLabel("web-dev"), formatLabel("tip"), "#react"],
  );
  // The other categories stay on offer while one is chosen, each with what
  // choosing it would leave of the rest of the filters.
  assert.equal(
    await countBeside(filterLink(page, categoryLabel("web-dev"))),
    howMany({ category: "web-dev", format: "tip", tags: ["react"] }),
  );

  // With a feature of the post, and with a search.
  await page.goto(`${APP_ORIGIN}/?cat=web-dev&has=link`);
  await waitFor(
    "the category and the feature together",
    async () =>
      (await resultCount(page)) ===
      narrowedTo({ category: "web-dev", hasLink: true }),
  );
  const author = getBookmark(from, filed[0] ?? "");
  assert.ok(author);
  const query = `@${author.authorHandle}`;
  const found = searchBookmarks(from, {
    query,
    category: "web-dev",
    limit: MAX_PAGE_SIZE,
  });
  assert.ok(found.total >= 1);
  await page.goto(`${APP_ORIGIN}/?cat=web-dev&q=${encodeURIComponent(query)}`);
  await listIsLive(page);
  assert.equal(await resultCount(page), `${found.total} of ${total} bookmarks`);
  assert.deepEqual(
    await everyPost(page),
    found.hits.map(({ bookmark }) => bookmark.postId),
  );

  // What is not classified yet, and each reason for "other" by itself.
  await page.goto(`${APP_ORIGIN}/?cat=none`);
  await listIsLive(page);
  assert.equal(await resultCount(page), narrowedTo({ classified: false }));
  assert.match(
    (await page
      .locator("[data-post]")
      .first()
      .locator('[data-edit="category"]')
      .textContent()) ?? "",
    /Not classified yet/,
  );
  await page.goto(`${APP_ORIGIN}/`);
  await filterLink(page, `${other}: too little text`).click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get("cat") === OTHER_CATEGORY &&
      url.searchParams.get("text") === "little",
  );
  await listIsLive(page);
  const little = listed({ category: OTHER_CATEGORY, tooLittleText: true });
  assert.ok(little.includes(filed[3] ?? ""));
  assert.deepEqual(await everyPost(page), little);
  assert.match(
    (await page.locator("[data-post] [data-labels]").first().textContent()) ??
      "",
    /too little text to tell/,
  );

  // A tag written another way in the address is read as its tag, and a
  // text that is no tag finds nothing and says so.
  await page.goto(`${APP_ORIGIN}/?tag=Next.js`);
  await listIsLive(page);
  assert.deepEqual(await shownPosts(page), listed({ tags: ["nextjs"] }));
  assert.equal(
    await filterLink(page, "nextjs").getAttribute("aria-current"),
    "true",
  );
  assert.deepEqual(
    await page
      .getByRole("link", { name: /^Remove filter: / })
      .allTextContents(),
    ["Remove filter: #nextjs"],
  );
  await page.goto(`${APP_ORIGIN}/?tag=no-such-tag`);
  await page.getByTestId("no-results").waitFor();
  assert.deepEqual(
    await page
      .getByRole("link", { name: /^Remove filter: / })
      .allTextContents(),
    ["Remove filter: #no-such-tag is not a tag"],
  );

  assert.deepEqual(
    fakeX.seen.slice(mark),
    [],
    "browsing by what bookmarks are filed under asked no other host for anything",
  );
  await page.close();
});

test("a post's category, format and tags are corrected from the keyboard and by pointer, kept as the owner's word, and are there after a reload", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const filed = seedLabels();
  const target = filed[0];
  const mark = fakeX.seen.length;
  const page = await openLibrary("/?cat=web-dev");
  const writes = watchWrites(page);
  const post = page.locator(`[data-post-id="${target}"]`).first();
  const control = (part: string) => post.locator(`[data-edit="${part}"]`);
  const menu = page.getByRole("menu");
  // The list as it stands when the page is opened: what J moves through.
  const inOrder = listed({ category: "web-dev" });
  /** A menu takes the keyboard a moment after it opens; a digit is for it. */
  const menuHasTheKeyboard = () =>
    waitFor("the menu to take the keyboard", () =>
      page.evaluate(
        () => document.activeElement?.closest('[role="menu"]') != null,
      ),
    );
  /** A menu closes and hands the keyboard back to the post it was opened on. */
  const backOnThePost = () =>
    waitFor(
      "the keyboard to be back on the post",
      async () =>
        (await menu.count()) === 0 && (await focusedPostId(page)) === target,
    );

  // J goes to the first post. C opens its category, and a digit chooses by
  // the place in the list, which is the taxonomy's order.
  await page.keyboard.press("j");
  assert.equal(await focusedPostId(page), target);
  await page.keyboard.press("c");
  await menu.waitFor();
  assert.equal(
    await menu.getByRole("menuitemradio", { checked: true }).textContent(),
    `${digitOf(TAXONOMY.categories, "web-dev")}${categoryLabel("web-dev")}`,
  );
  await menuHasTheKeyboard();
  await page.keyboard.press(digitOf(TAXONOMY.categories, "design"));
  await waitFor(
    "the correction to be stored",
    () => labelsOf(target).category === "design",
  );
  // The owner's word, kept apart from the classifier's answer.
  assert.deepEqual(labelsOf(target).corrected, {
    category: true,
    format: false,
    tags: false,
  });
  assert.equal(labelsOf(target).classification?.category, "web-dev");
  await waitFor(
    "the row to show it",
    async () =>
      (await control("category").getAttribute("data-value")) === "design",
  );
  await backOnThePost();
  // The counts beside the filters follow, and the list keeps its place and
  // the post, which the chosen filter no longer matches.
  await waitFor(
    "the counts to follow",
    async () =>
      (await countBeside(filterLink(page, categoryLabel("web-dev")))) ===
      howMany({ category: "web-dev" }),
  );
  assert.equal(await focusedPostId(page), target);

  // R is the format.
  await page.keyboard.press("r");
  await menuHasTheKeyboard();
  await page.keyboard.press(digitOf(TAXONOMY.formats, "showcase"));
  await waitFor(
    "the format to be stored",
    () => labelsOf(target).format === "showcase",
  );
  await backOnThePost();

  // T is the tags: a field to find one in, by its name or another way of
  // writing it, and Enter puts it on or takes it off.
  const shownTags = () => post.locator("[data-labels] a").allTextContents();
  /** Finds a tag in the open list and switches it, then waits for the row to show the app's answer. */
  const switchTag = async (text: string, expected: string[]) => {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await waitFor(
      `the row to show ${expected.join(" ")}`,
      async () => (await shownTags()).join(" ") === expected.join(" "),
    );
  };
  await page.keyboard.press("t");
  await waitFor("the tag field to take the keyboard", () =>
    page.evaluate(() => document.activeElement?.tagName === "INPUT"),
  );
  assert.equal(
    await page.evaluate(
      () => (document.activeElement as HTMLInputElement).value,
    ),
    "",
    "the key that opened the field was not typed into it",
  );
  await switchTag("secur", ["#nextjs", "#react", "#security"]);
  // By another way of writing it.
  await switchTag("reklam", ["#ads", "#nextjs", "#react", "#security"]);
  // One the classifier gave is taken off, and stays off whatever it says.
  await switchTag("react", ["#ads", "#nextjs", "#security"]);
  assert.deepEqual(labelsOf(target).tags, ["ads", "nextjs", "security"]);
  assert.deepEqual(labelsOf(target).classification?.tags, ["nextjs", "react"]);
  assert.equal(labelsOf(target).corrected.tags, true);
  // Put back, it is the classifier's again.
  await switchTag("react", ["#ads", "#nextjs", "#react", "#security"]);
  assert.deepEqual(labelsOf(target).tags, [
    "ads",
    "nextjs",
    "react",
    "security",
  ]);
  await page.keyboard.press("Escape");
  // The keyboard is back on the post, and J moves on from it.
  await backOnThePost();
  await page.keyboard.press("j");
  assert.equal(inOrder[0], target);
  assert.equal(await focusedPostId(page), inOrder[1]);

  // By pointer: the category says the owner set it, and hands it back.
  await control("category").click();
  await menu.waitFor();
  await menu
    .getByRole("menuitem", {
      name: `Use the classifier’s: ${categoryLabel("web-dev")}`,
    })
    .click();
  await waitFor(
    "the category to be the classifier's again",
    () =>
      labelsOf(target).category === "web-dev" &&
      !labelsOf(target).corrected.category,
  );

  // All of it is in the library, not in the page: a reload shows the same.
  await page.reload();
  await page.getByTestId("result-count").waitFor();
  await listIsLive(page);
  assert.equal(await control("category").getAttribute("data-value"), "web-dev");
  assert.equal(await control("category").getAttribute("data-corrected"), null);
  assert.equal(await control("format").getAttribute("data-value"), "showcase");
  assert.equal(await control("format").getAttribute("data-corrected"), "");
  assert.deepEqual(await post.locator("[data-labels] a").allTextContents(), [
    "#ads",
    "#nextjs",
    "#react",
    "#security",
  ]);

  // Every change went to the one route, on this app, and nothing was asked
  // of any other host.
  assert.ok(writes.length >= 7);
  assert.deepEqual(unique(writes), ["POST /api/owner/correct"]);
  assert.deepEqual(fakeX.seen.slice(mark), []);
  await page.close();
});

test("only the app's own page changes the library: another site's page, a rebound domain and a program without a browser's word are refused, and what a program that writes its own headers can do is said", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const filed = seedLabels();
  const from = seedLibrary();
  const target = filed[2];
  const path = "/api/owner/correct";
  const body = JSON.stringify({ postId: target, category: "life" });
  const standing = () =>
    JSON.stringify([
      labelsOf(target),
      getVocabulary(from),
      listTagProposals(from),
    ]);
  const before = standing();
  assert.equal(labelsOf(target).category, "design");

  const attack = (page: Page) =>
    page.evaluate(
      async ([url, body]) => {
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
          // "Simple" requests, sent without asking first.
          plain: await attempt({
            mode: "no-cors",
            headers: { "content-type": "text/plain" },
          }),
          form: await attempt({
            mode: "no-cors",
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }),
          // As the app's own page sends it: the browser asks leave first.
          json: await attempt({
            headers: { "content-type": "application/json" },
          }),
        };
      },
      [`${APP_ORIGIN}${path}`, body] as const,
    );
  const refused = { plain: "blocked", form: "blocked", json: "blocked" };

  // A page on a public site, as x.com is, and one on a site Chrome lets
  // through to this computer. Neither changes anything, and neither is
  // shown an answer.
  assert.deepEqual(await attack(xPage), refused);
  const otherSite = await context.newPage();
  await otherSite.goto("https://other-site.example/");
  assert.deepEqual(await attack(otherSite), refused);
  await otherSite.close();
  assert.equal(standing(), before);

  // A domain re-pointed at this computer. The browser takes its page and
  // the app for one origin, so nothing stops the request on the way, and it
  // says "same-origin" of itself. The app is asked for under the wrong name
  // and refuses: to change anything, and to show anything.
  const rebound = await context.newPage();
  const landing = await rebound.goto(`${REBOUND_ORIGIN}/`);
  assert.equal(landing?.status(), 403);
  assert.equal(new URL(rebound.url()).origin, REBOUND_ORIGIN);
  const fromRebound = await rebound.evaluate(async (body) => {
    const write = await fetch("/api/owner/correct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const read = await fetch("/api/library");
    const page = await fetch("/tags");
    return {
      write: [write.type, write.status],
      read: read.status,
      page: page.status,
    };
  }, body);
  await rebound.close();
  assert.deepEqual(fromRebound, {
    write: ["basic", 403],
    read: 403,
    page: 403,
  });
  assert.equal(standing(), before);

  // A program on this computer, not a browser. Without the headers a browser
  // writes it is refused; so is the extension, whose door is another.
  const asPage = {
    origin: APP_ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const attempts = {
    "nothing a browser would say": await postToApp(path, body, {
      "content-type": "application/json",
    }),
    "the app's origin, and no word on where it came from": await postToApp(
      path,
      body,
      { origin: APP_ORIGIN, "content-type": "application/json" },
    ),
    "another site's origin": await postToApp(path, body, {
      ...asPage,
      origin: "https://evil.example",
    }),
    "a cross-site mark": await postToApp(path, body, {
      ...asPage,
      "sec-fetch-site": "cross-site",
    }),
    "another name for this computer": await postToApp(path, body, {
      ...asPage,
      host: "evil.example:47130",
      origin: "http://evil.example:47130",
    }),
    "a form's content type": await postToApp(path, body, {
      ...asPage,
      "content-type": "text/plain",
    }),
    "the extension's signature": await postToApp(path, body, {
      origin: EXTENSION_ORIGIN,
      ...(await signedHeaders(token, path, body)),
    }),
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(attempts).map(([name, { status }]) => [name, status]),
    ),
    {
      "nothing a browser would say": 403,
      "the app's origin, and no word on where it came from": 403,
      "another site's origin": 403,
      "a cross-site mark": 403,
      "another name for this computer": 403,
      "a form's content type": 415,
      "the extension's signature": 403,
    },
  );
  assert.equal(standing(), before);
  // And the page's request does not open the extension's door.
  const captured = await postToApp(INGEST_PATH, "{}", asPage);
  assert.equal(captured.status, 403);

  // What is not defended, stated as a test: a program on this computer can
  // write every header a browser would, and is then let in. It can already
  // read every page of the app. What it can change this way is what a
  // bookmark is filed under and the vocabulary; a capture still needs the
  // token, and nothing here deletes a bookmark.
  const forged = await postToApp(path, body, asPage);
  assert.equal(forged.status, 200);
  assert.equal(labelsOf(target).category, "life");
  const undone = await postToApp(
    path,
    JSON.stringify({ postId: target, category: null }),
    asPage,
  );
  assert.equal(undone.status, 200);
  assert.equal(standing(), before);
});

test("the classifier's proposals are decided on the Tags page: the posts behind one, a new tag, another way of writing a tag, and no tag at all", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const filed = seedLabels();
  const from = seedLibrary();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const writes = watchWrites(page);
  await page.goto(`${APP_ORIGIN}/tags`);
  const proposal = (name: string) => page.locator(`[data-proposal="${name}"]`);
  const said = (text: string | RegExp) =>
    page.getByText(text).first().waitFor();
  const listedHere = () =>
    page
      .locator("[data-proposal]")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("data-proposal") ?? ""),
      );
  /** The proposals core lists at a threshold, by the name of each group. */
  const proposed = (minBookmarks: number) => {
    const { proposals, total, belowThreshold } = listTagProposals(from, {
      minBookmarks,
    });
    return {
      names: proposals.map(({ proposal }) => proposal),
      total,
      belowThreshold,
    };
  };

  // The list opens on what was proposed for two bookmarks or more, in core's
  // groups, and counts the rest. An earlier test left a proposal of its own
  // in the library, so what is expected is read from core.
  const usual = proposed(2);
  assert.ok(usual.names.includes("server-actions"));
  assert.ok(usual.belowThreshold >= 2);
  assert.deepEqual(await listedHere(), usual.names);
  assert.equal(
    await page.getByTestId("proposal-count").textContent(),
    `${usual.total} proposed for 2 bookmarks or more. Show the ${usual.belowThreshold} proposed for fewer`,
  );
  // The page says plainly that the app does not tag by itself, and what
  // then asks about the bookmarks that mention a new tag.
  assert.match(
    (await page.getByTestId("tags-app-tagging").textContent()) ?? "",
    /The app’s own tagging is off, so bookmarks that only mention a new tag wait for pnpm tag --new-tags\./,
  );

  // The posts behind a proposal are a filter of the library.
  const behind = proposal("server-actions").getByRole("link", {
    name: "Proposed for 2 bookmarks",
  });
  assert.equal(await behind.getAttribute("href"), "/?proposed=server-actions");
  const posts = await openLibrary("/?proposed=server-actions");
  assert.deepEqual(unique(await everyPost(posts)), unique(filed.slice(0, 2)));
  assert.deepEqual(
    await posts
      .getByRole("link", { name: /^Remove filter: / })
      .allTextContents(),
    ["Remove filter: Proposed tag: server-actions"],
  );
  await posts.close();

  // The other spelling in its group is core's guess. It is offered unticked;
  // ticked, it is decided on together with the name.
  const other = proposal("server-actions").getByRole("checkbox");
  assert.equal(await other.getAttribute("aria-checked"), "false");
  await other.click();
  assert.equal(await other.getAttribute("aria-checked"), "true");
  await proposal("server-actions")
    .getByRole("button", { name: "Accept as a new tag" })
    .click();
  await said("“server-actions” is a tag now. 3 bookmarks have it now.");
  assert.equal(resolveTag(from, "server-actions"), "server-actions");
  assert.equal(resolveTag(from, "server-action"), "server-actions");
  for (const postId of filed.slice(0, 3)) {
    assert.ok(labelsOf(postId).tags.includes("server-actions"), postId);
  }
  await proposal("server-actions").waitFor({ state: "detached" });
  assert.match(
    (await page.locator('[data-tag="server-actions"]').textContent()) ?? "",
    /also server-action.*3 bookmarks/,
  );

  // The rest of this test's were each proposed once.
  await page
    .getByRole("link", { name: /^Show the [0-9]+ proposed for fewer$/ })
    .click();
  await page.waitForURL((url) => url.searchParams.get("least") === "1");
  await proposal("prisma-orm").waitFor();
  assert.deepEqual(await listedHere(), proposed(1).names);

  // Another way of writing a tag there is, chosen from the vocabulary.
  await pickTag(
    page,
    proposal("prisma-orm").getByText("Alias of a tag"),
    "self-h",
  );
  await said(
    "“prisma-orm” is another way of writing “self-hosting” now. 1 bookmark got the tag.",
  );
  assert.equal(resolveTag(from, "prisma-orm"), "self-hosting");
  assert.ok(labelsOf(filed[1]).tags.includes("self-hosting"));

  // No tag at all. It does not come back, so it takes a second press.
  const waiting = proposed(1).total;
  const dismiss = proposal("htmx").getByRole("button", { name: /^Dismiss/ });
  await dismiss.click();
  assert.equal(await dismiss.textContent(), "Dismiss for good?");
  assert.equal(proposed(1).total, waiting, "one press dismisses nothing");
  await dismiss.click();
  await said(/^Dismissed\. It was proposed for 1 bookmark/);
  assert.equal(proposed(1).total, waiting - 1);
  assert.equal(resolveTag(from, "htmx"), undefined);
  await proposal("htmx").waitFor({ state: "detached" });
  assert.deepEqual(await listedHere(), proposed(1).names);

  assert.deepEqual(unique(writes), [
    "POST /api/owner/accept-proposal",
    "POST /api/owner/dismiss-proposals",
  ]);
  await page.close();
});

test("the vocabulary is kept on the Tags page: a tag is added, renamed, given another name, merged, retired and restored, and its bookmarks go with it", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const filed = seedLabels();
  const from = seedLibrary();
  const tagged = filed[4];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${APP_ORIGIN}/tags`);
  const row = (tag: string) => page.locator(`[data-tag="${tag}"]`);
  const editor = (tag: string) => page.locator(`[data-tag-editor="${tag}"]`);
  const edit = async (tag: string) => {
    await row(tag).getByRole("button", { name: /^Edit/ }).click();
    await editor(tag).waitFor();
    return editor(tag);
  };
  const said = (text: string | RegExp) =>
    page.getByText(text).first().waitFor();
  const names = () => listTags(from).map(({ tag }) => tag);

  // Two new tags. A name is folded to the form tags are written in.
  for (const [typed, tag] of [
    ["E2E One", "e2e-one"],
    ["e2e-two", "e2e-two"],
  ] as const) {
    await page.getByLabel("Add a tag").fill(typed);
    await page.getByRole("button", { name: "Add tag" }).click();
    await said(`“${tag}” is a tag now.`);
    await row(tag).waitFor();
  }
  // What cannot be a tag is refused, and says why.
  await page.getByLabel("Add a tag").fill("no tag!");
  await page.getByRole("button", { name: "Add tag" }).click();
  await said("Nothing was changed");
  await said(/cannot be a tag\. A tag is lowercase letters and digits/);
  assert.ok(!names().includes("no-tag!"));

  // One of them is on a bookmark, put there by the owner.
  correctBookmark(from, tagged ?? "", { addTags: ["e2e-one"] });
  await page.reload();
  assert.match((await row("e2e-one").textContent()) ?? "", /1 bookmark/);

  // Renamed, the bookmark has it under the new name and the old one finds it.
  await (await edit("e2e-one")).getByLabel("Name").fill("e2e-uno");
  await editor("e2e-one").getByRole("button", { name: "Rename" }).click();
  await said(
    "“e2e-one” is “e2e-uno” now, on 1 bookmark. The old name still finds it.",
  );
  assert.ok(labelsOf(tagged).tags.includes("e2e-uno"));
  assert.equal(resolveTag(from, "e2e-one"), "e2e-uno");
  await row("e2e-uno").waitFor();

  // Another way of writing it, added and taken back.
  const uno = await edit("e2e-uno");
  await uno
    .getByRole("textbox", { name: "Another way of writing e2e-uno" })
    .fill("Uno");
  await uno.getByRole("button", { name: "Add", exact: true }).click();
  await said("“Uno” is another way of writing “e2e-uno” now.");
  assert.equal(resolveTag(from, "uno"), "e2e-uno");
  await uno
    .getByRole("button", {
      name: "Remove uno as another way of writing e2e-uno",
    })
    .click();
  await said(/^“uno” no longer leads to “e2e-uno”/);
  assert.equal(resolveTag(from, "uno"), undefined);

  // Merging cannot be undone, so it asks first, and can be called off.
  const merge = async () => {
    await pickTag(page, uno.getByText("Choose the tag to keep"), "e2e-two");
    const question = page.getByRole("alertdialog");
    await question.waitFor();
    assert.match(
      (await question.textContent()) ?? "",
      /Merge “e2e-uno” into “e2e-two”\?.*The 1 bookmark that has “e2e-uno”.*This cannot be undone\./,
    );
    return question;
  };
  await (await merge()).getByRole("button", { name: "Keep both" }).click();
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  assert.ok(names().includes("e2e-uno"), "called off, nothing was merged");
  await (await merge())
    .getByRole("button", { name: "Merge", exact: true })
    .click();
  await said(/^“e2e-uno” is merged into “e2e-two”\. 1 bookmark had it/);
  assert.ok(!names().includes("e2e-uno"));
  assert.ok(labelsOf(tagged).tags.includes("e2e-two"));
  assert.equal(resolveTag(from, "e2e-uno"), "e2e-two");

  // Retired, it is on no bookmark; restored, it is on the ones it had.
  await (await edit("e2e-two"))
    .getByRole("button", { name: "Retire this tag" })
    .click();
  await said(/^“e2e-two” is retired\. 1 bookmark no longer shows it\./);
  assert.ok(!labelsOf(tagged).tags.includes("e2e-two"));
  await row("e2e-two").waitFor({ state: "detached" });
  await page.getByText("1 retired tag").click();
  const retired = page.locator('[data-retired-tag="e2e-two"]');
  assert.match(
    (await retired.textContent()) ?? "",
    /1 bookmark would have it back/,
  );
  await retired.getByRole("button", { name: "Restore" }).click();
  await said("“e2e-two” is a tag again. 1 bookmark has it back.");
  assert.ok(labelsOf(tagged).tags.includes("e2e-two"));
  await row("e2e-two").waitFor();

  // A screen that is behind the library. The tag is retired somewhere else
  // after this page was read, so the page still offers it as the tag a
  // proposal could be another way of writing. The app refuses, the notice
  // says what to do about it, and the page is read again: the tag is among
  // the retired ones, where the button the notice names is.
  const [waiting] = listTagProposals(from, { minBookmarks: 1 }).proposals;
  assert.ok(waiting, "a proposal is still waiting to be decided");
  await page.goto(`${APP_ORIGIN}/tags?least=1`);
  const undecided = page.locator(`[data-proposal="${waiting.proposal}"]`);
  await undecided.waitFor();
  await row("e2e-two").waitFor();
  retireTag(from, "e2e-two");
  await pickTag(
    page,
    undecided.getByText(/^Alias of (?:a|another) tag$/),
    "e2e-two",
  );
  await said("Nothing was changed");
  await said(
    "“e2e-two” is a tag that was retired, or a name for one. Accepting a proposal under it would bring the tag back on every bookmark it was retired from. Restore it first, or choose another name.",
  );
  assert.equal(resolveTag(from, waiting.proposal), undefined);
  assert.equal(resolveTag(from, "e2e-two"), undefined);
  await row("e2e-two").waitFor({ state: "detached" });
  await undecided.waitFor();
  // The notice stays until it is closed, over the corner of the page.
  await page.locator('[aria-label="Close this notice"]').last().click();
  await page.getByText("1 retired tag").click();
  await page
    .locator('[data-retired-tag="e2e-two"]')
    .getByRole("button", { name: "Restore" })
    .click();
  await row("e2e-two").waitFor();
  assert.ok(labelsOf(tagged).tags.includes("e2e-two"));

  // A tag was added, more than once, and the app asked for a pass each
  // time. No pass and no click here ran the classifier or spent anything.
  assert.deepEqual(listTaggingRuns(from), []);
  assert.equal(summariseTagging(from).spentUsd, 0);
  await page.close();
});

test("the review queue lists what is under other, each reason apart, and what has an unclear format, and is gone through with the keyboard", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  seedLabels();
  const from = seedLibrary();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const countIn = async (queue: string) =>
    Number(await page.getByTestId(`review-count-${queue}`).textContent());
  const core = () => {
    const summary = summariseMatches(from);
    const other =
      summary.categories.find(({ category }) => category === OTHER_CATEGORY)
        ?.bookmarks ?? 0;
    return {
      little: summary.tooLittleText,
      unfit: other - summary.tooLittleText,
      unclear:
        summary.formats.find(({ format }) => format === UNCLEAR_FORMAT)
          ?.bookmarks ?? 0,
    };
  };
  const counts = async () => ({
    little: await countIn("little"),
    unfit: await countIn("unfit"),
    unclear: await countIn("unclear"),
  });
  const little = { category: OTHER_CATEGORY, tooLittleText: true };
  /** A queue is the library's own list: read once its rows are drawn. */
  const queueShown = async () => {
    await page.locator("[data-post]").first().waitFor();
    await listIsSettled(page);
  };
  const menuHasTheKeyboard = () =>
    waitFor("the menu to take the keyboard", () =>
      page.evaluate(
        () => document.activeElement?.closest('[role="menu"]') != null,
      ),
    );

  // With no queue named it opens on the first with anything in it, and puts
  // that into the address, so the queue does not change under the reader.
  await page.goto(`${APP_ORIGIN}/review`);
  await page.waitForURL((url) => url.searchParams.get("queue") === "little");
  await queueShown();

  // Three queues, counted as core counts them, the two reasons apart.
  const before = core();
  assert.ok(before.little >= 1 && before.unfit >= 1 && before.unclear >= 2);
  assert.deepEqual(await counts(), before);
  const queues = page.getByRole("navigation", { name: "What to review" });
  assert.match(
    (await queues.locator('[aria-current="page"]').textContent()) ?? "",
    /^Too little text/,
  );
  const waiting = listed(little);
  assert.deepEqual(await everyPost(page), waiting);

  // J to the post, C and a digit to file it. It stays where it is, filed,
  // and the queue's count goes down.
  const [first] = waiting;
  await page.keyboard.press("j");
  assert.equal(await focusedPostId(page), first);
  await page.keyboard.press("c");
  await menuHasTheKeyboard();
  await page.keyboard.press(digitOf(TAXONOMY.categories, "tools"));
  await waitFor(
    "the post to be filed",
    () => labelsOf(first).category === "tools",
  );
  assert.equal(labelsOf(first).tooLittleText, false);
  await waitFor(
    "the queue to count one fewer",
    async () => (await countIn("little")) === before.little - 1,
  );
  assert.equal(new URL(page.url()).searchParams.get("queue"), "little");
  assert.deepEqual(await everyPost(page), waiting);

  // The other reason is a queue of its own.
  await queues.getByRole("link", { name: /^No category fits/ }).click();
  await page.waitForURL((url) => url.searchParams.get("queue") === "unfit");
  await queueShown();
  assert.deepEqual(
    await everyPost(page),
    listed({ category: OTHER_CATEGORY, tooLittleText: false }),
  );

  // An unclear format is set with R.
  await queues
    .getByRole("link", { name: new RegExp(`^${formatLabel(UNCLEAR_FORMAT)}`) })
    .click();
  await page.waitForURL((url) => url.searchParams.get("queue") === "unclear");
  await queueShown();
  const unclear = listed({ format: UNCLEAR_FORMAT });
  assert.deepEqual(await everyPost(page), unclear);
  await page.keyboard.press("j");
  const formatless = await focusedPostId(page);
  assert.equal(formatless, unclear[0]);
  await page.keyboard.press("r");
  await menuHasTheKeyboard();
  await page.keyboard.press(digitOf(TAXONOMY.formats, "guide"));
  await waitFor(
    "the format to be stored",
    () => labelsOf(formatless ?? "").format === "guide",
  );
  await waitFor(
    "the queue to count one fewer",
    async () => (await countIn("unclear")) === before.unclear - 1,
  );
  assert.deepEqual(await counts(), core());

  // A queue with nothing left says so. What is still in the first one is
  // filed here through core, as the owner's corrections.
  for (const postId of listed(little)) {
    correctBookmark(from, postId, { category: "tools" });
  }
  await page.goto(`${APP_ORIGIN}/review?queue=little`);
  assert.match(
    (await page.getByTestId("nothing-to-review").textContent()) ?? "",
    /Nothing here/,
  );
  await page.close();
});

test("a search that matched a post by its author or by a picture's description shows where", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const bookmarks = libraryBookmarks();
  const lower = (texts: string[]) => texts.map((text) => text.toLowerCase());

  // By the author's handle: marked in the post's heading.
  const [byAuthor] = bookmarks;
  assert.ok(byAuthor);
  const page = await openLibrary(
    `/?q=${encodeURIComponent(`@${byAuthor.authorHandle}`)}`,
  );
  const post = await findPost(page, byAuthor.postId);
  assert.ok(
    lower(await post.locator("h3 mark").allTextContents()).includes(
      byAuthor.authorHandle.toLowerCase(),
    ),
  );

  // By a word of a picture's description: marked in the description, which
  // is shown under the picture's place. (That a word found there alone is
  // marked there is shown on a made-up post, in `post-view.test.ts`: the
  // fixtures' descriptions use only words their posts use too.)
  const described = bookmarks.flatMap((bookmark) =>
    bookmark.media.flatMap((media) => {
      const [word] = (media.altText ?? "").match(/\p{L}{4,}/gu) ?? [];
      return word === undefined ? [] : [{ bookmark, word }];
    }),
  );
  const [picture] = described;
  assert.ok(picture, "a fixture post has a described picture");
  await page.goto(`${APP_ORIGIN}/?q=${encodeURIComponent(picture.word)}`);
  await listIsLive(page);
  const pictured = await findPost(page, picture.bookmark.postId);
  assert.ok(
    lower(
      await pictured
        .locator("p", { hasText: "Description:" })
        .locator("mark")
        .allTextContents(),
    ).includes(picture.word.toLowerCase()),
  );
  await page.close();
});

test("a list being corrected stays the reader's: its rows and an open tag list stay when nothing matches any more, the tag list keeps its order, changes go one at a time, and a menu opens on screen", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  seedLabels();
  const from = seedLibrary();
  const total = libraryBookmarks().length;
  // One bookmark with a tag of its own, so that a list of one can be had.
  const solo = libraryBookmarks().at(-1)?.postId ?? "";
  addTag(from, "e2e-solo");
  correctBookmark(from, solo, { addTags: ["e2e-solo"] });

  const page = await openLibrary("/?tag=e2e-solo", {
    width: 1280,
    height: 700,
  });
  const post = page.locator(`[data-post-id="${solo}"]`).first();
  const options = page.getByRole("option");
  const offered = () => options.allTextContents();
  const shownTags = () => post.locator("[data-labels] a").allTextContents();
  assert.equal(await resultCount(page), `1 of ${total} bookmarks`);
  assert.deepEqual(await shownPosts(page), [solo]);

  // The control that opens the tag list has a name of its own: a combobox
  // takes none from what is written in it.
  await post.getByRole("combobox", { name: "Add or remove tags" }).click();
  await options.first().waitFor();
  const order = await offered();
  assert.equal(order[0], "e2e-solo", "the post's own tags are offered first");
  const last = order.at(-1) ?? "";
  assert.ok(order.length > 10 && !labelsOf(solo).tags.includes(last));

  // A tag far down the list is switched on by a press. The page is read
  // again after it, and the list keeps the order it opened in: a second
  // press in the same place would otherwise land on another tag.
  await options.last().click();
  await waitFor("the tag to be stored", () =>
    labelsOf(solo).tags.includes(last),
  );
  await waitFor("the row to show it", async () =>
    (await shownTags()).includes(`#${last}`),
  );
  assert.deepEqual(await offered(), order);
  await options.last().click();
  await waitFor(
    "the same press to take the same tag off again",
    () => !labelsOf(solo).tags.includes(last),
  );
  await waitFor(
    "the row to show that",
    async () => !(await shownTags()).includes(`#${last}`),
  );
  assert.deepEqual(await offered(), order);

  // The tag the list is of is taken off its one post. Nothing matches any
  // more, and the reader is still in the post: the row stays, and so does
  // the open tag list, where the choice can be undone.
  await options.first().click();
  await waitFor(
    "the tag to be taken off",
    () => !labelsOf(solo).tags.includes("e2e-solo"),
  );
  await waitFor(
    "the count to follow",
    async () => (await resultCount(page)) === `0 of ${total} bookmarks`,
  );
  assert.equal(await page.getByTestId("no-results").count(), 0);
  assert.deepEqual(await shownPosts(page), [solo]);
  assert.deepEqual(await offered(), order, "the tag list is still open");
  // The list says which of its rows the count no longer covers, and a row
  // still has a place in a list that is at least as long as its rows.
  assert.match(
    (await page.getByTestId("no-longer-matching").textContent()) ?? "",
    /^1 bookmark listed here no longer matches, and stays until the list is read again\./,
  );
  assert.equal(await post.getAttribute("aria-posinset"), "1");
  assert.equal(await post.getAttribute("aria-setsize"), "1");
  // Undone from where the reader is.
  await options.first().click();
  await waitFor("the tag to be back", () =>
    labelsOf(solo).tags.includes("e2e-solo"),
  );
  await waitFor(
    "the list to match its rows again",
    async () =>
      (await page.getByTestId("no-longer-matching").count()) === 0 &&
      (await resultCount(page)) === `1 of ${total} bookmarks`,
  );
  await page.keyboard.press("Escape");

  // Two changes made quickly go to the app one after the other, so the
  // last one made is the last one stored and the one the row shows. The
  // first is held up here on its way; the second waits for its answer.
  let onTheirWay = 0;
  let mostAtOnce = 0;
  let held = false;
  const correcting = `${APP_ORIGIN}/api/owner/correct`;
  page.on("requestfinished", (request) => {
    if (request.url() === correcting) onTheirWay -= 1;
  });
  await page.route(correcting, async (route) => {
    onTheirWay += 1;
    mostAtOnce = Math.max(mostAtOnce, onTheirWay);
    if (!held) {
      held = true;
      await sleep(700);
    }
    await route.continue();
  });
  const menu = page.getByRole("menu");
  const choose = async (key: string, digit: string) => {
    await waitFor(
      "the keyboard to be on the post",
      async () =>
        (await menu.count()) === 0 && (await focusedPostId(page)) === solo,
    );
    await page.keyboard.press(key);
    await waitFor("the menu to take the keyboard", () =>
      page.evaluate(
        () => document.activeElement?.closest('[role="menu"]') != null,
      ),
    );
    await page.keyboard.press(digit);
  };
  const [earlier = "", later = ""] = TAXONOMY.categories
    .map(({ id }) => id)
    .filter((id) => id !== labelsOf(solo).category);
  await post.focus();
  await choose("c", digitOf(TAXONOMY.categories, earlier));
  await choose("c", digitOf(TAXONOMY.categories, later));
  await waitFor(
    "both changes to be stored",
    () => labelsOf(solo).category === later,
  );
  await waitFor(
    "the row to show the last",
    async () =>
      (await post
        .locator('[data-edit="category"]')
        .getAttribute("data-value")) === later &&
      (await post.locator("[data-labels]").getAttribute("aria-busy")) === null,
  );
  assert.equal(
    mostAtOnce,
    1,
    "the second change waited for the first's answer",
  );
  assert.equal(labelsOf(solo).category, later);
  await page.unroute(correcting);
  await page.close();

  // A post taller than the window: the key that opens its category brings
  // the line it is on into view first, so the menu opens where it can be
  // seen, clear of the bar at the top.
  const long = await openLibrary("/?has=long", { width: 1280, height: 400 });
  // As tall as the window turned out: a browser has a least height of its
  // own, and what was asked for is below it.
  const viewport = await long.evaluate(() => window.innerHeight);
  // By its id: the list draws only the rows near the screen, so "the first
  // post that can be opened" is another post once the page has moved.
  const tallId = await long
    .locator("[data-post]", { has: long.locator("[data-expand]") })
    .first()
    .getAttribute("data-post-id");
  const tall = long.locator(`[data-post-id="${tallId}"]`).first();
  await tall.focus();
  await long.keyboard.press("e");
  await tall.evaluate((post) => post.scrollIntoView({ block: "start" }));
  await drawn(long);
  const control = tall.locator('[data-edit="category"]');
  assert.ok(
    ((await tall.boundingBox())?.height ?? 0) > viewport,
    "the opened post is taller than the window",
  );
  const onScreen = async () => {
    const box = await control.boundingBox();
    return box !== null && box.y >= 56 && box.y + box.height <= viewport;
  };
  assert.ok(
    ((await control.boundingBox())?.y ?? 0) > viewport,
    "its labels are below the screen",
  );
  // The page keeps a band clear at its top for the bar, and a browser holds
  // to it for whatever takes the keyboard. A menu laid over that band had
  // the page scroll under it as it opened, so it is placed below the band.
  const band = await long.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).scrollPaddingTop,
    ),
  );
  assert.ok(band > 0, "the page keeps a band clear at its top");
  const placed = async (popup: Locator) => {
    const box = await popup.boundingBox();
    assert.ok(box);
    return { top: Math.round(box.y), bottom: Math.round(box.y + box.height) };
  };
  const opensOnScreen = async (key: string, popup: Locator) => {
    await long.keyboard.press(key);
    await popup.waitFor();
    await waitFor("what opened to take the keyboard", () =>
      long.evaluate(
        () =>
          document.activeElement?.closest("[data-post]") === null &&
          document.activeElement !== document.body,
      ),
    );
    await drawn(long);
    const where = JSON.stringify({
      control: await control.boundingBox(),
      popup: await placed(popup),
      viewport,
      band,
    });
    assert.equal(
      await onScreen(),
      true,
      `${key}: the line the control is on is on screen: ${where}`,
    );
    const { top, bottom } = await placed(popup);
    assert.ok(
      top >= band && bottom <= viewport,
      `${key}: what opened is on screen, below the band: ${where}`,
    );
    await long.keyboard.press("Escape");
    await waitFor(
      "the keyboard to be back on the post",
      async () =>
        (await popup.count()) === 0 && (await focusedPostId(long)) === tallId,
    );
  };
  await opensOnScreen("c", long.getByRole("menu"));
  // The same for the tag list, whose field takes the keyboard.
  await opensOnScreen("t", long.locator('[data-slot="combobox-content"]'));
  await long.close();
});

test("with every bookmark classified nothing is offered as unclassified, and the status page counts what was done by hand", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  seedLabels();
  const from = seedLibrary();
  // Every bookmark the classifier has no answer for, those removed on X
  // among them, is given one, through core.
  // One the owner filed by hand, which the classifier has still not seen,
  // is among them: it is under a category and has no answer.
  let after: string | undefined;
  do {
    const page = listBookmarks(from, {
      includeRemoved: true,
      limit: MAX_PAGE_SIZE,
      after,
    });
    for (const { postId, labels } of page.bookmarks) {
      if (labels.classification !== null) continue;
      recordClassification(from, {
        postId,
        category: "life",
        format: "discussion",
        tags: [],
        tooLittleText: false,
        instructionsVersion: 1,
        model: "a-model",
      });
    }
    after = page.nextCursor ?? undefined;
  } while (after !== undefined);
  const standing = summariseTagging(from);
  assert.equal(standing.unclassified, 0);

  const page = await openLibrary("/");
  assert.equal(await filterLink(page, "Not classified yet").count(), 0);
  assert.equal(
    await page
      .getByRole("navigation", { name: "Library" })
      .getByText("Not classified yet")
      .count(),
    0,
  );
  assert.equal(
    await page.locator('[data-edit="category"][data-value=""]').count(),
    0,
  );
  await page.goto(`${APP_ORIGIN}/?cat=none`);
  await page.getByTestId("no-results").waitFor();

  await page.goto(`${APP_ORIGIN}/status`);
  const card = page.locator("#tagging");
  const shown = async (name: string) =>
    (await card.getByTestId(`tagging-${name}`).textContent()) ?? "";
  assert.equal(
    await shown("classified"),
    `${standing.classified} of ${standing.bookmarks}`,
  );
  assert.equal(await shown("unclassified"), "0");
  assert.ok(standing.corrected >= 2);
  assert.equal(await shown("corrected"), String(standing.corrected));
  assert.equal(
    await shown("little-text"),
    String(standing.other.tooLittleText),
  );
  assert.match(
    await shown("no-fit"),
    new RegExp(`^${standing.other.noneOfTheAbove}\\b`),
  );
  assert.equal(await shown("unclear"), String(standing.unclearFormat));
  assert.equal(await shown("proposals"), String(standing.proposals));
  assert.match((await shown("app")) ?? "", /^Off\./);
  // Everything above was done through core and by hand. No screen started a
  // run of the classifier, and nothing was spent.
  assert.equal(await shown("spent"), "$0.00");
  assert.equal(await shown("last-run"), "none yet");
  assert.deepEqual(listTaggingRuns(from), []);
  await page.close();
});
