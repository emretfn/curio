import { addTagAlias, retireTag } from "@curio/core";
import { expect, test } from "vitest";
import { openFiledLibrary, openFixtureLibrary } from "./library-testing.ts";
import { atLeastOf, DEFAULT_AT_LEAST, getTagsScreen } from "./tags.ts";

test("before anything is classified there is nothing proposed, and the vocabulary is the one the library began with", () => {
  const screen = getTagsScreen(openFixtureLibrary(), DEFAULT_AT_LEAST);

  expect(screen).toMatchObject({
    proposals: [],
    proposalsTotal: 0,
    proposalsBelow: 0,
    retired: [],
  });
  expect(screen.tags.length).toBeGreaterThan(20);
  for (const tag of screen.tags) {
    expect(tag).toMatchObject({ bookmarks: 0 });
    // Only what the screen shows of a tag is sent to it.
    expect(Object.keys(tag).toSorted()).toEqual([
      "aliases",
      "bookmarks",
      "tag",
    ]);
  }
});

test("proposals are listed in core's groups, the one name most proposed first and the others beside it, above a threshold", () => {
  const { store } = openFiledLibrary();

  const all = getTagsScreen(store, 1);
  const usual = getTagsScreen(store, DEFAULT_AT_LEAST);

  expect(all.proposals).toEqual([
    {
      name: "server-actions",
      bookmarks: 2,
      variants: [{ name: "server-action", bookmarks: 1 }],
      similarTags: [],
    },
    { name: "drizzle", bookmarks: 1, variants: [], similarTags: [] },
  ]);
  expect(all).toMatchObject({ proposalsTotal: 2, proposalsBelow: 0 });
  // The group was proposed for three bookmarks under its two names; the one
  // made once is left out, and counted.
  expect(usual.proposals.map(({ name }) => name)).toEqual(["server-actions"]);
  expect(usual).toMatchObject({
    proposalsTotal: 1,
    proposalsBelow: 1,
    atLeast: 2,
  });
});

test("the vocabulary is listed most used first, with the other ways each tag is written, and what was retired apart", () => {
  const { store } = openFiledLibrary();
  addTagAlias(store, "reactjs", "react");
  retireTag(store, "mcp");

  const { tags, retired } = getTagsScreen(store, DEFAULT_AT_LEAST);

  expect(tags[0]).toEqual({
    tag: "react",
    bookmarks: 2,
    aliases: ["reactjs"],
  });
  expect(tags.map(({ bookmarks }) => bookmarks)).toEqual(
    tags.map(({ bookmarks }) => bookmarks).toSorted((a, b) => b - a),
  );
  expect(tags.map(({ tag }) => tag)).not.toContain("mcp");
  // How many bookmarks would have it back.
  expect(retired).toEqual([{ tag: "mcp", bookmarks: 1, aliases: [] }]);
});

test.each([
  [undefined, DEFAULT_AT_LEAST],
  ["1", 1],
  ["5", 5],
  [["3", "9"], 3],
  ["0", DEFAULT_AT_LEAST],
  ["-1", DEFAULT_AT_LEAST],
  ["1.5", DEFAULT_AT_LEAST],
  ["many", DEFAULT_AT_LEAST],
  ["100000", DEFAULT_AT_LEAST],
])("the threshold asked for as %j is read as %i", (asked, expected) => {
  expect(atLeastOf(asked)).toBe(expected);
});
