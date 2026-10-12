import { expect, test } from "vitest";
import { readFixture } from "../../testing/fixtures.ts";
import { parseBookmarkFoldersSlice } from "./BookmarkFoldersSlice.ts";

const noFolders = readFixture(
  "x-web-client/BookmarkFoldersSlice/2026-10-12-no-folders.json",
);

test("the folder list of an account with no folders is understood, and holds no bookmarks", () => {
  expect(parseBookmarkFoldersSlice(noFolders)).toEqual({
    outcome: "parsed",
    entries: [],
    warnings: [],
  });
});

test("a folder list that names folders is not understood yet, and says so instead of reading as empty", () => {
  const json = JSON.parse(noFolders);
  json.data.viewer.user_results.result.bookmark_collections_slice.items = [
    { id: "1", name: "Reading list" },
  ];

  expect(parseBookmarkFoldersSlice(JSON.stringify(json))).toEqual({
    outcome: "failed",
    issue: {
      code: "unsupported-content",
      path: "$.data.viewer.user_results.result.bookmark_collections_slice.items",
      detail:
        "the response lists bookmark folders, and no parser reads folders yet",
    },
  });
});

test("a response of another shape fails and says where", () => {
  expect(
    parseBookmarkFoldersSlice('{"data":{"viewer":{"user_results":{}}}}'),
  ).toEqual({
    outcome: "failed",
    issue: {
      code: "missing-field",
      path: "$.data.viewer.user_results.result",
      detail: "the field is absent; its parent has no fields",
    },
  });
  expect(parseBookmarkFoldersSlice("Rate limit exceeded")).toMatchObject({
    outcome: "failed",
    issue: { code: "not-json" },
  });
});
