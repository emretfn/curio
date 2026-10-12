import { connectionOf, type Store } from "./store.ts";

/** One sighting of a bookmarked post inside a stored raw capture. */
export interface BookmarkSighting {
  /** X's numeric post id, as a decimal string. */
  postId: string;
  /** X's numeric user id of the post's author, as a decimal string. */
  authorId: string;
  /** The full post text. */
  text: string;
  /** When the post was written. This is not when it was bookmarked. */
  postedAt: Date;
  /** The raw capture this sighting was parsed from. */
  captureId: number;
}

export interface Bookmark {
  postId: string;
  authorId: string;
  text: string;
  postedAt: Date;
  /**
   * When the capture that first contained this bookmark was received. X gives
   * no "bookmarked at" time, so this is what "added this week" is built on.
   */
  firstSeenAt: Date;
  firstSeenCaptureId: number;
  lastSeenAt: Date;
  lastSeenCaptureId: number;
}

interface BookmarkRow {
  postId: string;
  authorId: string;
  text: string;
  postedAt: number;
  firstSeenAt: number;
  firstSeenCaptureId: number;
  lastSeenAt: number;
  lastSeenCaptureId: number;
}

/**
 * Records that a bookmark was seen in a capture and returns the stored
 * bookmark.
 *
 * There is no way to pass a first-seen time. On first insert it is copied from
 * the capture's `receivedAt`, so re-parsing an old capture dates the bookmark
 * to when it was captured, not to when the parser ran. On later sightings it
 * is left alone. The post's content and last-seen time follow the most
 * recently received capture, so replaying an older capture changes nothing.
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
    db.prepare(
      `INSERT INTO bookmarks (
         post_id, author_id, text, posted_at,
         first_seen_at, first_seen_capture_id, last_seen_at, last_seen_capture_id
       )
       VALUES (@postId, @authorId, @text, @postedAt, @seenAt, @captureId, @seenAt, @captureId)
       ON CONFLICT (post_id) DO UPDATE SET
         author_id = excluded.author_id,
         text = excluded.text,
         posted_at = excluded.posted_at,
         last_seen_at = excluded.last_seen_at,
         last_seen_capture_id = excluded.last_seen_capture_id
       WHERE excluded.last_seen_at >= bookmarks.last_seen_at`,
    ).run({
      postId: sighting.postId,
      authorId: sighting.authorId,
      text: sighting.text,
      postedAt: sighting.postedAt.getTime(),
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
      `SELECT post_id AS postId, author_id AS authorId, text, posted_at AS postedAt,
              first_seen_at AS firstSeenAt, first_seen_capture_id AS firstSeenCaptureId,
              last_seen_at AS lastSeenAt, last_seen_capture_id AS lastSeenCaptureId
       FROM bookmarks WHERE post_id = ?`,
    )
    .get(postId);
  return (
    row && {
      ...row,
      postedAt: new Date(row.postedAt),
      firstSeenAt: new Date(row.firstSeenAt),
      lastSeenAt: new Date(row.lastSeenAt),
    }
  );
}
