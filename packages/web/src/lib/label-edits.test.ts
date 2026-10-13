import { expect, test } from "vitest";
import { offeredTags, tagChange } from "./label-edits.ts";

const VOCABULARY = ["ads", "auth", "nextjs", "react", "seo"];

test("a post's own tags are offered first, then the rest, each in the vocabulary's order", () => {
  expect(offeredTags(VOCABULARY, ["seo", "auth"])).toEqual([
    "auth",
    "seo",
    "ads",
    "nextjs",
    "react",
  ]);
  expect(offeredTags(VOCABULARY, [])).toEqual(VOCABULARY);
  // A tag the vocabulary no longer holds is not offered.
  expect(offeredTags(VOCABULARY, ["retired", "react"])).toEqual([
    "react",
    "ads",
    "auth",
    "nextjs",
    "seo",
  ]);
});

test("the order offered is worked out from the tags as they stood, and switching one does not change it", () => {
  // The list is ordered as it opens. The component keeps that order while
  // the list is open, whatever is switched; this is what it must not do.
  const opened = offeredTags(VOCABULARY, ["react"]);
  const afterASwitch = offeredTags(VOCABULARY, ["react", "seo"]);

  expect(opened.indexOf("ads")).toBe(1);
  // Ordered again after the switch, another tag would stand where the
  // pointer is: the second place is no longer the same tag.
  expect(afterASwitch[1]).not.toBe(opened[1]);
});

test("a tag put on or taken off is the owner's word, and one put back where the classifier had it is handed back", () => {
  const classifiers = ["nextjs", "react"];

  // Added: one the classifier did not give.
  expect(
    tagChange(["nextjs", "react", "seo"], classifiers, classifiers),
  ).toEqual({ addTags: ["seo"], removeTags: [], resetTags: [] });
  // Taken off: one the classifier gave.
  expect(tagChange(["nextjs"], classifiers, classifiers)).toEqual({
    addTags: [],
    removeTags: ["react"],
    resetTags: [],
  });
  // Put back: the classifier's again, with nothing of the owner's left on it.
  expect(tagChange(["nextjs", "react"], ["nextjs"], classifiers)).toEqual({
    addTags: [],
    removeTags: [],
    resetTags: ["react"],
  });
  // An added one taken off again: likewise.
  expect(
    tagChange(classifiers, ["nextjs", "react", "seo"], classifiers),
  ).toEqual({ addTags: [], removeTags: [], resetTags: ["seo"] });
  // Nothing switched, nothing asked.
  expect(tagChange(classifiers, classifiers, classifiers)).toEqual({
    addTags: [],
    removeTags: [],
    resetTags: [],
  });
});

test("a second switch is worked out from the first, not from what the app has answered so far", () => {
  const classifiers = ["react"];
  // The owner adds seo, and before the app has answered, adds ads too. The
  // list hands over all three; the row still shows the one.
  const first = tagChange(["react", "seo"], ["react"], classifiers);
  const second = tagChange(
    ["react", "seo", "ads"],
    ["react", "seo"],
    classifiers,
  );

  expect(first.addTags).toEqual(["seo"]);
  // Not seo again, and nothing taken off.
  expect(second).toEqual({ addTags: ["ads"], removeTags: [], resetTags: [] });
});
