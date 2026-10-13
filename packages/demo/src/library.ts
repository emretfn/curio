/**
 * Builds the demo library: a few hundred invented posts, saved over half a
 * year, filed, corrected and summarised, in a database of its own.
 *
 * It is made the way a real library is. The posts are written as pages of
 * the bookmarks timeline and stored as raw captures, core's parser turns
 * them into bookmarks, and everything else is written with the functions
 * the classifier, the owner's screens and the digest's writer use. Nothing
 * here calls Claude, makes a request or reads another library.
 *
 * Everything is placed in time from `now`, so that the demo is current on
 * the day it is built: the newest post was saved minutes ago, and the week
 * that last ended is the one the sample digest is of.
 */
import {
  addTag,
  correctBookmark,
  finishDigestRun,
  INSTRUCTIONS_VERSION,
  insertRawCaptureOnce,
  latestWeekEnded,
  parsePendingCaptures,
  recordClassification,
  type Store,
  startDigestRun,
  summariseRawCaptures,
  type Week,
} from "@curio/core";
import { AUTHORS, type AuthorKey } from "./authors.ts";
import { DIGEST } from "./digest.ts";
import type { PostSpec } from "./post-spec.ts";
import { POSTS } from "./posts/index.ts";
import {
  type DemoAuthor,
  type DemoEntry,
  type DemoPost,
  sortIndexAt,
  timelinePage,
} from "./timeline.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far back the demo's bookmarks go. */
export const WEEKS_COVERED = 26;
/** Posts to a page of the timeline, as the web client loads them. */
const PAGE_SIZE = 20;

/**
 * The tags the demo's owner added to the vocabulary beyond the set a library
 * starts with, as an owner does from the Tags page.
 */
export const OWNER_TAGS = [
  "sqlite",
  "postgres",
  "typescript",
  "css",
  "testing",
  "accessibility",
] as const;

/**
 * What stands in a classification where the model's name goes. No model was
 * asked: the demo's labels were written with its posts.
 */
export const DEMO_CLASSIFIER = "none (demo data)";
/** The same for the sample digest, which the page shows beside "Written by Claude". */
export const DEMO_DIGEST_WRITER = "sample text, no API call";

/**
 * The posts that play a part: each is found by the `key` it carries in
 * `posts/`.
 */
const ROLES = {
  /** Captured once, three weeks ago, and withheld by X since: the library keeps its copy. */
  keptCopy: "kept-copy",
  /** Un-bookmarked in the browser a minute ago: kept, and marked as removed. */
  removed: "removed-on-x",
  /** Bookmarked in the browser while capturing, so its time is exact. */
  observed: "observed",
} as const;

/** The owner's corrections, by the key of the post each is made on. */
const CORRECTIONS: {
  key: string;
  correction: Parameters<typeof correctBookmark>[2];
}[] = [
  // Advice about agents that is really about securing a database: the
  // owner files it with the infrastructure, and it keeps its tags.
  { key: "refiled", correction: { category: "tools" } },
  { key: "wal-checkpoint", correction: { addTags: ["self-hosting"] } },
  {
    key: "corrected-tags",
    correction: { removeTags: ["chatgpt"], format: "tip" },
  },
];

/** A small seeded generator, so that one build is like the next. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An id no post or account of X's can have: twenty digits beginning with
 * nine is above what the 64 bits of one of X's ids hold.
 */
const inventedId = (lead: 8 | 9, serial: number) =>
  String(
    BigInt(lead) * 10n ** 19n + BigInt(serial + 1) * 7_368_787n * 1_000_003n,
  );

const AUTHOR_KEYS = Object.keys(AUTHORS) as AuthorKey[];

export function demoAuthor(key: AuthorKey): DemoAuthor {
  const spec: { name: string; handle: string; verified?: true } = AUTHORS[key];
  return {
    id: inventedId(8, AUTHOR_KEYS.indexOf(key)),
    handle: spec.handle,
    name: spec.name,
    verified: spec.verified === true,
  };
}

interface Placed {
  spec: PostSpec;
  post: DemoPost;
  savedAt: Date;
}

export interface DemoLibrary {
  /** Bookmarks the library holds, the one removed on X among them. */
  bookmarks: number;
  /** Bookmarks whose post X withholds and the library never held. */
  neverHeld: number;
  captures: number;
  /** The week the sample digest is of. */
  digestWeek: Week;
  /** The post ids behind the keys the demo's own parts are found by. */
  keyed: Record<string, string>;
}

/**
 * Fills an empty store with the demo library. It refuses a store that holds
 * anything, so it can never be run over a library of someone's own.
 */
export function buildDemoLibrary(
  store: Store,
  options: { now?: Date } = {},
): DemoLibrary {
  if (summariseRawCaptures(store).count > 0) {
    throw new Error(
      "The demo is built into an empty library of its own, and this one holds captures.",
    );
  }
  const now = options.now ?? new Date();
  const random = seeded(20261013);
  const between = (from: number, to: number) => from + random() * (to - from);

  // --- When each post was saved -------------------------------------------
  const digestWeek = latestWeekEnded(now);
  const latest = now.getTime() - 12 * MINUTE;
  const weekStart = digestWeek.start.getTime();
  const weekEnd = Math.min(digestWeek.end.getTime(), latest);
  // The days since the digest's week. On a Sunday evening that week is
  // still running and there are none: those posts close the week instead.
  const sinceStart =
    latest - digestWeek.end.getTime() > HOUR
      ? digestWeek.end.getTime()
      : weekEnd - DAY;
  const archiveStart = weekStart - WEEKS_COVERED * 7 * DAY;

  const spread = (specs: PostSpec[], from: number, to: number): number[] =>
    // Newest first, as the lists are written, with room between them.
    specs.map((_, index) => {
      const slot = (to - from) / specs.length;
      return to - slot * (index + between(0.15, 0.85));
    });
  const since = POSTS.filter(({ saved }) => saved === "since");
  const ofWeek = POSTS.filter(({ saved }) => saved === "digest-week");
  const archive = POSTS.filter(({ saved }) => saved === undefined);
  const savedTimes = new Map<PostSpec, number>();
  spread(since, sinceStart, latest).forEach((at, index) => {
    savedTimes.set(since[index] as PostSpec, at);
  });
  spread(ofWeek, weekStart, Math.min(weekEnd, sinceStart)).forEach(
    (at, index) => {
      savedTimes.set(ofWeek[index] as PostSpec, at);
    },
  );
  for (const spec of archive) {
    // A little denser toward the present, as a habit that grew.
    const at = archiveStart + (weekStart - archiveStart) * random() ** 0.8;
    savedTimes.set(spec, Math.min(at, weekStart - MINUTE));
  }

  // --- The posts ----------------------------------------------------------
  let serial = 0;
  const counts = () => {
    const likes = Math.round(10 ** between(1.3, 3.9));
    return {
      likes,
      reposts: Math.round(likes * between(0.06, 0.2)),
      replies: Math.round(likes * between(0.02, 0.08)),
      quotes: Math.round(likes * between(0.005, 0.03)),
      bookmarks: Math.round(likes * between(0.3, 0.9)),
      views: Math.round(likes * between(30, 90)),
    };
  };
  const placed: Placed[] = POSTS.map((spec) => {
    const savedAt = savedTimes.get(spec) as number;
    // Most posts are saved within days of being written; some are old finds.
    const age =
      random() < 0.12 ? between(20 * DAY, 400 * DAY) : between(HOUR, 4 * DAY);
    const postedAt = new Date(Math.floor((savedAt - age) / 1000) * 1000);
    const id = inventedId(9, serial++);
    const lastLink = spec.text.match(/https:\/\/\S+/g)?.at(-1);
    const quoted: DemoPost["quoted"] = spec.quoteWithheld
      ? { withheldId: inventedId(9, serial++) }
      : spec.quote === undefined
        ? null
        : {
            id: inventedId(9, serial++),
            author: demoAuthor(spec.quote.by),
            text: spec.quote.text,
            lang: spec.lang ?? "en",
            postedAt: new Date(postedAt.getTime() - between(HOUR, 9 * DAY)),
            media: [...(spec.quote.media ?? [])],
            card: null,
            article: null,
            quoted: null,
            replyTo: null,
            counts: counts(),
          };
    if (quoted !== null && "postedAt" in quoted) {
      quoted.postedAt.setMilliseconds(0);
    }
    return {
      spec,
      savedAt: new Date(savedAt),
      post: {
        id,
        author: demoAuthor(spec.by),
        text: spec.text,
        lang: spec.lang ?? "en",
        postedAt,
        media: [...(spec.media ?? [])],
        card:
          spec.card === undefined || lastLink === undefined
            ? null
            : { url: lastLink, ...spec.card },
        article: spec.article ?? null,
        quoted,
        replyTo:
          spec.replyTo === undefined
            ? null
            : {
                postId: inventedId(9, serial++),
                handle: AUTHORS[spec.replyTo].handle,
              },
        counts: counts(),
      },
    };
  });
  const byKey = new Map(
    placed.flatMap((item) =>
      item.spec.key === undefined ? [] : [[item.spec.key, item] as const],
    ),
  );
  const keyed = (key: string): Placed => {
    const found = byKey.get(key);
    if (found === undefined)
      throw new Error(`No demo post has the key ${key}.`);
    return found;
  };

  // --- The captures -------------------------------------------------------
  let captures = 0;
  const capture = (
    operation: string,
    payload: string,
    receivedAt: number,
    requestBody?: string,
  ) => {
    captures += 1;
    insertRawCaptureOnce(store, {
      source: "x-web-client",
      operation,
      payload,
      requestBody,
      receivedAt: new Date(receivedAt),
      captureKey: `demo-${captures}`,
    });
  };
  const entryOf = ({ post, savedAt }: Placed): DemoEntry => ({
    kind: "post",
    post,
    sortIndex: sortIndexAt(savedAt, Math.floor(random() * 0xfffff)),
  });
  const mutation = (field: string, postId: string) =>
    [
      JSON.stringify({ data: { [field]: "Done" } }),
      JSON.stringify({ variables: { tweet_id: postId }, queryId: "demo" }),
    ] as const;

  // Three weeks ago the bookmarks page was open once: one page, which held
  // a post X has stopped sending since.
  const keptCopy = keyed(ROLES.keptCopy);
  const firstVisit = Math.max(
    keptCopy.savedAt.getTime() + HOUR,
    now.getTime() - 21 * DAY,
  );
  capture("Bookmarks", timelinePage([entryOf(keptCopy)]), firstVisit);

  // One bookmark was made in this browser while capturing: X's confirmation
  // of it is a capture of its own, and its time is exact.
  const observed = keyed(ROLES.observed);
  const [confirmed, asked] = mutation("tweet_bookmark_put", observed.post.id);
  // The confirmation arrives a moment after the bookmark is made.
  capture("CreateBookmark", confirmed, observed.savedAt.getTime() + 400, asked);

  // Today the whole list was scrolled through, newest first, twenty to a
  // page, and the page after the last one holds the two cursors alone.
  const neverHeld: DemoEntry[] = [0.31, 0.74].map((share) => ({
    kind: "withheld",
    postId: inventedId(9, serial++),
    sortIndex: sortIndexAt(
      new Date(archiveStart + (weekStart - archiveStart) * share),
      7,
    ),
    sent: "nothing",
  }));
  const timeline: DemoEntry[] = [
    ...placed.map((item) =>
      item === keptCopy
        ? ({
            kind: "withheld",
            postId: item.post.id,
            sortIndex: sortIndexAt(item.savedAt, 11),
            sent: "tombstone",
          } as const)
        : entryOf(item),
    ),
    ...neverHeld,
  ].toSorted((a, b) => (BigInt(a.sortIndex) < BigInt(b.sortIndex) ? 1 : -1));
  const pages = Math.ceil(timeline.length / PAGE_SIZE);
  const scrolledFrom = now.getTime() - 6 * MINUTE;
  for (let page = 0; page <= pages; page += 1) {
    capture(
      "Bookmarks",
      timelinePage(timeline.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)),
      scrolledFrom + page * 4000,
    );
  }

  // A minute ago one bookmark was removed in the browser.
  const removed = keyed(ROLES.removed);
  const [done, named] = mutation("tweet_bookmark_delete", removed.post.id);
  capture("DeleteBookmark", done, now.getTime() - MINUTE, named);

  parsePendingCaptures(store);

  // --- What each is filed under -------------------------------------------
  // The owner's own tags first, so that every answer below is given under
  // the vocabulary as it now stands.
  for (const tag of OWNER_TAGS) {
    addTag(store, tag, { now: new Date(now.getTime() - 9 * DAY) });
  }
  const classifiedAt = new Date(now.getTime() - 2 * MINUTE);
  for (const { spec, post } of placed) {
    recordClassification(store, {
      postId: post.id,
      category: spec.category,
      format: spec.format,
      tags: spec.tags,
      proposedTags: spec.proposed ?? [],
      tooLittleText: spec.tooLittleText === true,
      instructionsVersion: INSTRUCTIONS_VERSION,
      model: DEMO_CLASSIFIER,
      classifiedAt,
    });
  }
  for (const { key, correction } of CORRECTIONS) {
    correctBookmark(store, keyed(key).post.id, {
      ...correction,
      correctedAt: new Date(now.getTime() - MINUTE),
    });
  }

  // --- The sample digest --------------------------------------------------
  const inWeek = placed
    .filter(({ spec }) => spec.saved === "digest-week")
    .map(({ post }) => post.id);
  const idOf = (key: string) => keyed(key).post.id;
  const writtenAt = new Date(now.getTime() - MINUTE);
  const run = startDigestRun(store, {
    week: digestWeek,
    startedBy: "owner",
    model: DEMO_DIGEST_WRITER,
    instructionsVersion: 1,
    bookmarksInWeek: inWeek.length,
    postIds: inWeek,
    capUsd: 0.5,
    now: writtenAt,
  });
  finishDigestRun(store, run.id, {
    outcome: "written",
    text: {
      overview: DIGEST.overview,
      themes: DIGEST.themes.map(({ title, summary, posts }) => ({
        title,
        summary,
        postIds: posts.map(idOf),
      })),
      worthRevisiting: DIGEST.worthRevisiting.map(({ post, why }) => ({
        postId: idOf(post),
        why,
      })),
    },
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unansweredRequests: 0,
    now: writtenAt,
  });

  return {
    bookmarks: placed.length,
    neverHeld: neverHeld.length,
    captures,
    digestWeek,
    keyed: Object.fromEntries(
      [...byKey].map(([key, { post }]) => [key, post.id]),
    ),
  };
}
