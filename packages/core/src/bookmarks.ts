import type {
  PostArticle,
  PostCard,
  PostContent,
  PostLink,
  PostMedia,
  QuotedPost,
} from "./post.ts";
import { connectionOf, type Store } from "./store.ts";

/** What every sighting must say about its post. The rest of `PostContent` is optional. */
type Essential =
  | "postId"
  | "authorId"
  | "authorHandle"
  | "authorName"
  | "text"
  | "postedAt";

/**
 * One sighting of a bookmarked post inside a stored raw capture. What a
 * source does not provide is left out and stored as empty.
 */
export type BookmarkSighting = Pick<PostContent, Essential> &
  Partial<Omit<PostContent, Essential>> & {
    /** The post this one quotes, when it quotes one. */
    quoted?: QuotedPost | null;
    /**
     * The bookmarks timeline's ordering value for this entry, as a decimal
     * string. `estimatedBookmarkedAt` is derived from it.
     */
    sortIndex?: string | null;
    /** The raw capture this sighting was parsed from. */
    captureId: number;
  };

export interface Bookmark extends PostContent {
  quoted: QuotedPost | null;
  sortIndex: string | null;
  /**
   * An estimate of when the bookmark was made, read out of `sortIndex`. Null
   * when there is no `sortIndex` or it does not hold a believable time. It is
   * X's value, not a promise, and is never written into `firstSeenAt`. For
   * "when was this bookmarked", read `bookmarkedAt`.
   */
  estimatedBookmarkedAt: Date | null;
  /**
   * When X confirmed the bookmark being made, for a bookmark made in the
   * browser while the extension was capturing: the time the latest
   * `CreateBookmark` response for this post was received. Null for every
   * bookmark made anywhere else, which is most of them.
   */
  observedBookmarkedAt: Date | null;
  /**
   * When the bookmark was made, as well as the library knows: the later of
   * `observedBookmarkedAt` and `estimatedBookmarkedAt`, or `firstSeenAt` when
   * there is neither. The later of the two, because a post bookmarked again
   * has two bookmark times and the current bookmark is the newer. This is the
   * time that lists are ordered by and time ranges are taken over.
   */
  bookmarkedAt: Date;
  /**
   * When the bookmark was removed on X, as far as the captures show: the time
   * X confirmed a `DeleteBookmark` for this post, unless it was bookmarked
   * again or seen in the bookmarks timeline after that. Null for a bookmark
   * that is still one. A removed bookmark stays in the library; queries leave
   * it out unless asked to include it.
   */
  removedOnXAt: Date | null;
  /**
   * When a capture last found X withholding this post, later than every
   * capture that still held it: the post was deleted, or its author's account
   * is now protected or suspended. Null while X still sends the post. The
   * library keeps the copy it captured before, and nothing asks X for more.
   */
  withheldOnXAt: Date | null;
  /**
   * When the capture that first contained this bookmark was received. This is
   * when the bookmark entered the library, which for a backfill is the day of
   * the backfill and not the day it was bookmarked.
   */
  firstSeenAt: Date;
  firstSeenCaptureId: number;
  lastSeenAt: Date;
  lastSeenCaptureId: number;
}

/**
 * How far ahead of the capture's clock a bookmark time may be. The capture is
 * timed by the browser's clock and `sortIndex` by X's.
 */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The time a bookmarks-timeline `sortIndex` encodes: its bits above the low
 * twenty, read as Unix epoch milliseconds. On the first real captures this
 * fell after the post's own time and before the capture for every one of 300
 * bookmarks, in timeline order; read as a snowflake id, as other tools have
 * tried, it fell before the post for all 300.
 *
 * Returns null unless the result lies between when the post was written and
 * when the capture was received, which is where a true bookmark time must be.
 */
export function estimateBookmarkedAt(
  sortIndex: string,
  postedAt: Date,
  receivedAt: Date,
): Date | null {
  if (!/^[0-9]{1,19}$/.test(sortIndex)) return null;
  const estimate = Number(BigInt(sortIndex) >> 20n);
  return estimate >= postedAt.getTime() &&
    estimate <= receivedAt.getTime() + CLOCK_TOLERANCE_MS
    ? new Date(estimate)
    : null;
}

export interface BookmarkRow {
  postId: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarUrl: string | null;
  authorVerified: number;
  text: string;
  postedAt: number;
  lang: string | null;
  conversationId: string | null;
  inReplyToPostId: string | null;
  inReplyToHandle: string | null;
  media: string;
  links: string;
  card: string | null;
  article: string | null;
  quoted: string | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  quoteCount: number | null;
  bookmarkCount: number | null;
  viewCount: number | null;
  sortIndex: string | null;
  estimatedBookmarkedAt: number | null;
  observedBookmarkedAt: number | null;
  bookmarkedAt: number;
  removedOnXAt: number | null;
  withheldOnXAt: number | null;
  firstSeenAt: number;
  firstSeenCaptureId: number;
  lastSeenAt: number;
  lastSeenCaptureId: number;
}

/** Column and the row field it is read into, for every column a sighting sets. */
const CONTENT_COLUMNS = [
  ["author_id", "authorId"],
  ["author_handle", "authorHandle"],
  ["author_name", "authorName"],
  ["author_avatar_url", "authorAvatarUrl"],
  ["author_verified", "authorVerified"],
  ["text", "text"],
  ["posted_at", "postedAt"],
  ["lang", "lang"],
  ["conversation_id", "conversationId"],
  ["in_reply_to_post_id", "inReplyToPostId"],
  ["in_reply_to_handle", "inReplyToHandle"],
  ["media", "media"],
  ["links", "links"],
  ["card", "card"],
  ["article", "article"],
  ["quoted", "quoted"],
  ["like_count", "likeCount"],
  ["repost_count", "repostCount"],
  ["reply_count", "replyCount"],
  ["quote_count", "quoteCount"],
  ["bookmark_count", "bookmarkCount"],
  ["view_count", "viewCount"],
  ["sort_index", "sortIndex"],
  ["estimated_bookmarked_at", "estimatedBookmarkedAt"],
] as const satisfies readonly (readonly [string, keyof BookmarkRow])[];

/**
 * Package-internal: the bookmark time of a row of `bookmarks b` joined to its
 * `bookmark_mutations m`. See `Bookmark.bookmarkedAt`.
 */
export const BOOKMARKED_AT = `coalesce(
    max(m.bookmarked_at, b.estimated_bookmarked_at),
    m.bookmarked_at, b.estimated_bookmarked_at, b.first_seen_at)`;

/**
 * Package-internal: when the bookmark of such a row was removed on X, or
 * null. A removal stands only while nothing later shows the post bookmarked:
 * no `CreateBookmark`, and no page of the timeline that lists it.
 */
export const REMOVED_ON_X_AT = `CASE
    WHEN m.removed_at > max(b.last_seen_at, coalesce(m.bookmarked_at, 0))
    THEN m.removed_at END`;

/**
 * Package-internal: when a capture last found X withholding the post of a
 * row of `bookmarks b`, or null. Like a removal, it is read and never stored,
 * and it stands only while no later capture holds the post again.
 */
export const WITHHELD_ON_X_AT = `(
    SELECT max(c.received_at)
    FROM parse_issues i
    JOIN raw_captures c ON c.id = i.capture_id
    WHERE i.kind = 'post-unavailable' AND i.post_id = b.post_id
      AND c.received_at > b.last_seen_at)`;

/** Package-internal: the columns of a `BookmarkRow`, for `bookmarkFromRow`, read from `FROM_BOOKMARKS`. */
export const SELECT_BOOKMARK_COLUMNS = `
  SELECT b.post_id AS postId,
         ${CONTENT_COLUMNS.map(([column, name]) => `b.${column} AS ${name}`).join(", ")},
         m.bookmarked_at AS observedBookmarkedAt,
         ${BOOKMARKED_AT} AS bookmarkedAt,
         ${REMOVED_ON_X_AT} AS removedOnXAt,
         ${WITHHELD_ON_X_AT} AS withheldOnXAt,
         b.first_seen_at AS firstSeenAt, b.first_seen_capture_id AS firstSeenCaptureId,
         b.last_seen_at AS lastSeenAt, b.last_seen_capture_id AS lastSeenCaptureId`;

/** Package-internal: every bookmark as `b`, with what the mutations say about its post as `m`. */
export const FROM_BOOKMARKS = `
  FROM bookmarks b
  LEFT JOIN bookmark_mutations m ON m.post_id = b.post_id`;

const UPSERT_BOOKMARK = `
  INSERT INTO bookmarks (
    post_id, ${CONTENT_COLUMNS.map(([column]) => column).join(", ")},
    first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
  )
  VALUES (
    @postId, ${CONTENT_COLUMNS.map(([, name]) => `@${name}`).join(", ")},
    @seenAt, @captureId, @seenAt, @captureId
  )
  ON CONFLICT (post_id) DO UPDATE SET
    ${CONTENT_COLUMNS.map(([column]) => `${column} = excluded.${column}`).join(", ")},
    last_seen_at = excluded.last_seen_at,
    last_seen_capture_id = excluded.last_seen_capture_id
  WHERE excluded.last_seen_at >= bookmarks.last_seen_at`;

/** A quoted post as stored: its time in epoch milliseconds, like every other time. */
type StoredQuotedPost =
  | (Omit<Extract<QuotedPost, { available: true }>, "postedAt"> & {
      postedAt: number;
    })
  | Extract<QuotedPost, { available: false }>;

function storeQuoted(quoted: QuotedPost | null | undefined): string | null {
  if (quoted === null || quoted === undefined) return null;
  const stored: StoredQuotedPost = quoted.available
    ? { ...quoted, postedAt: quoted.postedAt.getTime() }
    : quoted;
  return JSON.stringify(stored);
}

function loadQuoted(stored: string | null): QuotedPost | null {
  if (stored === null) return null;
  const quoted = JSON.parse(stored) as StoredQuotedPost;
  return quoted.available
    ? { ...quoted, postedAt: new Date(quoted.postedAt) }
    : quoted;
}

/** Package-internal: a row of `SELECT_BOOKMARK_COLUMNS` as a `Bookmark`. */
export function bookmarkFromRow(row: BookmarkRow): Bookmark {
  return {
    ...row,
    authorVerified: row.authorVerified === 1,
    postedAt: new Date(row.postedAt),
    media: JSON.parse(row.media) as PostMedia[],
    links: JSON.parse(row.links) as PostLink[],
    card: row.card === null ? null : (JSON.parse(row.card) as PostCard),
    article:
      row.article === null ? null : (JSON.parse(row.article) as PostArticle),
    quoted: loadQuoted(row.quoted),
    estimatedBookmarkedAt:
      row.estimatedBookmarkedAt === null
        ? null
        : new Date(row.estimatedBookmarkedAt),
    observedBookmarkedAt:
      row.observedBookmarkedAt === null
        ? null
        : new Date(row.observedBookmarkedAt),
    bookmarkedAt: new Date(row.bookmarkedAt),
    removedOnXAt: row.removedOnXAt === null ? null : new Date(row.removedOnXAt),
    withheldOnXAt:
      row.withheldOnXAt === null ? null : new Date(row.withheldOnXAt),
    firstSeenAt: new Date(row.firstSeenAt),
    lastSeenAt: new Date(row.lastSeenAt),
  };
}

/**
 * Records that a bookmark was seen in a capture and returns the stored
 * bookmark.
 *
 * There is no way to pass a first-seen time. On first insert it is copied from
 * the capture's `receivedAt`, so re-parsing an old capture dates the bookmark
 * to when it was captured, not to when the parser ran. On later sightings it
 * is left alone. The post's content and last-seen time follow the most
 * recently received capture, so replaying an older capture changes nothing,
 * and replaying every capture oldest first brings every bookmark up to date.
 */
export function upsertBookmark(
  store: Store,
  sighting: BookmarkSighting,
): Bookmark {
  const db = connectionOf(store);
  const upsert = db.transaction((): Bookmark => {
    const capture = db
      .prepare<[number], { receivedAt: number }>(
        "SELECT received_at AS receivedAt FROM raw_captures WHERE id = ?",
      )
      .get(sighting.captureId);
    if (capture === undefined) {
      throw new Error(
        `Raw capture ${sighting.captureId} does not exist. Store the response with insertRawCapture() before upserting the bookmarks parsed from it.`,
      );
    }
    const sortIndex = sighting.sortIndex ?? null;
    const estimate =
      sortIndex === null
        ? null
        : estimateBookmarkedAt(
            sortIndex,
            sighting.postedAt,
            new Date(capture.receivedAt),
          );
    const row: Pick<
      BookmarkRow,
      "postId" | (typeof CONTENT_COLUMNS)[number][1]
    > = {
      postId: sighting.postId,
      authorId: sighting.authorId,
      authorHandle: sighting.authorHandle,
      authorName: sighting.authorName,
      authorAvatarUrl: sighting.authorAvatarUrl ?? null,
      authorVerified: sighting.authorVerified === true ? 1 : 0,
      text: sighting.text,
      postedAt: sighting.postedAt.getTime(),
      lang: sighting.lang ?? null,
      conversationId: sighting.conversationId ?? null,
      inReplyToPostId: sighting.inReplyToPostId ?? null,
      inReplyToHandle: sighting.inReplyToHandle ?? null,
      media: JSON.stringify(sighting.media ?? []),
      links: JSON.stringify(sighting.links ?? []),
      card: sighting.card ? JSON.stringify(sighting.card) : null,
      article: sighting.article ? JSON.stringify(sighting.article) : null,
      quoted: storeQuoted(sighting.quoted),
      likeCount: sighting.likeCount ?? null,
      repostCount: sighting.repostCount ?? null,
      replyCount: sighting.replyCount ?? null,
      quoteCount: sighting.quoteCount ?? null,
      bookmarkCount: sighting.bookmarkCount ?? null,
      viewCount: sighting.viewCount ?? null,
      sortIndex,
      estimatedBookmarkedAt: estimate?.getTime() ?? null,
    };
    db.prepare(UPSERT_BOOKMARK).run({
      ...row,
      seenAt: capture.receivedAt,
      captureId: sighting.captureId,
    });
    const stored = getBookmark(store, sighting.postId);
    if (stored === undefined) {
      throw new Error(`Bookmark ${sighting.postId} is missing after upsert.`);
    }
    return stored;
  });
  return upsert.immediate();
}

export function getBookmark(
  store: Store,
  postId: string,
): Bookmark | undefined {
  const row = connectionOf(store)
    .prepare<[string], BookmarkRow>(
      `${SELECT_BOOKMARK_COLUMNS} ${FROM_BOOKMARKS} WHERE b.post_id = ?`,
    )
    .get(postId);
  return row && bookmarkFromRow(row);
}
