import { expect, test } from "vitest";
import { getBookmark } from "./bookmarks.ts";
import { PARSER_VERSION } from "./parsers/index.ts";
import type { CaptureParser } from "./parsers/parsed.ts";
import { parseBookmarks } from "./parsers/x-web-client/Bookmarks.ts";
import {
  getCaptureParse,
  listParseIssues,
  parseCapture,
  parseCaptureWith,
  parsePendingCaptures,
  reparseAllCaptures,
  summariseParsing,
} from "./parsing.ts";
import { getRawCapture, insertRawCapture } from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";
import { readFixture } from "./testing/fixtures.ts";
import { openTempStore } from "./testing/temp-database.ts";

const textPosts = readFixture(
  "x-web-client/Bookmarks/2026-10-12-text-posts.json",
);
const media = readFixture("x-web-client/Bookmarks/2026-10-12-media.json");
/** What the text-posts fixture itself says, which a parse of it is compared with. */
interface RawEntry {
  entryId: string;
  sortIndex: string;
  content: {
    itemContent?: {
      tweet_results: {
        result: {
          core: { user_results: { result: { core: { screen_name: string } } } };
          legacy: {
            in_reply_to_screen_name?: string;
            entities: { urls?: { expanded_url: string }[] };
          };
        };
      };
    };
  };
}
const rawPosts = (
  JSON.parse(textPosts).data.bookmark_timeline_v2.timeline.instructions[0]
    .entries as RawEntry[]
).filter(({ entryId }) => entryId.startsWith("tweet-"));
/** The post ids of the text-posts fixture, in timeline order. */
const TEXT_POST_IDS = rawPosts.map(({ entryId }) => entryId.slice(6));
// The second post is a reply with a link and a card; the tests below follow it.
const [, REPLY = "", THIRD = "", FOURTH = ""] = TEXT_POST_IDS;
const reply = {
  sortIndex: rawPosts[1]?.sortIndex ?? "",
  post: rawPosts[1]?.content.itemContent?.tweet_results.result,
};
const replyAuthor = reply.post?.core.user_results.result.core.screen_name;
const replyLink = reply.post?.legacy.entities.urls?.[0]?.expanded_url;
const ENTRY_1 =
  "$.data.bookmark_timeline_v2.timeline.instructions[0].entries[1]";

const monday = new Date("2026-10-05T09:00:00.000Z");
const thursday = new Date("2026-10-08T18:30:00.000Z");

function store(
  payload: string,
  receivedAt: Date,
  operation = "Bookmarks",
  on: Store = openTempStore(),
): { store: Store; captureId: number } {
  const { id } = insertRawCapture(on, {
    source: "x-web-client",
    operation,
    payload,
    receivedAt,
  });
  return { store: on, captureId: id };
}

/** The text-posts fixture with one change to its second entry's post. */
function withSecondPost(
  change: (post: Record<string, unknown>) => void,
): string {
  const json = JSON.parse(textPosts);
  const entry =
    json.data.bookmark_timeline_v2.timeline.instructions[0].entries[1];
  change(entry.content.itemContent.tweet_results);
  return JSON.stringify(json);
}

/** Every derived row, to show that a second run leaves all of them as they were. */
function derivedRows(of: Store): unknown {
  const db = connectionOf(of);
  return {
    bookmarks: db.prepare("SELECT * FROM bookmarks ORDER BY id").all(),
    parses: db
      .prepare("SELECT * FROM capture_parses ORDER BY capture_id")
      .all(),
    issues: db.prepare("SELECT * FROM parse_issues ORDER BY id").all(),
    mutations: db
      .prepare("SELECT * FROM bookmark_mutations ORDER BY post_id")
      .all(),
  };
}

test("parsing a capture turns its posts into bookmarks, first seen when the capture was received", () => {
  const { store: on, captureId } = store(textPosts, monday);
  const before = Date.now();

  const parse = parseCapture(on, captureId);

  expect(parse).toEqual({
    captureId,
    outcome: "parsed",
    parserVersion: PARSER_VERSION,
    bookmarkCount: 5,
    unavailableCount: 0,
    failedEntryCount: 0,
    warningCount: 0,
    parsedAt: expect.any(Date),
  });
  expect(parse.parsedAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(getCaptureParse(on, captureId)).toEqual(parse);
  expect(listParseIssues(on)).toEqual([]);
  for (const postId of TEXT_POST_IDS) {
    expect(getBookmark(on, postId)).toMatchObject({
      postId,
      firstSeenAt: monday,
      firstSeenCaptureId: captureId,
      lastSeenAt: monday,
    });
  }
  expect(TEXT_POST_IDS).toHaveLength(5);
  expect(replyLink).toMatch(/^https:\/\/site6\.example\//);
  expect(getBookmark(on, REPLY)).toMatchObject({
    authorHandle: replyAuthor,
    inReplyToHandle: reply.post?.legacy.in_reply_to_screen_name,
    sortIndex: reply.sortIndex,
    // The fixture's sort indexes hold bookmark times an hour apart.
    estimatedBookmarkedAt: new Date("2026-05-31T22:00:00.000Z"),
    card: { name: "summary_large_image", domain: "site6.example" },
    links: [{ url: replyLink }],
  });
});

test("a capture of an operation nothing parses yet is recorded as that, which is not a failure", () => {
  const { store: on, captureId } = store(
    '{"data":{}}',
    monday,
    "BookmarkFolderTimeline",
  );

  expect(parseCapture(on, captureId)).toMatchObject({
    outcome: "no-parser",
    bookmarkCount: 0,
    failedEntryCount: 0,
  });
  expect(listParseIssues(on)).toEqual([]);
  expect(summariseParsing(on).captures).toEqual({
    parsed: 0,
    failed: 0,
    noParser: 1,
    pending: 0,
    outdated: 0,
  });
});

test("a response that is not understood is recorded as failed with where it stopped, and the raw capture stays", () => {
  const payload = '{"errors":[{"message":"Over capacity"}]}';
  const { store: on, captureId } = store(payload, monday);

  const parse = parseCapture(on, captureId);

  expect(parse).toMatchObject({ outcome: "failed", bookmarkCount: 0 });
  expect(listParseIssues(on, captureId)).toEqual([
    {
      captureId,
      kind: "capture-failed",
      entryIndex: null,
      entryId: null,
      postId: null,
      code: "missing-field",
      path: "$.data",
      detail: "the field is absent; its parent has fields: errors",
    },
  ]);
  expect(getRawCapture(on, captureId)?.payload).toBe(payload);
  expect(summariseParsing(on)).toMatchObject({
    bookmarks: 0,
    captures: { parsed: 0, failed: 1 },
  });
});

test("an entry that is not understood is recorded and the bookmarks around it are stored", () => {
  const { store: on, captureId } = store(
    withSecondPost((results) => {
      results.result = { __typename: "TweetPreview" };
    }),
    monday,
  );

  const parse = parseCapture(on, captureId);

  expect(parse).toMatchObject({
    outcome: "parsed",
    bookmarkCount: 4,
    failedEntryCount: 1,
  });
  expect(listParseIssues(on)).toEqual([
    {
      captureId,
      kind: "entry-failed",
      entryIndex: 1,
      entryId: `tweet-${REPLY}`,
      postId: REPLY,
      code: "unknown-variant",
      path: `${ENTRY_1}.content.itemContent.tweet_results.result.__typename`,
      detail:
        'expected one of Tweet, TweetWithVisibilityResults, TweetTombstone, TweetUnavailable; found "TweetPreview"',
    },
  ]);
  expect(getBookmark(on, REPLY)).toBeUndefined();
  expect(getBookmark(on, THIRD)).toBeDefined();
  expect(summariseParsing(on)).toMatchObject({
    bookmarks: 4,
    captures: { parsed: 1, failed: 0 },
    failedEntries: 1,
  });
});

test("a bookmark whose post X withholds is recorded by its id, and an earlier copy of it is kept", () => {
  const on = openTempStore();
  const earlier = store(textPosts, monday, "Bookmarks", on).captureId;
  const later = store(
    withSecondPost((results) => {
      results.result = { __typename: "TweetTombstone" };
    }),
    thursday,
    "Bookmarks",
    on,
  ).captureId;
  parseCapture(on, earlier);

  const parse = parseCapture(on, later);

  expect(parse).toMatchObject({
    outcome: "parsed",
    bookmarkCount: 4,
    unavailableCount: 1,
    failedEntryCount: 0,
  });
  expect(listParseIssues(on, later)).toEqual([
    {
      captureId: later,
      kind: "post-unavailable",
      entryIndex: 1,
      entryId: `tweet-${REPLY}`,
      postId: REPLY,
      code: "post-unavailable",
      path: `${ENTRY_1}.content.itemContent.tweet_results.result`,
      detail: "X sent a TweetTombstone",
    },
  ]);
  expect(getBookmark(on, REPLY)).toMatchObject({
    authorHandle: replyAuthor,
    lastSeenCaptureId: earlier,
  });
  expect(summariseParsing(on).unavailableEntries).toBe(1);
});

test("a part that is not understood is left empty in a stored bookmark, and recorded as a warning", () => {
  const { store: on, captureId } = store(
    withSecondPost((results) => {
      (
        results.result as { card: { legacy: { name: string } } }
      ).card.legacy.name = "poll2choice_text_only";
    }),
    monday,
  );

  expect(parseCapture(on, captureId)).toMatchObject({
    outcome: "parsed",
    bookmarkCount: 5,
    failedEntryCount: 0,
    warningCount: 1,
  });
  expect(listParseIssues(on)).toMatchObject([
    {
      kind: "warning",
      entryIndex: 1,
      postId: REPLY,
      code: "unknown-variant",
      path: `${ENTRY_1}.content.itemContent.tweet_results.result.card.legacy.name`,
    },
  ]);
  expect(getBookmark(on, REPLY)).toMatchObject({
    card: null,
    links: [{ url: replyLink }],
  });
});

test("a parser that throws is recorded as a failure of that capture, without the message it threw", () => {
  const { store: on, captureId } = store(textPosts, monday);
  const broken: CaptureParser = (payload) => {
    throw new TypeError(`could not read ${payload.slice(0, 40)}`);
  };

  const parse = parseCaptureWith(on, captureId, broken);

  expect(parse).toMatchObject({ outcome: "failed", bookmarkCount: 0 });
  expect(listParseIssues(on)).toEqual([
    {
      captureId,
      kind: "capture-failed",
      entryIndex: null,
      entryId: null,
      postId: null,
      code: "parser-crashed",
      path: "$",
      detail: expect.stringMatching(
        /^TypeError in \S+ \(parsing\.test\.ts:\d+\)$/,
      ),
    },
  ]);
});

test("a parsed bookmark the database refuses is recorded against its entry, and the others are stored", () => {
  const { store: on, captureId } = store(textPosts, monday);
  const careless: CaptureParser = (payload) => {
    const parsed = parseBookmarks(payload);
    const second = parsed.outcome === "parsed" ? parsed.entries[1] : undefined;
    if (second?.kind === "bookmark") second.bookmark.authorId = "@not-an-id";
    return parsed;
  };

  const parse = parseCaptureWith(on, captureId, careless);

  expect(parse).toMatchObject({
    outcome: "parsed",
    bookmarkCount: 4,
    failedEntryCount: 1,
  });
  expect(listParseIssues(on)).toEqual([
    {
      captureId,
      kind: "entry-failed",
      entryIndex: 1,
      entryId: `tweet-${REPLY}`,
      postId: REPLY,
      code: "not-storable",
      path: ENTRY_1,
      detail: expect.stringMatching(
        /^SQLITE_CONSTRAINT_CHECK: CHECK constraint failed/,
      ),
    },
  ]);
  expect(getBookmark(on, REPLY)).toBeUndefined();
  expect(summariseParsing(on).bookmarks).toBe(4);
});

test("a sort index that does not hold a believable bookmark time gives no estimate, and says so", () => {
  // Received before the bookmark times the fixture's sort indexes encode.
  const tooEarly = new Date("2026-03-01T00:00:00.000Z");
  const { store: on, captureId } = store(textPosts, tooEarly);

  expect(parseCapture(on, captureId)).toMatchObject({
    bookmarkCount: 5,
    warningCount: 5,
  });
  expect(getBookmark(on, REPLY)).toMatchObject({
    sortIndex: reply.sortIndex,
    estimatedBookmarkedAt: null,
    firstSeenAt: tooEarly,
  });
  expect(listParseIssues(on)[1]).toEqual({
    captureId,
    kind: "warning",
    entryIndex: 1,
    entryId: `tweet-${REPLY}`,
    postId: REPLY,
    code: "invalid-value",
    path: `${ENTRY_1}.sortIndex`,
    detail:
      "expected sortIndex >> 20 to be a time between the post's and the capture's; no bookmark time was estimated",
  });
});

test("parsing a capture that does not exist throws", () => {
  expect(() => parseCapture(openTempStore(), 7)).toThrow(
    /Raw capture 7 does not exist/,
  );
});

test("pending captures are the ones never parsed, and are parsed oldest received first", () => {
  const on = openTempStore();
  // Stored newest first, as a queue that drains out of order would.
  const newer = store(textPosts, thursday, "Bookmarks", on).captureId;
  const older = store(textPosts, monday, "Bookmarks", on).captureId;
  const mutation = store("{}", thursday, "DeleteBookmark", on).captureId;
  expect(summariseParsing(on).captures.pending).toBe(3);

  const parses = parsePendingCaptures(on);

  expect(parses.map(({ captureId }) => captureId)).toEqual([
    older,
    newer,
    mutation,
  ]);
  expect(getBookmark(on, REPLY)).toMatchObject({
    firstSeenAt: monday,
    firstSeenCaptureId: older,
    lastSeenAt: thursday,
    lastSeenCaptureId: newer,
  });
  expect(parsePendingCaptures(on)).toEqual([]);
  expect(summariseParsing(on).captures.pending).toBe(0);
});

test("a full re-parse run a second time changes nothing at all", () => {
  const on = openTempStore();
  store(textPosts, monday, "Bookmarks", on);
  store(media, thursday, "Bookmarks", on);
  store('{"errors":[]}', thursday, "Bookmarks", on);
  store("{}", thursday, "BookmarkFolderTimeline", on);
  store(
    withSecondPost((results) => {
      results.result = { __typename: "TweetPreview" };
    }),
    thursday,
    "Bookmarks",
    on,
  );

  expect(reparseAllCaptures(on)).toEqual({ captures: 5, changed: 5 });
  const afterFirst = derivedRows(on);
  expect(reparseAllCaptures(on)).toEqual({ captures: 5, changed: 0 });

  expect(derivedRows(on)).toEqual(afterFirst);
  expect(summariseParsing(on)).toMatchObject({
    bookmarks: 9,
    captures: { parsed: 3, failed: 1, noParser: 1, pending: 0, outdated: 0 },
    failedEntries: 1,
  });
});

test("after a parser is fixed, a re-parse fills in what the old one missed, dated to the capture and not to the fix", () => {
  const { store: on, captureId } = store(textPosts, monday);
  const old: CaptureParser = (payload) => {
    const parsed = parseBookmarks(payload);
    if (parsed.outcome !== "parsed") return parsed;
    const entries = parsed.entries.map((entry) =>
      entry.index === 1 && entry.kind === "bookmark"
        ? {
            index: entry.index,
            path: entry.path,
            entryId: entry.entryId,
            kind: "failed" as const,
            postId: entry.bookmark.postId,
            issue: {
              code: "missing-field" as const,
              path: `${entry.path}.content`,
              detail: "a shape the old parser did not know",
            },
          }
        : entry.kind === "bookmark"
          ? { ...entry, bookmark: { ...entry.bookmark, text: "excerpt only" } }
          : entry,
    );
    return { ...parsed, entries };
  };
  parseCaptureWith(on, captureId, old);
  expect(getBookmark(on, REPLY)).toBeUndefined();
  expect(getBookmark(on, FOURTH)?.text).toBe("excerpt only");
  expect(listParseIssues(on)).toHaveLength(1);

  expect(reparseAllCaptures(on)).toEqual({ captures: 1, changed: 1 });

  expect(getBookmark(on, REPLY)).toMatchObject({
    firstSeenAt: monday,
    firstSeenCaptureId: captureId,
  });
  expect(getBookmark(on, FOURTH)).toMatchObject({
    text: expect.stringMatching(/^lorem ipsum dolor sit amet/),
    firstSeenAt: monday,
  });
  expect(listParseIssues(on)).toEqual([]);
  expect(getCaptureParse(on, captureId)).toMatchObject({
    bookmarkCount: 5,
    failedEntryCount: 0,
  });
});

test("a re-parse takes each bookmark's first-seen from its earliest capture and its content from its latest", () => {
  const on = openTempStore();
  const edited = JSON.parse(textPosts);
  edited.data.bookmark_timeline_v2.timeline.instructions[0].entries[3].content.itemContent.tweet_results.result.legacy.favorite_count = 9000;
  // Stored out of order: the later capture has the lower id.
  const later = store(
    JSON.stringify(edited),
    thursday,
    "Bookmarks",
    on,
  ).captureId;
  const earlier = store(textPosts, monday, "Bookmarks", on).captureId;

  reparseAllCaptures(on);

  expect(getBookmark(on, FOURTH)).toMatchObject({
    likeCount: 9000,
    firstSeenAt: monday,
    firstSeenCaptureId: earlier,
    lastSeenAt: thursday,
    lastSeenCaptureId: later,
  });
});

test("the summary counts what is pending and what another parser version parsed, and gives the time of the last recorded parse", () => {
  const on = openTempStore();
  expect(summariseParsing(on)).toEqual({
    bookmarks: 0,
    captures: { parsed: 0, failed: 0, noParser: 0, pending: 0, outdated: 0 },
    failedEntries: 0,
    unavailableEntries: 0,
    warnings: 0,
    lastParsedAt: null,
  });
  const first = store(textPosts, monday, "Bookmarks", on).captureId;
  store(media, thursday, "Bookmarks", on);
  const { parsedAt } = parseCapture(on, first);

  expect(summariseParsing(on)).toEqual({
    bookmarks: 5,
    captures: { parsed: 1, failed: 0, noParser: 0, pending: 1, outdated: 0 },
    failedEntries: 0,
    unavailableEntries: 0,
    warnings: 0,
    lastParsedAt: parsedAt,
  });

  // As after the parsers change and PARSER_VERSION is raised.
  connectionOf(on)
    .prepare("UPDATE capture_parses SET parser_version = ?")
    .run(PARSER_VERSION + 1);
  expect(summariseParsing(on).captures).toMatchObject({ outdated: 1 });

  expect(reparseAllCaptures(on)).toEqual({ captures: 2, changed: 2 });
  expect(summariseParsing(on).captures).toEqual({
    parsed: 2,
    failed: 0,
    noParser: 0,
    pending: 0,
    outdated: 0,
  });
});
