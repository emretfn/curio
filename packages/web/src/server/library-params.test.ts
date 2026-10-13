import { expect, test } from "vitest";
import {
  isNarrowed,
  libraryHref,
  NO_PARAMS,
  parseLibraryParams,
  toggleCategory,
  toggleFeature,
  toggleTag,
  toLibraryQuery,
} from "./library-params.ts";

test("an address is read into parameters, and written back the same", () => {
  const href =
    "/?q=a+b&has=media%2Cquote&lang=tr&year=2025&author=42&on=withheld&cat=other&text=little&fmt=guide&tag=nextjs%2Creklam&proposed=server-actions";

  const params = parseLibraryParams(new URLSearchParams(href.slice(2)));

  expect(params).toEqual({
    q: "a b",
    has: ["media", "quote"],
    lang: "tr",
    year: 2025,
    author: "42",
    on: "withheld",
    cat: "other",
    text: "little",
    fmt: "guide",
    tag: ["nextjs", "reklam"],
    proposed: "server-actions",
  });
  expect(libraryHref(params)).toBe(href);
});

test("what a bookmark is filed under is asked for by the taxonomy's ids, and anything else is dropped", () => {
  const read = (search: string) =>
    parseLibraryParams(new URLSearchParams(search));

  expect(read("cat=web-dev").cat).toBe("web-dev");
  expect(read("cat=none").cat).toBe("none");
  expect(read("cat=cooking").cat).toBeUndefined();
  expect(read("cat=WEB-DEV").cat).toBeUndefined();
  expect(read("fmt=guide").fmt).toBe("guide");
  expect(read("fmt=thread").fmt).toBeUndefined();
  // Why a bookmark is under "other" is asked only of "other".
  expect(read("cat=other&text=enough").text).toBe("enough");
  expect(read("cat=web-dev&text=little").text).toBeUndefined();
  expect(read("text=little").text).toBeUndefined();
  expect(read("cat=other&text=some").text).toBeUndefined();
  expect(libraryHref({ ...NO_PARAMS, cat: "design", text: "little" })).toBe(
    "/?cat=design",
  );
});

test("tags are a short list of names, each once, and a proposal is one name", () => {
  const read = (search: string) =>
    parseLibraryParams(new URLSearchParams(search));

  expect(read("tag=nextjs,,react,nextjs, auth ").tag).toEqual([
    "nextjs",
    "react",
    "auth",
  ]);
  expect(read(`tag=${"x".repeat(65)},ok`).tag).toEqual(["ok"]);
  expect(
    read(`tag=${Array.from({ length: 20 }, (_, n) => `t${n}`)}`).tag,
  ).toHaveLength(8);
  expect(read("proposed=Server+Actions").proposed).toBe("Server Actions");
  expect(read(`proposed=${"x".repeat(65)}`).proposed).toBeUndefined();
  expect(read("proposed=").proposed).toBeUndefined();
});

test("a category is chosen and let go, with its reason, and a tag is added and taken off", () => {
  const design = toggleCategory(NO_PARAMS, "design");
  expect(design.cat).toBe("design");
  expect(toggleCategory(design, "design").cat).toBeUndefined();
  expect(toggleCategory(design, "web-dev").cat).toBe("web-dev");

  const little = toggleCategory(design, "other", "little");
  expect(little).toMatchObject({ cat: "other", text: "little" });
  expect(toggleCategory(little, "other", "enough")).toMatchObject({
    cat: "other",
    text: "enough",
  });
  expect(toggleCategory(little, "other", "little")).toMatchObject({
    cat: undefined,
    text: undefined,
  });
  // Another category leaves the reason behind.
  expect(toggleCategory(little, "design").text).toBeUndefined();

  const tagged = toggleTag(toggleTag(NO_PARAMS, "nextjs"), "auth");
  expect(tagged.tag).toEqual(["nextjs", "auth"]);
  expect(toggleTag(tagged, "nextjs").tag).toEqual(["auth"]);
  expect(toLibraryQuery(little)).toMatchObject({
    category: "other",
    otherReason: "little",
  });
});

test("anything the address should not hold is dropped", () => {
  const params = parseLibraryParams({
    q: `  ${"x".repeat(500)}  `,
    has: "media,drop-table,MEDIA,,quote",
    lang: "klingon",
    year: "20x5",
    author: "12; DROP",
    on: ["removed", "withheld"],
    cat: "1; DROP",
    fmt: ["guide", "tip"],
    tag: "a\nb",
    extra: "ignored",
  });

  expect(params.q).toHaveLength(200);
  expect(params.has).toEqual(["media", "quote"]);
  expect(params.lang).toBeUndefined();
  expect(params.year).toBeUndefined();
  expect(params.author).toBeUndefined();
  expect(params.on).toBe("removed");
  expect(params.cat).toBeUndefined();
  expect(params.fmt).toBe("guide");
  expect(params.tag).toEqual([]);
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
