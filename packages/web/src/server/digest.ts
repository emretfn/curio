/**
 * Every read the digest page makes. Like `library.ts` it holds no query of
 * its own: it asks core for a week's counts, its bookmarks, what the
 * classifier's answers suggest about the taxonomy and the digest written for
 * it, and turns the answers into what the page shows (READ-1).
 *
 * It reads and never writes, and it never asks for a digest to be written.
 * The written part is made by `pnpm digest`, which the owner starts; this
 * module does not load the package that does it, and shows what the library
 * holds: a digest, or the command that writes one.
 */
import type {
  Bookmark,
  Store,
  TagProposal,
  Week,
  WeekEntry,
  WeekSummary,
  WrittenDigest,
} from "@x-bookmarks/core";
import { type PostView, toItemView } from "../lib/post-view.ts";
import {
  excerpt,
  getBookmark,
  getDigest,
  listBookmarks,
  listTagProposals,
  listWeeks,
  MAX_PAGE_SIZE,
  MIN_DIGEST_BOOKMARKS,
  OTHER_CATEGORY,
  summariseWeek,
  weekAfter,
  weekBefore,
} from "./core.ts";

/** The most of a week's posts the page lists. The heaviest of the library's first 154 weeks held 37. */
export const WEEK_POSTS_SHOWN = 300;
/** How many tag proposals the page lists, and for how many bookmarks one must have been made to be among them. */
const PROPOSALS_SHOWN = 12;
const PROPOSAL_THRESHOLD = 2;
/** How many of a week's bookmarks that fitted no category the page names. */
const UNFITTED_SHOWN = 12;
/** How much of a post's text stands for it where the digest points at it. */
const REFERENCE_CHARACTERS = 110;

/**
 * A bookmark the digest points at: who wrote it and how it opens. Where the
 * post is in the page's own list, the reference leads to it there.
 */
export interface PostReference {
  id: string;
  author: string;
  /** The opening of its text, or of its headline when it has no text. */
  opening: string;
  /** Whether the post is listed on this page, under this id. */
  listed: boolean;
}

/** The summary of the week as written, with the bookmarks it points at resolved. */
export interface WrittenView {
  overview: string;
  themes: { title: string; summary: string; posts: PostReference[] }[];
  worthRevisiting: { post: PostReference; why: string }[];
  writtenAt: Date;
  model: string;
  /** How many bookmarks it was written from, and how many the week held then. */
  from: number;
  inWeekThen: number;
  /** Bookmarks made in the week since: the summary knows nothing of them. */
  savedSince: number;
}

/** A week in the list of weeks, with what it holds. */
export interface WeekLink {
  week: Week;
  bookmarks: number;
  written: boolean;
}

export interface DigestPage {
  week: Week;
  /** Whether the week has not ended yet. */
  running: boolean;
  /** The weeks either side. No week after one that has not begun. */
  previous: Week;
  next: Week | null;
  summary: WeekSummary;
  /** The week's bookmarks, newest first, `WEEK_POSTS_SHOWN` at most. */
  posts: { view: PostView; savedOn: Date }[];
  /** How many bookmarks are filed under a category. Zero before the classifier's first run. */
  classifiedInLibrary: number;
  suggestions: {
    /** The week's bookmarks that said enough and fitted no category. */
    unfitted: PostReference[];
    unfittedThisWeek: number;
    unfittedInLibrary: number;
    proposals: TagProposal[];
    /** Groups proposed for `PROPOSAL_THRESHOLD` bookmarks or more, and those proposed for fewer. */
    proposalsWaiting: number;
    proposedOnce: number;
  };
  written: WrittenView | null;
  /** Whether the week holds enough bookmarks for a summary to be written. */
  enoughForSummary: boolean;
  /** Every week that holds something, latest first. */
  weeks: WeekLink[];
}

function everyBookmarkOf(store: Store, week: Week): Bookmark[] {
  const bookmarks: Bookmark[] = [];
  let after: string | undefined;
  do {
    const page = listBookmarks(store, {
      bookmarkedSince: week.start,
      bookmarkedBefore: week.end,
      limit: MAX_PAGE_SIZE,
      after,
    });
    bookmarks.push(...page.bookmarks);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined && bookmarks.length < WEEK_POSTS_SHOWN);
  return bookmarks.slice(0, WEEK_POSTS_SHOWN);
}

const referenceTo = (bookmark: Bookmark, listed: boolean): PostReference => ({
  id: bookmark.postId,
  author: bookmark.authorName,
  opening: excerpt(
    (bookmark.text.trim() === ""
      ? (bookmark.article?.title ?? bookmark.card?.title ?? "")
      : bookmark.text
    ).replace(/\s+/g, " "),
    REFERENCE_CHARACTERS,
  ),
  listed,
});

/**
 * The digest as written, for the page. A bookmark it names is looked up in
 * the library by its id, which core checked against the run's own list when
 * the digest was stored; one the library no longer finds is left out. The
 * prose is passed on as it is stored, to be shown as text.
 */
function writtenView(
  store: Store,
  digest: WrittenDigest,
  listed: ReadonlyMap<string, Bookmark>,
  bookmarksNow: number,
): WrittenView {
  const reference = (postId: string): PostReference[] => {
    const here = listed.get(postId);
    if (here !== undefined) return [referenceTo(here, true)];
    // Removed on X since, or beyond what the page lists: still a bookmark.
    const elsewhere = getBookmark(store, postId);
    return elsewhere === undefined ? [] : [referenceTo(elsewhere, false)];
  };
  return {
    overview: digest.text.overview,
    themes: digest.text.themes.map((theme) => ({
      title: theme.title,
      summary: theme.summary,
      posts: theme.postIds.flatMap(reference),
    })),
    worthRevisiting: digest.text.worthRevisiting.flatMap(({ postId, why }) =>
      reference(postId).map((post) => ({ post, why })),
    ),
    writtenAt: digest.finishedAt,
    model: digest.model,
    from: digest.postIds.length,
    inWeekThen: digest.bookmarksInWeek,
    savedSince: Math.max(0, bookmarksNow - digest.bookmarksInWeek),
  };
}

/** Everything the digest page shows for a week. */
export function getDigestPage(store: Store, week: Week, now: Date): DigestPage {
  const summary = summariseWeek(store, week);
  const bookmarks = everyBookmarkOf(store, week);
  const listed = new Map(
    bookmarks.map((bookmark) => [bookmark.postId, bookmark]),
  );
  const unfitted = { category: OTHER_CATEGORY, tooLittleText: false } as const;
  const unfittedThisWeek = listBookmarks(store, {
    ...unfitted,
    bookmarkedSince: week.start,
    bookmarkedBefore: week.end,
    limit: UNFITTED_SHOWN,
  });
  const proposals = listTagProposals(store, {
    minBookmarks: PROPOSAL_THRESHOLD,
    limit: PROPOSALS_SHOWN,
  });
  const digest = getDigest(store, week.key);
  const next = weekAfter(week);
  return {
    week,
    running: now.getTime() < week.end.getTime(),
    previous: weekBefore(week),
    next: next.start.getTime() <= now.getTime() ? next : null,
    summary,
    posts: bookmarks.map((bookmark) => ({
      view: toItemView({ kind: "bookmark", bookmark }) as PostView,
      savedOn: bookmark.bookmarkedAt,
    })),
    classifiedInLibrary: listBookmarks(store, {
      classified: true,
      includeRemoved: true,
      limit: 1,
    }).total,
    suggestions: {
      unfitted: unfittedThisWeek.bookmarks.map((bookmark) =>
        referenceTo(bookmark, listed.has(bookmark.postId)),
      ),
      unfittedThisWeek: unfittedThisWeek.total,
      unfittedInLibrary: listBookmarks(store, { ...unfitted, limit: 1 }).total,
      proposals: proposals.proposals,
      proposalsWaiting: proposals.total,
      proposedOnce: proposals.belowThreshold,
    },
    written:
      digest === undefined
        ? null
        : writtenView(store, digest, listed, summary.bookmarks),
    enoughForSummary: summary.bookmarks >= MIN_DIGEST_BOOKMARKS,
    weeks: listWeeks(store).map(
      ({ week: listedWeek, bookmarks: count, written }: WeekEntry) => ({
        week: listedWeek,
        bookmarks: count,
        written,
      }),
    ),
  };
}
