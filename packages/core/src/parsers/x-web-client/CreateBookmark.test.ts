import { expect, test } from "vitest";
import { readFixture } from "../../testing/fixtures.ts";
import { parseCreateBookmark } from "./CreateBookmark.ts";

const response = readFixture(
  "x-web-client/CreateBookmark/2026-10-12-done.json",
);
const request = readFixture(
  "x-web-client/CreateBookmark/2026-10-12-done.request.json",
);
/** The post the fixture's request names. */
const postId: string = JSON.parse(request).variables.tweet_id;

test("X's confirmation that a post was bookmarked names the post from the request", () => {
  expect(postId).toMatch(/^[0-9]{19}$/);
  expect(parseCreateBookmark(response, request)).toEqual({
    outcome: "parsed",
    entries: [],
    warnings: [],
    mutation: { kind: "bookmarked", postId },
  });
});

test("the answer to the other mutation is not a bookmark made", () => {
  expect(
    parseCreateBookmark(
      readFixture("x-web-client/DeleteBookmark/2026-10-12-done.json"),
      request,
    ),
  ).toEqual({
    outcome: "failed",
    issue: {
      code: "missing-field",
      path: "$.data.tweet_bookmark_put",
      detail:
        "the field is absent; its parent has fields: tweet_bookmark_delete",
    },
  });
});
