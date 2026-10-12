import { globSync } from "node:fs";
import { expect, test } from "vitest";
import { readFixture } from "../../testing/fixtures.ts";
import { findLeaks } from "./leaks.ts";
import { createRedactor } from "./redact.ts";
import { INVENTED, inventedCapture } from "./sample.ts";

const real = [JSON.stringify(inventedCapture)];
const redacted = () =>
  createRedactor().redact(structuredClone(inventedCapture));
const POST =
  "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result";

function fixtureWith(change: (post: Record<string, unknown>) => void) {
  const json = redacted() as typeof inventedCapture;
  const [entry] =
    json.data.bookmark_timeline_v2.timeline.instructions[0]?.entries ?? [];
  change(
    entry?.content.itemContent?.tweet_results.result as unknown as Record<
      string,
      unknown
    >,
  );
  return [{ name: "leaky.json", text: JSON.stringify(json) }];
}

test("a properly redacted fixture holds nothing from the capture it was made from", () => {
  expect(
    findLeaks(real, [{ name: "clean.json", text: JSON.stringify(redacted()) }]),
  ).toEqual([]);
});

test("an unredacted capture is caught, on every value that is not one of X's constants", () => {
  const leaks = findLeaks(real, [{ name: "raw.json", text: real[0] ?? "" }]);

  expect(leaks.length).toBeGreaterThan(20);
  expect(leaks.map(({ path }) => path)).toEqual(
    expect.arrayContaining([
      `${POST}.rest_id`,
      `${POST}.legacy.full_text`,
      `${POST}.core.user_results.result.core.screen_name`,
      `${POST}.core.user_results.result.core.name`,
      `${POST}.legacy.entities.urls[0].expanded_url`,
    ]),
  );
  expect(leaks.map(({ path }) => path)).not.toEqual(
    expect.arrayContaining([`${POST}.__typename`]),
  );
});

test.each([
  [
    "a real handle left whole",
    "screen_name",
    INVENTED.handle,
    "is a real value",
  ],
  [
    "a real post id inside an invented link",
    "permalink",
    `https://x.com/someone/status/${INVENTED.postId}`,
    "contains a real value",
  ],
  [
    "a real link inside invented text",
    "note",
    `lorem ipsum ${INVENTED.shortLink} dolor`,
    "contains a real value",
  ],
  [
    "a real site inside an invented link",
    "card_url",
    `https://${INVENTED.site}/lorem`,
    "contains a real value",
  ],
  [
    "a real mention inside invented text",
    "bio",
    `lorem @${INVENTED.mentioned} ipsum`,
    "contains a real value",
  ],
  ["a real text left whole", "title", INVENTED.text, "is a real value"],
])(
  "%s is reported with where it is, and without repeating it",
  (_, field, value, how) => {
    const leaks = findLeaks(
      real,
      fixtureWith((post) => {
        post[field] = value;
      }),
    );

    expect(leaks).toContainEqual({
      fixture: "leaky.json",
      path: `${POST}.${field}`,
      how,
    });
    expect(JSON.stringify(leaks)).not.toContain(value);
  },
);

test("what was captured beside the response is checked too: the request's URL and body", () => {
  const requestUrl =
    "https://x.com/i/api/graphql/abc/Bookmarks?variables=%7B%22cursor%22%3A%22HBaAgLDRn4yXzzQAAA%22%7D";

  const leaks = findLeaks(
    [...real, requestUrl],
    fixtureWith((post) => {
      post.request = requestUrl;
    }),
  );

  expect(leaks).toContainEqual({
    fixture: "leaky.json",
    path: `${POST}.request`,
    how: "is a real value",
  });
});

test("X's own constants and small numbers may be shared, and nothing else", () => {
  const shared = {
    type: "photo",
    state: "EnabledWithCount",
    count: "937",
    n: 12,
  };

  expect(
    findLeaks(
      [JSON.stringify({ ...shared, name: "Real Name", id: 123456789 })],
      [{ name: "f.json", text: JSON.stringify(shared) }],
    ),
  ).toEqual([]);
  expect(
    findLeaks(
      [JSON.stringify({ name: "Real Name", id: 123456789 })],
      [
        {
          name: "f.json",
          text: JSON.stringify({ a: "Real Name", b: 123456789 }),
        },
      ],
    ),
  ).toEqual([
    { fixture: "f.json", path: "$.a", how: "is a real value" },
    { fixture: "f.json", path: "$.b", how: "is a real value" },
  ]);
});

// The check against the real captures needs the real database, which exists
// on one machine only: `pnpm fixtures:check` runs it there. What can be
// checked anywhere is that each committed fixture was made by the redactor,
// which a response saved by hand would not pass.
test("every committed fixture bears the redactor's marks: invented times, one language, no outside hosts", () => {
  const names = globSync("**/*.json", {
    cwd: new URL("../fixtures/", import.meta.url),
  });
  expect(names.length).toBeGreaterThanOrEqual(7);

  for (const name of names) {
    const visit = (value: unknown, key: string): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key);
      } else if (typeof value === "object" && value !== null) {
        for (const [field, item] of Object.entries(value)) visit(item, field);
      } else if (typeof value === "string") {
        if (key === "created_at") {
          expect(value, name).toMatch(
            /^\w{3} Jan \d{2} \d{2}:00:00 \+0000 2026$/,
          );
        }
        if (key === "lang") expect(value, name).toBe("en");
        if (key === "sortIndex") {
          const bookmarked = new Date(
            Number(BigInt(value) >> 20n),
          ).toISOString();
          expect(bookmarked, name).toMatch(/^2026-05-\d{2}T\d{2}:00:00\.000Z$/);
        }
        for (const [, host] of value.matchAll(/https?:\/\/([^/\s"?]+)/g)) {
          expect(host, name).toMatch(
            /^(t\.co|x\.com|twitter\.com|(pbs|video)\.twimg\.com|example\.com|site\d+\.example)$/,
          );
        }
      }
    };
    visit(JSON.parse(readFixture(name)), "");
  }
});
