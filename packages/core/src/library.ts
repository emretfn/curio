/**
 * Reading the library: the one set of queries that the MCP server, the
 * library UI, tagging and the weekly digest are all built on.
 *
 * Every query leaves out bookmarks that were removed on X unless asked to
 * include them, and takes "when" to mean the bookmark time, `bookmarkedAt`.
 * One bookmark by its id is `getBookmark`.
 *
 * A bookmark's category, format and tags are filters like any other, and
 * are counted like any other. What a bookmark is filed under is the owner's
 * word where there is one and the classifier's otherwise: `labels.ts` writes
 * both, `taxonomy.ts` holds the categories and formats there are, and
 * `vocabulary.ts` the tags.
 *
 * `searchBookmarks` and `listBookmarks` return bookmarks; `summariseMatches`
 * counts what the same options match, for the numbers beside a screen's
 * filters; `summariseLibrary` counts the library as a whole; and
 * `listWithheldPosts` names the bookmarks whose post X no longer sends,
 * those the library never held among them.
 */
import {
  BOOKMARKED_AT,
  type Bookmark,
  type BookmarkRow,
  bookmarkFromRow,
  CATEGORY,
  FORMAT,
  FROM_BOOKMARKS,
  REMOVED_ON_X_AT,
  SELECT_BOOKMARK_COLUMNS,
  TOO_LITTLE_TEXT,
  WITHHELD_ON_X_AT,
} from "./bookmarks.ts";
import { categoryOf, formatOf } from "./labels.ts";
import { excerpt, parseSearchQuery, type SearchMatch } from "./search-text.ts";
import { connectionOf, type Store } from "./store.ts";
import { foldTagText, OTHER_CATEGORY } from "./taxonomy.ts";
import { tagOf } from "./vocabulary.ts";

/** Which bookmarks a query looks at. Every part is optional, and all given parts must hold. */
export interface BookmarkFilter {
  /** Bookmarks of posts by this author, by handle, with or without the `@`, in any case. */
  author?: string | undefined;
  /**
   * Bookmarks of posts by this account, by X's numeric id for it. An account
   * keeps its id when it changes its handle, so this finds an author's
   * bookmarks under every name they were seen with.
   */
  authorId?: string | undefined;
  /** Only bookmarks with a photo, video or GIF attached, or only those without. */
  hasMedia?: boolean | undefined;
  /** Only bookmarks with a video or a GIF attached, or only those without. */
  hasVideo?: boolean | undefined;
  /** Only bookmarks whose text holds a link, or only those without. */
  hasLink?: boolean | undefined;
  /** Only bookmarks of a post with an X Article, or only those without. */
  hasArticle?: boolean | undefined;
  /** Only bookmarks of a post that quotes another, or only those that quote none. */
  hasQuote?: boolean | undefined;
  /** Only posts longer than `LONG_POST_CHARACTERS`, or only those that are not. */
  isLong?: boolean | undefined;
  /** Bookmarks in this language, by X's code for it, such as `en` or `tr`. */
  lang?: string | undefined;
  /**
   * Bookmarks in none of these languages, by X's codes. Those X named no
   * language for are among them: this is "everything else".
   */
  langNot?: readonly string[] | undefined;
  /** Bookmarked at this moment or later. */
  bookmarkedSince?: Date | undefined;
  /** Bookmarked before this moment. */
  bookmarkedBefore?: Date | undefined;
  /** Also bookmarks that were removed on X, which are left out otherwise. */
  includeRemoved?: boolean | undefined;
  /** Only bookmarks that were removed on X. */
  onlyRemoved?: boolean | undefined;
  /**
   * Only bookmarks whose post X now withholds, of which the library keeps
   * the copy it captured earlier. A withheld post the library never held is
   * no bookmark and is in no list of them: see `listWithheldPosts`.
   */
  onlyWithheld?: boolean | undefined;
  /**
   * Bookmarks filed under this category, by its id in `TAXONOMY`, such as
   * `web-dev`. The owner's correction counts before the classifier's answer.
   * An id the taxonomy does not hold is refused with a `RangeError`.
   */
  category?: string | undefined;
  /** Bookmarks of this format, by its id in `TAXONOMY`, such as `guide`. */
  format?: string | undefined;
  /**
   * Bookmarks that have every one of these tags. A tag may be written as
   * one of its aliases, in any case, with or without accents: "reklam"
   * finds `ads`. A text that is no tag of the vocabulary as it stands is
   * refused with a `RangeError`.
   */
  tags?: readonly string[] | undefined;
  /**
   * Only bookmarks that are filed under a category, or only those that are
   * not yet: neither classified nor filed by the owner.
   */
  classified?: boolean | undefined;
  /**
   * Only bookmarks filed under "other" because the classifier found the
   * stored text too little to tell, or only the rest. With `category`
   * "other" and this false, what is left is the other kind of "other": text
   * enough, and no category that fits, which is what says a category is
   * missing.
   */
  tooLittleText?: boolean | undefined;
  /**
   * Bookmarks for which the classifier proposed this tag, a tag the
   * vocabulary does not hold. The proposal is on none of them as a tag;
   * these are the bookmarks that would get it if it became one.
   */
  proposedTag?: string | undefined;
}

/**
 * A post longer than this many characters is long-form: more than a classic
 * post could hold. Characters are counted as SQLite counts them, by code
 * point.
 */
export const LONG_POST_CHARACTERS = 280;

/** Which stretch of the matching bookmarks to return. */
export interface PageOptions {
  /** How many to return: 1 to `MAX_PAGE_SIZE`. Defaults to `DEFAULT_PAGE_SIZE`. */
  limit?: number | undefined;
  /** How many to pass over first. Defaults to 0. */
  offset?: number | undefined;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface ListOptions extends BookmarkFilter, PageOptions {
  /** By bookmark time: most recently bookmarked first, which is the default, or the reverse. */
  order?: "newest" | "oldest" | undefined;
  /**
   * Continue after the last bookmark of an earlier page: that page's
   * `nextCursor`, with the same `order`. Unlike an `offset`, it keeps its
   * place when bookmarks arrive between one page and the next, so a list
   * read a page at a time while captures come in repeats and skips nothing.
   */
  after?: string | undefined;
}

export interface BookmarkList {
  /** How many bookmarks match, of which `bookmarks` is one page. */
  total: number;
  bookmarks: Bookmark[];
  /** Pass as `after` for the bookmarks that follow these. Null when none do. */
  nextCursor: string | null;
}

export interface SearchOptions extends BookmarkFilter, PageOptions {
  /**
   * What to search for, as typed: words, and phrases in double quotes. How
   * it is read is said at `parseSearchQuery` in `search-text.ts`.
   */
  query: string;
  /** Whether a bookmark must hold every word (`all`, the default) or any of them. */
  match?: SearchMatch | undefined;
  /** The longest excerpt to return, in characters. Defaults to 320. */
  excerptLength?: number | undefined;
}

export interface SearchHit {
  bookmark: Bookmark;
  /**
   * The post's text, or for a long post the part of it around the first
   * word that matched. It opens the text when the match is elsewhere, in
   * the author's name or a quoted post.
   */
  excerpt: string;
}

export interface SearchResult {
  /** How many bookmarks match, of which `hits` is one page. */
  total: number;
  /** Best match first. */
  hits: SearchHit[];
  /**
   * The words and phrases that were searched for, folded as the index folds
   * them. Empty when the query held nothing to search for, in which case
   * nothing matches.
   */
  terms: string[];
}

const DEFAULT_EXCERPT_LENGTH = 320;

/**
 * How much a word counts by where it was found, in the order of the index's
 * columns: text, author, title, quoted, detail. A word in a headline or in
 * the author's name says more about a bookmark than one in passing in its
 * text, and one in the quoted post or a card's description says less.
 */
const COLUMN_WEIGHTS = [1, 2, 2.5, 0.6, 0.5];

type Parameters = Record<string, string | number>;

/** A place in a list: the bookmark time and the row of the last bookmark before it. */
const CURSOR = /^([0-9]{1,15}):([0-9]{1,15})$/;

/**
 * What a bookmark can have, as a condition on its row `b`. One place, so
 * that a filter and the count beside it can never mean different things.
 */
const HAS = {
  media: "(json_array_length(b.media) > 0)",
  video: `(EXISTS (
    SELECT 1 FROM json_each(b.media) AS item
    WHERE item.value ->> '$.type' <> 'photo'))`,
  link: "(json_array_length(b.links) > 0)",
  article: "(b.article IS NOT NULL)",
  quote: "(b.quoted IS NOT NULL)",
  long: `(length(b.text) > ${LONG_POST_CHARACTERS})`,
} as const;

/** Whether X now withholds the post of a row `b`, for the filter and for the count beside it. */
const IS_WITHHELD = `(${WITHHELD_ON_X_AT} IS NOT NULL)`;

type Connection = ReturnType<typeof connectionOf>;

/** Whether a row `b` has the tag bound to `name`, for the filter and for the counts beside it. */
const hasTag = (name: string) => `EXISTS (
    SELECT 1 FROM bookmark_effective_tags
    WHERE post_id = b.post_id AND tag = ${name})`;

function conditionsOf(
  db: Connection,
  filter: BookmarkFilter,
): {
  conditions: string[];
  parameters: Parameters;
} {
  const conditions: string[] = [];
  const parameters: Parameters = {};
  if (filter.author !== undefined) {
    conditions.push("b.author_handle = @author COLLATE NOCASE");
    parameters.author = filter.author.trim().replace(/^@/, "");
  }
  if (filter.authorId !== undefined) {
    conditions.push("b.author_id = @authorId");
    parameters.authorId = filter.authorId.trim();
  }
  for (const [wanted, has] of [
    [filter.hasMedia, HAS.media],
    [filter.hasVideo, HAS.video],
    [filter.hasLink, HAS.link],
    [filter.hasArticle, HAS.article],
    [filter.hasQuote, HAS.quote],
    [filter.isLong, HAS.long],
  ] as const) {
    if (wanted !== undefined) conditions.push(wanted ? has : `NOT ${has}`);
  }
  if (filter.lang !== undefined) {
    conditions.push("b.lang = @lang");
    parameters.lang = filter.lang.trim().toLowerCase();
  }
  if (filter.langNot !== undefined && filter.langNot.length > 0) {
    const names = filter.langNot.map((lang, index) => {
      parameters[`langNot${index}`] = lang.trim().toLowerCase();
      return `@langNot${index}`;
    });
    conditions.push(`(b.lang IS NULL OR b.lang NOT IN (${names.join(", ")}))`);
  }
  if (filter.bookmarkedSince !== undefined) {
    conditions.push(`${BOOKMARKED_AT} >= @since`);
    parameters.since = timeOf(filter.bookmarkedSince, "bookmarkedSince");
  }
  if (filter.bookmarkedBefore !== undefined) {
    conditions.push(`${BOOKMARKED_AT} < @before`);
    parameters.before = timeOf(filter.bookmarkedBefore, "bookmarkedBefore");
  }
  if (filter.onlyRemoved === true) {
    conditions.push(`${REMOVED_ON_X_AT} IS NOT NULL`);
  } else if (filter.includeRemoved !== true) {
    conditions.push(`${REMOVED_ON_X_AT} IS NULL`);
  }
  if (filter.onlyWithheld === true) conditions.push(IS_WITHHELD);
  if (filter.category !== undefined) {
    conditions.push(`${CATEGORY} = @category`);
    parameters.category = categoryOf(filter.category);
  }
  if (filter.format !== undefined) {
    conditions.push(`${FORMAT} = @format`);
    parameters.format = formatOf(filter.format);
  }
  // A tag given twice, or under two of its names, is one condition.
  const tags = new Set((filter.tags ?? []).map((tag) => tagOf(db, tag)));
  [...tags].forEach((tag, index) => {
    conditions.push(hasTag(`@tag${index}`));
    parameters[`tag${index}`] = tag;
  });
  if (filter.tooLittleText !== undefined) {
    conditions.push(
      filter.tooLittleText ? TOO_LITTLE_TEXT : `NOT ${TOO_LITTLE_TEXT}`,
    );
  }
  if (filter.proposedTag !== undefined) {
    conditions.push(`EXISTS (
      SELECT 1 FROM json_each(cl.proposed_tags) WHERE value = @proposedTag)`);
    parameters.proposedTag = foldTagText(filter.proposedTag);
  }
  if (filter.classified !== undefined) {
    conditions.push(
      `${CATEGORY} IS ${filter.classified ? "NOT NULL" : "NULL"}`,
    );
  }
  return { conditions, parameters };
}

function timeOf(date: Date, name: string): number {
  const time = date.getTime();
  if (Number.isNaN(time)) throw new RangeError(`${name} is not a valid date.`);
  return time;
}

function pageOf({ limit = DEFAULT_PAGE_SIZE, offset = 0 }: PageOptions): {
  limit: number;
  offset: number;
} {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(
      `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}; got ${limit}.`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(
      `offset must be a whole number, zero or above; got ${offset}.`,
    );
  }
  return { limit, offset };
}

const where = (conditions: readonly string[]) =>
  conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;

/**
 * The bookmarks a filter lets through, a page at a time, in the order they
 * were bookmarked. "What did I save this week" is this, with
 * `bookmarkedSince`.
 */
export function listBookmarks(
  store: Store,
  options: ListOptions = {},
): BookmarkList {
  const db = connectionOf(store);
  const { conditions, parameters } = conditionsOf(db, options);
  const direction = options.order === "oldest" ? "ASC" : "DESC";
  const page = pageOf(options);
  const total = db
    .prepare<Parameters, number>(
      `SELECT count(*) ${FROM_BOOKMARKS} ${where(conditions)}`,
    )
    .pluck()
    .get(parameters);
  const from = [...conditions];
  const place: Parameters = {};
  if (options.after !== undefined) {
    const [, time, row] = CURSOR.exec(options.after) ?? [];
    if (time === undefined || row === undefined) {
      throw new RangeError(
        "after must be the nextCursor of an earlier page of the list.",
      );
    }
    from.push(
      `(${BOOKMARKED_AT}, b.id) ${direction === "DESC" ? "<" : ">"} (@afterTime, @afterRow)`,
    );
    place.afterTime = Number(time);
    place.afterRow = Number(row);
  }
  // One more than the page, to know whether anything follows it.
  const rows = db
    .prepare<Parameters, BookmarkRow & { rowId: number }>(
      `${SELECT_BOOKMARK_COLUMNS}, b.id AS rowId
       ${FROM_BOOKMARKS} ${where(from)}
       ORDER BY bookmarkedAt ${direction}, b.id ${direction}
       LIMIT @limit + 1 OFFSET @offset`,
    )
    .all({ ...parameters, ...place, ...page });
  const shown = rows.slice(0, page.limit);
  const last = shown.at(-1);
  return {
    total: total ?? 0,
    bookmarks: shown.map(({ rowId, ...row }) => bookmarkFromRow(row)),
    nextCursor:
      rows.length > page.limit && last !== undefined
        ? `${last.bookmarkedAt}:${last.rowId}`
        : null,
  };
}

/**
 * Keyword search over everything a bookmark can be found by: the post's
 * text, its author, the post it quotes, the titles and descriptions of its
 * link card and its X Article, and the descriptions of its media.
 *
 * Results are ranked by BM25 with the weights above, so a rare word counts
 * for more than a common one and a short post that is about the word ranks
 * above a long one that mentions it; ties go to the more recent bookmark.
 */
export function searchBookmarks(
  store: Store,
  options: SearchOptions,
): SearchResult {
  const { terms, expression } = parseSearchQuery(options.query, options.match);
  const page = pageOf(options);
  const excerptLength = options.excerptLength ?? DEFAULT_EXCERPT_LENGTH;
  if (!Number.isInteger(excerptLength) || excerptLength < 1) {
    throw new RangeError(
      `excerptLength must be a whole number above zero; got ${excerptLength}.`,
    );
  }
  const db = connectionOf(store);
  const filter = conditionsOf(db, options);
  if (expression === null) return { total: 0, hits: [], terms };

  const conditions = [
    "bookmark_search MATCH @expression",
    ...filter.conditions,
  ];
  const parameters = { ...filter.parameters, expression };
  const joined = `${FROM_BOOKMARKS}
    JOIN bookmark_search ON bookmark_search.rowid = b.id`;
  const total = db
    .prepare<Parameters, number>(
      `SELECT count(*) ${joined} ${where(conditions)}`,
    )
    .pluck()
    .get(parameters);
  const rows = db
    .prepare<Parameters, BookmarkRow>(
      `${SELECT_BOOKMARK_COLUMNS} ${joined}
       ${where(conditions)}
       ORDER BY bm25(bookmark_search, ${COLUMN_WEIGHTS.join(", ")}),
                bookmarkedAt DESC, b.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...parameters, ...page });
  return {
    total: total ?? 0,
    hits: rows.map((row) => {
      const bookmark = bookmarkFromRow(row);
      return {
        bookmark,
        excerpt: excerpt(bookmark.text, excerptLength, terms),
      };
    }),
    terms,
  };
}

/** What to count: a filter, and optionally a search within it. */
export interface MatchOptions extends BookmarkFilter {
  /**
   * A search, read as `searchBookmarks` reads it. Left out, every bookmark
   * the filter lets through is counted; given with nothing in it to search
   * for, nothing is, as nothing would be found.
   */
  query?: string | undefined;
  match?: SearchMatch | undefined;
}

/**
 * How many bookmarks a search or a list with the same options finds, and
 * how many each further filter would leave: the numbers a screen shows
 * beside its filters.
 *
 * A count for a kind of content is taken among the matches, so it is what
 * adding that filter leaves. Languages and years are taken with the
 * options' own language or time range set aside, so that the other
 * languages and years stay on offer while one is chosen. `removedOnX` is
 * taken with the options' own choice about removed bookmarks set aside.
 */
export interface MatchSummary {
  total: number;
  withMedia: number;
  withVideo: number;
  withLinks: number;
  withArticle: number;
  withQuote: number;
  long: number;
  /** How many of the matches X now withholds. See `Bookmark.withheldOnXAt`. */
  withheldOnX: number;
  /**
   * How many of the matches are filed under "other" for want of text. The
   * rest of the matches under "other", whose number is in `categories`, had
   * text enough and fitted no category.
   */
  tooLittleText: number;
  /** Most bookmarks first. `null` is where X named no language. */
  languages: { lang: string | null; bookmarks: number }[];
  /** Calendar years of the bookmark time, in this process's time zone, latest first. */
  years: { year: number; bookmarks: number }[];
  /** How many of what the rest of the options match were removed on X. */
  removedOnX: number;
  /**
   * By category id, most bookmarks first, with the options' own category
   * set aside so that the others stay on offer. `null` is the bookmarks
   * filed under none yet.
   */
  categories: { category: string | null; bookmarks: number }[];
  /** By format id, likewise, with the options' own format set aside. */
  formats: { format: string | null; bookmarks: number }[];
  /**
   * The tags among the matches, most bookmarks first: each count is what
   * adding that tag to the options would leave.
   */
  tags: { tag: string; bookmarks: number }[];
}

/** The rows `options` match, as the tail of a query over `b`, or null when a search holds nothing to search for. */
function matching(
  db: Connection,
  options: MatchOptions,
): {
  from: string;
  parameters: Parameters;
} | null {
  const { conditions, parameters } = conditionsOf(db, options);
  if (options.query === undefined) {
    return { from: `${FROM_BOOKMARKS} ${where(conditions)}`, parameters };
  }
  const { expression } = parseSearchQuery(options.query, options.match);
  if (expression === null) return null;
  return {
    from: `${FROM_BOOKMARKS}
      JOIN bookmark_search ON bookmark_search.rowid = b.id
      ${where(["bookmark_search MATCH @expression", ...conditions])}`,
    parameters: { ...parameters, expression },
  };
}

/**
 * Counts what `options` match, and what each further filter would leave of
 * it. See `MatchSummary`.
 */
export function summariseMatches(
  store: Store,
  options: MatchOptions = {},
): MatchSummary {
  const db = connectionOf(store);
  const all = matching(db, options);
  const anyLanguage = matching(db, {
    ...options,
    lang: undefined,
    langNot: undefined,
  });
  const anyTime = matching(db, {
    ...options,
    bookmarkedSince: undefined,
    bookmarkedBefore: undefined,
  });
  const removed = matching(db, {
    ...options,
    includeRemoved: undefined,
    onlyRemoved: true,
  });
  const anyCategory = matching(db, { ...options, category: undefined });
  const anyFormat = matching(db, { ...options, format: undefined });
  if (
    all === null ||
    anyLanguage === null ||
    anyTime === null ||
    removed === null ||
    anyCategory === null ||
    anyFormat === null
  ) {
    return {
      total: 0,
      withMedia: 0,
      withVideo: 0,
      withLinks: 0,
      withArticle: 0,
      withQuote: 0,
      long: 0,
      withheldOnX: 0,
      tooLittleText: 0,
      languages: [],
      years: [],
      removedOnX: 0,
      categories: [],
      formats: [],
      tags: [],
    };
  }
  const counts = db
    .prepare<
      Parameters,
      Pick<
        MatchSummary,
        | "total"
        | "withMedia"
        | "withVideo"
        | "withLinks"
        | "withArticle"
        | "withQuote"
        | "long"
        | "withheldOnX"
        | "tooLittleText"
      >
    >(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE ${HAS.media}) AS withMedia,
              count(*) FILTER (WHERE ${HAS.video}) AS withVideo,
              count(*) FILTER (WHERE ${HAS.link}) AS withLinks,
              count(*) FILTER (WHERE ${HAS.article}) AS withArticle,
              count(*) FILTER (WHERE ${HAS.quote}) AS withQuote,
              count(*) FILTER (WHERE ${HAS.long}) AS long,
              count(*) FILTER (WHERE ${IS_WITHHELD}) AS withheldOnX,
              count(*) FILTER (WHERE ${TOO_LITTLE_TEXT}) AS tooLittleText
       ${all.from}`,
    )
    .get(all.parameters);
  if (counts === undefined) {
    throw new Error("An aggregate query returned no row.");
  }
  return {
    ...counts,
    languages: db
      .prepare<Parameters, { lang: string | null; bookmarks: number }>(
        `SELECT b.lang AS lang, count(*) AS bookmarks
         ${anyLanguage.from}
         GROUP BY b.lang
         ORDER BY bookmarks DESC, lang`,
      )
      .all(anyLanguage.parameters),
    years: db
      .prepare<Parameters, { year: number; bookmarks: number }>(
        `SELECT CAST(strftime('%Y', ${BOOKMARKED_AT} / 1000, 'unixepoch', 'localtime') AS INTEGER) AS year,
                count(*) AS bookmarks
         ${anyTime.from}
         GROUP BY year
         ORDER BY year DESC`,
      )
      .all(anyTime.parameters),
    removedOnX:
      db
        .prepare<Parameters, number>(`SELECT count(*) ${removed.from}`)
        .pluck()
        .get(removed.parameters) ?? 0,
    categories: db
      .prepare<Parameters, { category: string | null; bookmarks: number }>(
        `SELECT ${CATEGORY} AS category, count(*) AS bookmarks
         ${anyCategory.from}
         GROUP BY 1
         ORDER BY bookmarks DESC, category`,
      )
      .all(anyCategory.parameters),
    formats: db
      .prepare<Parameters, { format: string | null; bookmarks: number }>(
        `SELECT ${FORMAT} AS format, count(*) AS bookmarks
         ${anyFormat.from}
         GROUP BY 1
         ORDER BY bookmarks DESC, format`,
      )
      .all(anyFormat.parameters),
    tags: tagCounts(db, all),
  };
}

/** How many of the rows `matched` holds have each tag, most first. */
function tagCounts(
  db: Connection,
  matched: { from: string; parameters: Parameters },
): { tag: string; bookmarks: number }[] {
  return db
    .prepare<Parameters, { tag: string; bookmarks: number }>(
      `SELECT e.tag AS tag, count(*) AS bookmarks
       FROM bookmark_effective_tags e
       WHERE e.post_id IN (SELECT b.post_id ${matched.from})
       GROUP BY e.tag
       ORDER BY bookmarks DESC, tag`,
    )
    .all(matched.parameters);
}

/**
 * A bookmark whose post X no longer sends: deleted, or from an account that
 * is now protected or suspended. X's timeline still lists it, with nothing
 * in it but the post's id.
 */
export interface WithheldPost {
  postId: string;
  /** When the latest capture that found it withheld was received. */
  withheldAt: Date;
  /**
   * Whether the library holds the post all the same, from a capture taken
   * before X withheld it. `getBookmark` returns it.
   */
  bookmarked: boolean;
}

export interface WithheldPostList {
  /** How many posts are withheld, of which `posts` is one page. */
  total: number;
  /** Most recently found withheld first. */
  posts: WithheldPost[];
}

export interface WithheldPostOptions extends PageOptions {
  /**
   * Only the withheld posts the library holds all the same, or only those it
   * never held, of which nothing but the id is known.
   */
  bookmarked?: boolean | undefined;
}

/**
 * A withheld post is one the latest parses found X withholding, later than
 * any capture that still held it: for a post the library holds, the same
 * test as `Bookmark.withheldOnXAt`.
 */
const FROM_WITHHELD = `
  FROM (
    SELECT i.post_id AS post_id, max(c.received_at) AS withheld_at
    FROM parse_issues i
    JOIN raw_captures c ON c.id = i.capture_id
    WHERE i.kind = 'post-unavailable' AND i.post_id IS NOT NULL
    GROUP BY i.post_id
  ) w
  LEFT JOIN bookmarks b ON b.post_id = w.post_id
  WHERE (b.post_id IS NULL OR w.withheld_at > b.last_seen_at)`;

/**
 * The posts X withholds, a page at a time. Nothing can be read of one the
 * library never held, and nothing is asked of X to find out: X-2.
 */
export function listWithheldPosts(
  store: Store,
  options: WithheldPostOptions = {},
): WithheldPostList {
  const db = connectionOf(store);
  const page = pageOf(options);
  const from =
    options.bookmarked === undefined
      ? FROM_WITHHELD
      : `${FROM_WITHHELD} AND b.post_id IS ${options.bookmarked ? "NOT NULL" : "NULL"}`;
  const total = db.prepare<[], number>(`SELECT count(*) ${from}`).pluck().get();
  const rows = db
    .prepare<
      typeof page,
      { postId: string; withheldAt: number; bookmarked: number }
    >(
      `SELECT w.post_id AS postId, w.withheld_at AS withheldAt,
              b.post_id IS NOT NULL AS bookmarked
       ${from}
       ORDER BY w.withheld_at DESC, length(w.post_id) DESC, w.post_id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all(page);
  return {
    total: total ?? 0,
    posts: rows.map(({ postId, withheldAt, bookmarked }) => ({
      postId,
      withheldAt: new Date(withheldAt),
      bookmarked: bookmarked === 1,
    })),
  };
}

/** Totals over the library, for an overview and for offering filters that exist. */
export interface LibrarySummary {
  /** Bookmarks in the library that are not marked as removed on X. */
  bookmarks: number;
  /** Bookmarks kept in the library that were removed on X. */
  removedOnX: number;
  /** The bookmark times of the first and the latest bookmark, or null for an empty library. */
  earliestBookmarkedAt: Date | null;
  latestBookmarkedAt: Date | null;
  withMedia: number;
  withLinks: number;
  /** How many distinct authors the bookmarks are of. */
  authors: number;
  /** The authors with the most bookmarks, most first. */
  topAuthors: { handle: string; name: string; bookmarks: number }[];
  /** Every language X named, most bookmarks first. `null` is where X named none. */
  languages: { lang: string | null; bookmarks: number }[];
  /** By category id, most bookmarks first. `null` is the bookmarks filed under none yet. */
  categories: { category: string | null; bookmarks: number }[];
  /** By format id, likewise. */
  formats: { format: string | null; bookmarks: number }[];
  /** Every tag in use, most bookmarks first. */
  tags: { tag: string; bookmarks: number }[];
  /**
   * The bookmarks filed under "other", and why. `tooLittleText` is a fact
   * about those bookmarks: a bare link, a few words beside a picture.
   * `noneOfTheAbove` is a fact about the taxonomy: text enough, and no
   * category that fits. When its share grows, a category is missing.
   */
  other: {
    bookmarks: number;
    tooLittleText: number;
    noneOfTheAbove: number;
    /** `bookmarks` as a share of the bookmarks filed under any category, from 0 to 1. Zero when none is filed. */
    share: number;
    /** `noneOfTheAbove` as a share of the same. */
    noneOfTheAboveShare: number;
  };
}

/**
 * Totals over the bookmarks that are not marked as removed on X. The one
 * exception is `removedOnX`, which counts those.
 */
export function summariseLibrary(
  store: Store,
  options: { topAuthors?: number } = {},
): LibrarySummary {
  const topAuthors = options.topAuthors ?? 20;
  if (!Number.isInteger(topAuthors) || topAuthors < 0 || topAuthors > 500) {
    throw new RangeError(
      `topAuthors must be a whole number from 0 to 500; got ${topAuthors}.`,
    );
  }
  const db = connectionOf(store);
  const current = `${FROM_BOOKMARKS} WHERE ${REMOVED_ON_X_AT} IS NULL`;
  const totals = db
    .prepare<
      [],
      {
        bookmarks: number;
        earliest: number | null;
        latest: number | null;
        withMedia: number;
        withLinks: number;
        authors: number;
      }
    >(
      `SELECT count(*) AS bookmarks,
              min(${BOOKMARKED_AT}) AS earliest,
              max(${BOOKMARKED_AT}) AS latest,
              count(*) FILTER (WHERE json_array_length(b.media) > 0) AS withMedia,
              count(*) FILTER (WHERE json_array_length(b.links) > 0) AS withLinks,
              count(DISTINCT b.author_id) AS authors
       ${current}`,
    )
    .get();
  if (totals === undefined) {
    throw new Error("An aggregate query returned no row.");
  }
  const removedOnX = db
    .prepare<[], number>(
      `SELECT count(*) ${FROM_BOOKMARKS} WHERE ${REMOVED_ON_X_AT} IS NOT NULL`,
    )
    .pluck()
    .get();
  const filed = db
    .prepare<[], { filed: number; other: number; tooLittleText: number }>(
      `SELECT count(${CATEGORY}) AS filed,
              count(*) FILTER (WHERE ${CATEGORY} = '${OTHER_CATEGORY}') AS other,
              count(*) FILTER (WHERE ${TOO_LITTLE_TEXT}) AS tooLittleText
       ${current}`,
    )
    .get() ?? { filed: 0, other: 0, tooLittleText: 0 };
  const share = (part: number) => (filed.filed === 0 ? 0 : part / filed.filed);
  return {
    bookmarks: totals.bookmarks,
    removedOnX: removedOnX ?? 0,
    earliestBookmarkedAt:
      totals.earliest === null ? null : new Date(totals.earliest),
    latestBookmarkedAt: totals.latest === null ? null : new Date(totals.latest),
    withMedia: totals.withMedia,
    withLinks: totals.withLinks,
    authors: totals.authors,
    // An author is one account, whatever it was called at each sighting; the
    // handle and name shown are those of its most recent bookmark.
    topAuthors: db
      .prepare<[number], { handle: string; name: string; bookmarks: number }>(
        `SELECT b.author_handle AS handle, b.author_name AS name,
                count(*) AS bookmarks, max(b.last_seen_at)
         ${current}
         GROUP BY b.author_id
         ORDER BY bookmarks DESC, handle COLLATE NOCASE
         LIMIT ?`,
      )
      .all(topAuthors)
      .map(({ handle, name, bookmarks }) => ({ handle, name, bookmarks })),
    languages: db
      .prepare<[], { lang: string | null; bookmarks: number }>(
        `SELECT b.lang AS lang, count(*) AS bookmarks
         ${current}
         GROUP BY b.lang
         ORDER BY bookmarks DESC, lang`,
      )
      .all(),
    categories: db
      .prepare<[], { category: string | null; bookmarks: number }>(
        `SELECT ${CATEGORY} AS category, count(*) AS bookmarks
         ${current}
         GROUP BY 1
         ORDER BY bookmarks DESC, category`,
      )
      .all(),
    formats: db
      .prepare<[], { format: string | null; bookmarks: number }>(
        `SELECT ${FORMAT} AS format, count(*) AS bookmarks
         ${current}
         GROUP BY 1
         ORDER BY bookmarks DESC, format`,
      )
      .all(),
    tags: tagCounts(db, { from: current, parameters: {} }),
    other: {
      bookmarks: filed.other,
      tooLittleText: filed.tooLittleText,
      noneOfTheAbove: filed.other - filed.tooLittleText,
      share: share(filed.other),
      noneOfTheAboveShare: share(filed.other - filed.tooLittleText),
    },
  };
}
