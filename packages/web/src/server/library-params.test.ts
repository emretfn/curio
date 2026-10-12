import { expect, test } from "vitest";
import {
  isNarrowed,
  libraryHref,
  NO_PARAMS,
  parseLibraryParams,
  toggleFeature,
  toLibraryQuery,
} from "./library-params.ts";

test("an address is read into parameters, and written back the same", () => {
  const href =
    "/?q=a+b&has=media%2Cquote&lang=tr&year=2025&author=42&on=withheld";

  const params = parseLibraryParams(new URLSearchParams(href.slice(2)));

  expect(params).toEqual({
    q: "a b",
    has: ["media", "quote"],
    lang: "tr",
    year: 2025,
    author: "42",
    on: "withheld",
  });
  expect(libraryHref(params)).toBe(href);
});

test("anything the address should not hold is dropped", () => {
  const params = parseLibraryParams({
    q: `  ${"x".repeat(500)}  `,
    has: "media,drop-table,MEDIA,,quote",
    lang: "klingon",
    year: "20x5",
    author: "12; DROP",
    on: ["removed", "withheld"],
    extra: "ignored",
  });

  expect(params.q).toHaveLength(200);
  expect(params.has).toEqual(["media", "quote"]);
  expect(params.lang).toBeUndefined();
  expect(params.year).toBeUndefined();
  expect(params.author).toBeUndefined();
  expect(params.on).toBe("removed");
});

test("no parameters is the whole library, at the root address", () => {
  expect(parseLibraryParams({})).toEqual(NO_PARAMS);
  expect(libraryHref(NO_PARAMS)).toBe("/");
  expect(isNarrowed(NO_PARAMS)).toBe(false);
  expect(isNarrowed({ ...NO_PARAMS, lang: "en" })).toBe(true);
});

test("a feature is switched on and off, in one fixed order", () => {
  const on = toggleFeature(toggleFeature(NO_PARAMS, "quote"), "media");

  expect(on.has).toEqual(["media", "quote"]);
  expect(toggleFeature(on, "quote").has).toEqual(["media"]);
});

test("a year is that calendar year, from its first moment to the next year's", () => {
  const query = toLibraryQuery({ ...NO_PARAMS, year: 2025 });

  expect(query.savedFrom).toEqual(new Date(2025, 0, 1));
  expect(query.savedBefore).toEqual(new Date(2026, 0, 1));
  expect(toLibraryQuery(NO_PARAMS).savedFrom).toBeUndefined();
});
