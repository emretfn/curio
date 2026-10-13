import { expect, test } from "vitest";
import {
  foldTagText,
  isCategoryId,
  isFormatId,
  MAX_TAG_LENGTH,
  OTHER_CATEGORY,
  TAG_SHAPE,
  TAXONOMY,
  taxonomyFingerprint,
  UNCLEAR_FORMAT,
} from "./taxonomy.ts";

/**
 * The fingerprint of each version of the taxonomy. A change to `TAXONOMY`
 * changes its fingerprint: raise `TAXONOMY.version` and add the new pair
 * here, keeping the old ones. The version is stored with every bookmark the
 * classifier files, and is how bookmarks filed under the old wording are
 * told from those filed under the new.
 */
// Version 1 was reworded before anything had been classified under it, and
// its fingerprint here is the reworded one. From the first real run on, a
// version that bookmarks are stored under is never reworded in place.
//
// Its fingerprint changed once more with no word of it changing: the tags
// and their aliases, which version 1 held, moved to the database with
// migration 7, where the owner can change them (`vocabulary.ts`). The
// categories, the rules and the formats are those the first bookmarks were
// classified under, word for word, so they are version 1 still.
const FINGERPRINTS: Record<number, string> = {
  1: "4045856214e98bf9",
};

test("the taxonomy is the one its version says it is", () => {
  expect(
    taxonomyFingerprint(),
    "TAXONOMY changed. Raise TAXONOMY.version and record the new fingerprint in this test.",
  ).toBe(FINGERPRINTS[TAXONOMY.version]);
  expect(Object.keys(FINGERPRINTS).map(Number)).toContain(TAXONOMY.version);
  expect(new Set(Object.values(FINGERPRINTS)).size).toBe(
    Object.keys(FINGERPRINTS).length,
  );
});

test("ids are unique, shaped like tags, and every part has its words", () => {
  for (const entries of [TAXONOMY.categories, TAXONOMY.formats]) {
    const ids = entries.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { id, label, definition } of entries) {
      expect(id).toMatch(TAG_SHAPE);
      expect(label.trim()).not.toBe("");
      expect(definition.length).toBeGreaterThan(20);
    }
  }
});

test("there is a category for what fits nowhere and a format for what cannot be told", () => {
  expect(isCategoryId(OTHER_CATEGORY)).toBe(true);
  expect(isFormatId(UNCLEAR_FORMAT)).toBe(true);
  expect(isCategoryId("guide")).toBe(false);
  expect(isFormatId("web-dev")).toBe(false);
});

test.each([
  ["Claude-Code", "claude-code"],
  ["#seo", "seo"],
  ["Görsel Üretimi", "gorsel-uretimi"],
  ["GÖRSEL ÜRETİMİ", "gorsel-uretimi"],
  ["acik_kaynak", "acik-kaynak"],
  ["özgeçmiş", "ozgecmis"],
  ["IŞIK", "isik"],
  ["  shadcn  ui ", "shadcn-ui"],
  ["next.js", "next.js"],
])("%s is folded to %s", (text, folded) => {
  expect(foldTagText(text)).toBe(folded);
});

test("a tag is lowercase words joined by hyphens, and not too long", () => {
  for (const tag of ["react", "claude-code", "web3", "a-b-c"]) {
    expect(tag).toMatch(TAG_SHAPE);
  }
  for (const text of [
    "",
    "React",
    "next.js",
    "two words",
    "-x",
    "x-",
    "a--b",
  ]) {
    expect(text).not.toMatch(TAG_SHAPE);
  }
  expect(MAX_TAG_LENGTH).toBeGreaterThan(20);
});

test("the fingerprint moves with any word of the taxonomy", () => {
  const reworded = {
    ...TAXONOMY,
    boundaryRules: [...TAXONOMY.boundaryRules, "One more rule."],
  };
  const renamed = { ...TAXONOMY, maxTagsPerPost: 5 };

  expect(taxonomyFingerprint(reworded)).not.toBe(taxonomyFingerprint());
  expect(taxonomyFingerprint(renamed)).not.toBe(taxonomyFingerprint());
  expect(taxonomyFingerprint({ ...TAXONOMY })).toBe(taxonomyFingerprint());
});
