import { expect, test } from "vitest";
import { readFixture } from "../../testing/fixtures.ts";
import { mutationParser } from "./mutation.ts";

const parse = mutationParser("tweet_bookmark_delete", "removed");
const response = readFixture(
  "x-web-client/DeleteBookmark/2026-10-12-done.json",
);
const request = readFixture(
  "x-web-client/DeleteBookmark/2026-10-12-done.request.json",
);
const SECRET = "the-secret-in-the-response";

/** The fixture's response with its answer replaced. */
function answering(answer: unknown): string {
  const json = JSON.parse(response);
  json.data.tweet_bookmark_delete = answer;
  return JSON.stringify(json);
}

test.each([
  ["another word", answering("Failed"), 'found "Failed"'],
  ["a sentence that could quote something", answering(SECRET), "found string"],
  ["nothing", answering(null), "found null"],
])(
  "an answer of %s is not a confirmation, so nothing is taken from the capture",
  (_, payload, found) => {
    expect(parse(payload, request)).toEqual({
      outcome: "failed",
      issue: {
        code: "unknown-variant",
        path: "$.data.tweet_bookmark_delete",
        detail: `expected one of Done; ${found}`,
      },
    });
  },
);

test("an error from X in place of the answer is not a confirmation", () => {
  const parsed = parse(
    JSON.stringify({ errors: [{ message: SECRET, code: 139 }] }),
    request,
  );

  expect(parsed).toEqual({
    outcome: "failed",
    issue: {
      code: "missing-field",
      path: "$.data",
      detail: "the field is absent; its parent has fields: errors",
    },
  });
  expect(JSON.stringify(parsed)).not.toContain(SECRET);
});

test.each([
  ["is not JSON", "Rate limit exceeded", request, "not-json", "$"],
  ["came with no request body", response, null, "missing-field", "$request"],
  [
    "came with no request body at all",
    response,
    undefined,
    "missing-field",
    "$request",
  ],
  [
    "came with a request body that is not JSON",
    response,
    `tweet_id=${SECRET}`,
    "not-json",
    "$request",
  ],
  [
    "came with a request that names no post",
    response,
    '{"variables":{},"queryId":"abc"}',
    "missing-field",
    "$request.variables.tweet_id",
  ],
  [
    "came with a request whose post id is a number, which loses digits",
    response,
    '{"variables":{"tweet_id":1861899614026727424}}',
    "wrong-type",
    "$request.variables.tweet_id",
  ],
  [
    "came with a request whose post id is not an id",
    response,
    `{"variables":{"tweet_id":"${SECRET}"}}`,
    "invalid-value",
    "$request.variables.tweet_id",
  ],
])(
  "a response that %s fails, and says where without quoting anything",
  (_, payload, requestBody, code, path) => {
    const parsed = parse(payload, requestBody);

    expect(parsed).toMatchObject({ outcome: "failed", issue: { code, path } });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  },
);
