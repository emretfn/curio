import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { APP_ORIGIN } from "./protocol.ts";
import { shapesOf } from "./testing.ts";

/**
 * The popup's page and stylesheet, read as text. What its states say is
 * tested in `popup-view.test.ts`; what a browser makes of it, in the
 * end-to-end test. This file holds what must stay true of the two files
 * themselves.
 */
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("./popup.html");
const css = read("./popup.css");
const script = read("./popup.ts");

/** A file without its comments, which may say anything. */
const code = (source: string) =>
  source.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The page's one link: to the app, for the user to follow. */
const LINK_TO_THE_APP = /<a\b[^>]*>/g;

test("the popup loads its own stylesheet and script and nothing else, from nowhere else", () => {
  const page = code(html);

  expect(page.match(/<link\b[^>]*>/g)).toEqual([
    '<link rel="stylesheet" href="popup.css" />',
  ]);
  expect(page.match(/<script\b[^>]*>[\s\S]*?<\/script>/g)).toEqual([
    '<script src="popup.js"></script>',
  ]);
  for (const source of [page.replace(LINK_TO_THE_APP, ""), code(css)]) {
    // No address of any kind: no remote font, image, stylesheet or script.
    expect(source).not.toMatch(/https?:|\/\/|url\(|@import|@font-face/i);
    expect(source).not.toMatch(
      /<(?:img|picture|video|audio|source|iframe|embed|object|base|meta\s+http-equiv)\b/i,
    );
    expect(source).not.toMatch(/\bstyle=|\bon[a-z]+=/i);
  }
  // The script asks the service worker and nobody else.
  expect(script).not.toMatch(
    /https?:|\bfetch\b|XMLHttpRequest|\.src\b|\.href\b/,
  );
});

test("the one link on the page leads to the app's own address, and says nothing of where it came from", () => {
  expect(code(html).match(LINK_TO_THE_APP)).toEqual([
    `<a class="bar-link" href="${APP_ORIGIN}/" target="_blank" rel="noreferrer">`,
  ]);
});

test("the popup asks the user for the pairing token and for nothing else", () => {
  const fields = code(html).match(/<(?:input|textarea|select)\b[^>]*>/g) ?? [];

  expect(fields).toHaveLength(1);
  expect(fields[0]).toMatch(/id="token"/);
  // Never shown, never remembered by the browser.
  expect(fields[0]).toMatch(/type="password"/);
  expect(fields[0]).toMatch(/autocomplete="off"/);
});

test("every element the script reaches for is on the page, once", () => {
  const asked = new Set(
    [...script.matchAll(/element(?:<[^>]+>)?\(\s*"([^"]+)"/g)].map(
      ([, id]) => id,
    ),
  );

  expect(asked.size).toBeGreaterThan(15);
  for (const id of asked) {
    expect(html.split(`id="${id}"`).length - 1, `#${id}`).toBe(1);
  }
});

test("the mark in the bar is the icon's own shapes", () => {
  const mark = /<svg class="mark"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";

  expect(shapesOf(mark)).toEqual(
    shapesOf(read("../icons/icon.svg").replace(/<!--[\s\S]*?-->/g, "")),
  );
});

test("nothing moves for a reader who asked for reduced motion", () => {
  const sheet = code(css);
  const opening = "@media (prefers-reduced-motion: no-preference) {";
  const start = sheet.indexOf(opening);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = start + opening.length - 1;
  do {
    if (sheet[end] === "{") depth += 1;
    if (sheet[end] === "}") depth -= 1;
    end += 1;
  } while (depth > 0);
  const elsewhere = sheet.slice(0, start) + sheet.slice(end);

  // Every transition and every animation is declared inside that one block.
  expect(sheet.slice(start, end)).toMatch(/animation:/);
  expect(elsewhere).not.toMatch(/\b(?:transition|animation)[a-z-]*\s*:/);
  expect(sheet).not.toMatch(/transition:\s*all|transition-property:\s*all/);
});

test("light and dark are both defined, colour for colour", () => {
  const sheet = code(css);
  const names = (block: string) =>
    [...block.matchAll(/(--[a-z-]+):/g)].map(([, name]) => name).sort();
  const light = /:root \{([\s\S]*?)\}/.exec(sheet)?.[1] ?? "";
  const dark =
    /@media \(prefers-color-scheme: dark\) \{([\s\S]*?\})\s*\}/.exec(
      sheet,
    )?.[1] ?? "";

  expect(names(dark).length).toBeGreaterThan(8);
  // Everything but the two that are not colours.
  expect(names(dark)).toEqual(
    names(light).filter((name) => name !== "--radius" && name !== "--ease-out"),
  );
});
