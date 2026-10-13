/**
 * The mechanical half of "Requests to X" in CODING_STANDARDS.md: nothing in
 * this repo may request anything from a host X owns.
 *
 * It reads every source file in the repo, not only core's, and holds three
 * lists. A file that is not on the right list fails the test, so each of
 * these is a decision somebody wrote down and somebody reviewed:
 *
 * 1. A file that names an X-owned host is listed, with what the name is for.
 *    Test files are let off: they hold request URLs as sample data.
 * 2. A file that makes requests, or has a browser load things, is listed,
 *    with where its requests go.
 * 3. A file that does both, a test included, is listed with why none of its
 *    requests can reach X.
 *
 * What this cannot see is said at the bottom of the standard: a URL that
 * arrives as data, a request made inside a dependency, a redirect.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { X_OWNED_DOMAINS } from "./x-hosts.ts";

const repoRoot = join(import.meta.dirname, "../../..");

/** Not source: dependencies, build output, the user's data, prose, lockfiles, and generated files. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".next-e2e",
  "data",
  "coverage",
  // Research notes cite X's own pages. They are prose, and nothing runs them.
  "docs",
  // Redacted responses: data that names X's media hosts, with invented paths.
  "fixtures",
]);
const SKIPPED_FILES = new Set(["pnpm-lock.yaml", "next-env.d.ts"]);
const SOURCE_FILE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|html|css|grit|yaml|yml)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;

function sourceFiles(directory: string = repoRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // A directory with a `.git` of its own is another checkout, such as a
      // linked worktree. It is not this tree's source: its own run of this
      // test reads it, under the paths these lists name.
      return SKIPPED_DIRECTORIES.has(entry.name) ||
        existsSync(join(path, ".git"))
        ? []
        : sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) && !SKIPPED_FILES.has(entry.name)
      ? [relative(repoRoot, path)]
      : [];
  });
}

/** One of X's domains or a subdomain of one, standing as a host and not inside a longer name. */
const X_HOST = new RegExp(
  `(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*(?:${X_OWNED_DOMAINS.map((domain) => domain.replace(".", "\\.")).join("|")})(?![A-Za-z0-9-])`,
  "i",
);
export const namesXHost = (source: string) => X_HOST.test(source);

/** Node's own ways out: its network modules, and a shell, which has curl. */
const NODE_MODULES = "https?|http2|net|tls|dgram|dns|child_process";
/**
 * HTTP clients and browser drivers in common use; the MCP library, which
 * holds HTTP transports beside the stdio one this repo uses and starts
 * processes for its clients; Anthropic's SDK, which is an HTTP client for
 * the Claude API; and this repo's own classifier, the one package that uses
 * that SDK, so that a file which can set the classifier going is on the
 * list beside the file that sends.
 */
const PACKAGES =
  "undici|axios|got|ky|node-fetch|superagent|needle|request|ws|playwright|playwright-core|puppeteer|puppeteer-core|selenium-webdriver|jsdom|open|@modelcontextprotocol/[a-z-]+|@anthropic-ai/[a-z-]+|@x-bookmarks/tagger";

/**
 * Anything that makes a request or has a browser make one: the request
 * functions, an import of one of the modules above or a dependency on one,
 * the elements and style rules that load from a URL, and code that tells a
 * media element to play or to load, which is when it asks for its file.
 */
const REQUEST = new RegExp(
  [
    "\\bfetch\\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon",
    `(?:from|import|require)\\s*\\(?\\s*["'](?:(?:node:)?(?:${NODE_MODULES})|(?:${PACKAGES})(?:/[^"']*)?)["']`,
    `"(?:${PACKAGES})"\\s*:`,
    "next/image|<(?:img|video|audio|source|iframe|embed|object|picture)\\b",
    "\\.(?:play|load)\\(\\)",
    "\\burl\\(\\s*[\"']?(?:https?:)?//",
  ].join("|"),
);
export const makesRequests = (source: string) => REQUEST.test(source);

/** Files that name an X-owned host, and what the name is there for. Test files need no entry. */
const NAMES_X_HOSTS: Record<string, string> = {
  "packages/core/src/x-hosts.ts":
    "The list of X's hosts itself, and the guard that refuses them.",
  "packages/core/src/post.ts":
    "Doc comments on the bookmark record: a stored link's `t.co` form is data.",
  "packages/core/src/parsers/redaction/redact.ts":
    "Which hosts a redacted fixture may keep by name. It builds strings and requests nothing.",
  "packages/core/src/parsers/redaction/leaks.ts":
    "Which strings a fixture may share with a real capture. It compares strings.",
  "packages/core/src/parsers/redaction/sample.ts":
    "An invented response for the redactor's tests.",
  "packages/extension/manifest.json":
    "Where Chrome injects the two content scripts. A match pattern, not a permission to request: the service worker holds no host permission for X.",
  "packages/extension/src/operations.ts":
    "Recognises the page's own requests by their URL. It reads a URL and requests nothing.",
  "packages/extension/src/background.ts":
    "Accepts messages from x.com tabs only. Its one request goes to the local app.",
  "packages/extension/src/page-hook.ts":
    "A comment saying which pages the hook runs on.",
  "packages/extension/src/relay.ts":
    "A comment saying which pages the relay runs on.",
  "packages/web/src/lib/x-links.ts":
    "Builds the address of a post on X for a plain link the owner clicks, in a new tab. It builds a string and requests nothing.",
  "packages/web/src/lib/x-media-policy.ts":
    "X's two media hosts: the only ones a media address may be on, and the only ones the page's Content-Security-Policy admits (X-7, X-11). It compares and builds strings and requests nothing.",
  "packages/e2e/src/capture.e2e.ts":
    "The end-to-end test. Its browser resolves every hostname to a server in the test.",
  "packages/e2e/src/fake-x.ts":
    "The fake X the test browser is sent to instead of the real one.",
  "packages/e2e/src/shapes-page.js":
    "The page the fake X serves, standing in for X's web client.",
  "packages/mcp/src/format.ts":
    "Writes the address of a post into a result, for the user to open in their own browser. It builds a string.",
  "packages/mcp/src/server.ts":
    "The instructions given to the client, which name X's hosts to say that none of them may be requested.",
};

/** Files that make requests or have a browser load something, and where to. Test files included. */
const MAKES_REQUESTS: Record<string, string> = {
  "packages/extension/src/hook.ts":
    "Wraps the page's own fetch and XMLHttpRequest and calls the browser's original with the page's arguments. It starts no request (CAP-1).",
  "packages/extension/src/queue.ts":
    "Delivers captures with a fetch it is handed, to APP_ORIGIN only (CAP-5).",
  "packages/extension/src/background.ts":
    "Hands the queue the service worker's fetch. The worker's only host permission is the local app.",
  "packages/extension/src/testing.ts":
    "A fake fetch for the extension's tests: a function, with no network behind it.",
  "packages/extension/src/hook.test.ts":
    "Runs the wrappers against a fake window whose fetch and XMLHttpRequest are stubs.",
  "packages/extension/src/queue.test.ts":
    "Runs delivery against the fake fetch of testing.ts.",
  "packages/extension/src/background.test.ts":
    "Reads the service worker's source to check what it may reach.",
  "packages/web/src/components/library/x-media-element.tsx":
    "The exception of X-7: the picture and video elements, which have the owner's browser load a post's media from X's media CDN. Rendered only by media.tsx, after the owner pressed Show media on that post or turned on the on-screen setting; never for an avatar, and never by the server.",
  "packages/web/src/components/library/video-player.tsx":
    "The app's own controls around the video element of x-media-element.tsx. It tells that element to play, and to load again when the owner presses Try again after a failure or a hang: each asks X's video CDN for the one address the element was given, and each follows a press (X-7). It names no address, holds no element of its own and starts nothing by itself.",
  "packages/web/src/components/library/load-more.ts":
    "Asks this app for the next page of the list, at the relative address /api/library. The page's Content-Security-Policy lets script connect nowhere else.",
  "packages/web/src/lib/owner-write.ts":
    "Sends this app a change the owner made on one of its screens, at the relative address /api/owner/<action>. The page's Content-Security-Policy lets script connect nowhere else.",
  "packages/web/src/server/page-door.ts":
    "The page door. It reads the Sec-Fetch-Site header of a request it was sent, to refuse whatever did not come from this app's own page. It answers requests and makes none.",
  "packages/web/src/server/page-door.test.ts":
    "Hands that door requests built in the test, with that header set. Nothing is sent.",
  "packages/web/src/server/owner-writes.test.ts":
    "Hands the routes behind the page door requests built in the test, with that header set. Nothing is sent.",
  "packages/web/src/server/testing.ts":
    "Builds a request as this app's own page sends one, that header included, for those tests. It builds an object and sends nothing.",
  "packages/web/src/server/library-page.ts":
    "A route of this app. It reads the Sec-Fetch-Site header of a request it was sent, to refuse other sites' pages. It answers requests and makes none.",
  "packages/web/src/server/library-page.test.ts":
    "Hands that route requests built in the test, with that header set. Nothing is sent.",
  "packages/e2e/package.json":
    "Depends on Playwright, which drives the test browser.",
  "packages/e2e/src/capture.e2e.ts":
    "Starts the app and a Chromium whose resolver sends every hostname to this process, and stops before any test if that rule is not in force.",
  "packages/e2e/src/fake-x.ts": "A server. It answers requests and makes none.",
  "packages/e2e/src/shapes-page.js":
    "Runs inside the test browser, where x.com is the fake.",
  "packages/core/src/no-requests-to-x.test.ts":
    "This check: the names of request functions, as patterns.",
  "packages/mcp/package.json":
    "Depends on the MCP library, for its stdio transport alone. server.test.ts pins which of its modules are loaded.",
  "packages/mcp/src/server.ts":
    "Defines the tools on the MCP library's server object. It is given no transport here and opens none.",
  "packages/mcp/src/main.ts":
    "Serves over this process's standard input and output. It opens no socket and makes no request.",
  "packages/mcp/src/main.test.ts":
    "Starts the server as a child process and speaks to it over its pipes, as a client does.",
  "packages/tagger/package.json":
    "Depends on Anthropic's SDK: the classifier is the one package that calls Claude (AI-1).",
  "packages/tagger/src/anthropic.ts":
    "The one file that sends anything of the library to a third party: the classifier's requests and the weekly digest's one, to the Claude API at api.anthropic.com and nowhere else. Every request passes onlyToClaude, which refuses any other origin, passes the address through assertNotXOwnedUrl, and switches redirects off (AI-2). It requests nothing to add to a post.",
  "packages/tagger/src/anthropic.test.ts":
    "Builds the client over the fake API, and watches that the platform's sender is never called when a test tries for the real one.",
  "packages/tagger/src/automatic.test.ts":
    "Runs passes over the fake API, and one left to make its own client, which is refused under a test runner; the platform's sender is watched and never called. It also starts the script below as a child process.",
  "packages/tagger/src/testing/what-a-pass-loads.ts":
    "Run by automatic.test.ts as a process of its own: loads the classifier's entry for the app and makes one pass with the app's tagging off or with no key, to list the modules that loaded. Such a pass stops before the client is loaded, so nothing is sent.",
  "packages/tagger/src/testing/fake-api.ts":
    "A fake of the Claude API for the classifier's tests: a function with the shape of the platform's sender, with no network behind it.",
  "packages/tagger/src/boundary.test.ts":
    "Reads the classifier's source to pin which file may send, and where. It requests nothing.",
  "packages/tagger/src/cli.test.ts":
    "Starts the classifier's command as a child process, in a temporary data directory with no key, where it can reach nothing.",
  "packages/tagger/src/digest/cli.test.ts":
    "Starts the digest's command as a child process, in a temporary data directory with no key, where it can reach nothing: only what sends nothing is run this way.",
  "packages/web/package.json":
    "Depends on the classifier, which the app asks to tag new bookmarks. The app itself sends nothing: the request is the classifier's.",
  "packages/web/src/server/tagging.ts":
    "Asks the classifier for a pass over new bookmarks, on a timer and after a capture. It loads the classifier and makes no request of its own.",
  "packages/web/src/server/tagging-status.ts":
    "A route of this app. It reads the Sec-Fetch-Site header of a request it was sent, to refuse other sites' pages. It answers requests and makes none.",
  "packages/web/src/server/tagging-status.test.ts":
    "Hands that route requests built in the test, with that header set. Nothing is sent.",
  "packages/web/src/server/tagging.test.ts":
    "Runs the passes with a stand-in for the classifier, and once with the real one in an empty library with no key, watching that the platform's sender is never called.",
};

/**
 * Files that both name an X-owned host and make requests, and why no request
 * of theirs reaches X. This is the list to read first in a review: a new
 * entry is a claim that needs checking by hand.
 */
const REQUESTS_BESIDE_X_HOSTS: Record<string, string> = {
  "packages/extension/src/background.ts":
    "The host is compared with a message's sender. The fetch is given APP_ORIGIN by queue.ts.",
  "packages/extension/src/hook.test.ts":
    "Request URLs are arguments to stub functions.",
  "packages/extension/src/queue.test.ts":
    "Request URLs are fields of sample captures; the fetch is a fake.",
  "packages/extension/src/background.test.ts":
    "It reads source text. It requests nothing.",
  "packages/e2e/src/capture.e2e.ts":
    "x.com is requested by a browser that resolves it to the fake, checked before any test runs.",
  "packages/e2e/src/fake-x.ts": "It is the server those requests reach.",
  "packages/e2e/src/shapes-page.js":
    "Its requests are relative to the page, which the fake serves.",
  "packages/core/src/no-requests-to-x.test.ts":
    "This check. It reads files and requests nothing.",
  "packages/mcp/src/server.ts":
    "The hosts are in a sentence telling the client never to request them. The server has no way to request anything: its one transport is the pipe it was started with.",
  "packages/mcp/src/main.test.ts":
    "The address of a post is compared with the server's answer as a string. The only process started is the server, over pipes.",
  "packages/tagger/src/anthropic.test.ts":
    "An address on a host of X's is handed to the classifier's gate to show that the gate refuses it; the sender behind the gate is a mock, and is checked not to have been called.",
};

const files = sourceFiles().map((path) => ({
  path,
  source: readFileSync(join(repoRoot, path), "utf8"),
}));

test("the check reads the whole repo, every package included", () => {
  const paths = files.map(({ path }) => path);

  expect(paths.length).toBeGreaterThan(80);
  for (const expected of [
    "package.json",
    "packages/core/src/parsing.ts",
    "packages/extension/src/queue.ts",
    "packages/extension/manifest.json",
    "packages/web/src/server/ingest.ts",
    "packages/web/src/app/page.tsx",
    "packages/web/reparse.ts",
    "packages/e2e/src/fake-x.ts",
    "packages/mcp/src/server.ts",
    "packages/mcp/package.json",
    "packages/tagger/src/anthropic.ts",
    "packages/tagger/src/input.ts",
    "packages/tagger/package.json",
    "lint/sqlite-boundary.grit",
  ]) {
    expect(paths).toContain(expected);
  }
});

test("only listed files name a host X owns", () => {
  const unlisted = files
    .filter(({ path, source }) => namesXHost(source) && !TEST_FILE.test(path))
    .map(({ path }) => path)
    .filter((path) => !Object.hasOwn(NAMES_X_HOSTS, path));

  expect(
    unlisted,
    'These files name a host X owns. Nothing here may request one: read "Requests to X" in CODING_STANDARDS.md. If the name is data or a comment, add the file to NAMES_X_HOSTS with what it is for.',
  ).toEqual([]);
});

test("only listed files make requests", () => {
  const unlisted = files
    .filter(({ source }) => makesRequests(source))
    .map(({ path }) => path)
    .filter((path) => !Object.hasOwn(MAKES_REQUESTS, path));

  expect(
    unlisted,
    "These files make a request, or have a browser load something. Add each to MAKES_REQUESTS with where its requests go, and pass any URL it did not write itself through assertNotXOwnedUrl first.",
  ).toEqual([]);
});

test("a file that names a host X owns and also makes requests is listed with why they never meet", () => {
  const unlisted = files
    .filter(({ source }) => namesXHost(source) && makesRequests(source))
    .map(({ path }) => path)
    .filter((path) => !Object.hasOwn(REQUESTS_BESIDE_X_HOSTS, path));

  expect(
    unlisted,
    "These files name a host X owns and make requests. That is how a request to X gets written. Take one of the two out, or add the file to REQUESTS_BESIDE_X_HOSTS with why no request of its can reach X.",
  ).toEqual([]);
});

test("no list holds an entry for a file that no longer needs it", () => {
  const sourceOf = new Map(files.map(({ path, source }) => [path, source]));
  const stale = (
    list: Record<string, string>,
    needed: (source: string) => boolean,
  ) => Object.keys(list).filter((path) => !needed(sourceOf.get(path) ?? ""));

  expect(stale(NAMES_X_HOSTS, namesXHost)).toEqual([]);
  expect(stale(MAKES_REQUESTS, makesRequests)).toEqual([]);
  expect(
    stale(
      REQUESTS_BESIDE_X_HOSTS,
      (source) => namesXHost(source) && makesRequests(source),
    ),
  ).toEqual([]);
});

test("the classifier, which sends posts to the Claude API, names no host of X's anywhere in its source", () => {
  const naming = files
    .filter(({ path }) => path.startsWith("packages/tagger/"))
    .filter(({ path, source }) => namesXHost(source) && !TEST_FILE.test(path))
    .map(({ path }) => path);

  // It sends what a capture holds and asks X for nothing to add to it (X-2).
  expect(naming).toEqual([]);
});

test("core, which holds every bookmark, makes no request of any kind", () => {
  const requesting = files
    .filter(({ path }) => path.startsWith("packages/core/"))
    .filter(({ source }) => makesRequests(source))
    .map(({ path }) => path);

  expect(requesting).toEqual(["packages/core/src/no-requests-to-x.test.ts"]);
});

test.each([
  ["a post fetched by id", 'await fetch("https://api.x.com/2/tweets/" + id)'],
  [
    "a short link resolved",
    'const where = await fetch("https://t.co/" + token, { method: "HEAD" })',
  ],
  ["an image downloaded", 'https.get("https://pbs.twimg.com/media/" + key)'],
  ["a video downloaded", 'const host = "video.twimg.com";'],
  ["an embed asked for", 'new URL("https://publish.twitter.com/oembed")'],
  [
    "the syndication endpoint",
    'const SYNDICATION = "cdn.syndication.twimg.com/tweet-result";',
  ],
  ["the old domain", 'page.goto("https://twitter.com/i/bookmarks")'],
  ["a host in capitals", 'const HOST = "X.COM";'],
  ["a bare host in a comparison", 'if (url.hostname === "x.com") retry(url);'],
])("the check sees %s as naming a host X owns", (_, source) => {
  expect(namesXHost(source)).toBe(true);
});

test.each([
  "https://notx.com/",
  "https://x.computer.example/",
  "https://linux.com/",
  "const total = result.count + index.compare(matrix.columns);",
  "import config from './next.config.ts';",
  "https://site1.example/a",
  "https://internet.co/",
])("%s names none", (source) => {
  expect(namesXHost(source)).toBe(false);
});

test.each([
  ["fetch", "const response = await fetch(url);"],
  ["fetch handed on", "deliver({ fetch, storage });"],
  ["XMLHttpRequest", "const xhr = new XMLHttpRequest();"],
  ["Node's http client", 'import { request } from "node:https";'],
  ["Node's http client, old spelling", "import http from 'http';"],
  ["a socket", 'import { connect } from "node:net";'],
  [
    "a shell, which has curl",
    'import { execFileSync } from "node:child_process";',
  ],
  ["an HTTP client library", 'import axios from "axios";'],
  ["a browser driven by code", 'import { chromium } from "playwright";'],
  ["a client loaded on demand", 'const { request } = await import("undici");'],
  ["a browser driver as a dependency", '"playwright": "^1.64.0"'],
  [
    "the MCP library, which has HTTP transports",
    'import { McpServer } from "@modelcontextprotocol/server";',
  ],
  [
    "the MCP library as a dependency",
    '"@modelcontextprotocol/client": "^2.3.1"',
  ],
  [
    "Anthropic's SDK, which calls the Claude API",
    'import Anthropic from "@anthropic-ai/sdk";',
  ],
  ["Anthropic's SDK as a dependency", '"@anthropic-ai/sdk": "^0.133.0"'],
  [
    "the classifier, which uses that SDK",
    'const { tagNewBookmarks } = await import("@x-bookmarks/tagger");',
  ],
  ["the classifier as a dependency", '"@x-bookmarks/tagger": "workspace:*"'],
  [
    "an image the user's browser would load",
    "<img src={media.imageUrl} alt={media.altText} />",
  ],
  ["a video", "<video controls src={media.videoUrl}></video>"],
  ["a video told to play", "video.play().catch(() => {});"],
  ["a video told to load again", "element.load();"],
  ["Next's image component", 'import Image from "next/image";'],
  ["an embedded page", "<iframe src={post.url} />"],
  [
    "a stylesheet loading from a URL",
    'background: url("https://example.com/a.png");',
  ],
])("the check sees %s as making a request", (_, source) => {
  expect(makesRequests(source)).toBe(true);
});

test.each([
  "const fetched = prefetch.length;",
  'import { readFileSync } from "node:fs";',
  '<a href={link.url} rel="noreferrer">{link.displayUrl}</a>',
  "const image = bookmark.media[0]?.imageUrl;",
  'import Link from "next/link";',
  'const kind = "request";',
  "window.open(link.url);",
  "const loaded = store.load(path);",
  "display.playback = player.played();",
])("%s makes none", (source) => {
  expect(makesRequests(source)).toBe(false);
});
