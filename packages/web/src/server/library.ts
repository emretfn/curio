/**
 * Every read the library UI makes. Pages and routes call these functions and
 * nothing else for bookmark data.
 *
 * The exported types are what the screen works in: a query as the address
 * bar states it, a page of items with a cursor, the counts beside the
 * filters, and how capture, parsing and the backups are doing. Every answer
 * comes from core's query functions (READ-1), so a search here is the search
 * the MCP server runs, with the same folding and the same ranking, and
 * "removed", "withheld" and "saved in" mean what they mean everywhere. This
 * file only translates: the screen's query into core's filter, and core's
 * answers into the screen's shapes. A question core cannot answer is added
 * to core, not answered here.
 */
import type {
  Bookmark,
  BookmarkFilter,
  MatchOptions,
  ParsingSummary,
  Store,
} from "@x-bookmarks/core";
import { CAPTURE_SOURCE } from "@x-bookmarks/extension";
import type { LabelChoices } from "../components/library/label-choices.tsx";
import { type BackupStatus, backupFailure } from "./backups.ts";
import {
  getVocabulary,
  listBookmarks,
  listWithheldPosts,
  MAX_PAGE_SIZE,
  OTHER_CATEGORY,
  resolveTag,
  searchBookmarks,
  summariseLibrary,
  summariseMatches,
  summariseParsing,
  summariseRawCaptures,
  TAXONOMY,
} from "./core.ts";

/** Something a post has, to filter on. Each is core's filter of that name. */
export const POST_FEATURES = [
  "media",
  "video",
  "link",
  "article",
  "quote",
  "long",
] as const;
/**
 * - `media`: at least one photo, video or GIF.
 * - `video`: at least one video or GIF.
 * - `link`: a link in the text.
 * - `article`: an X Article.
 * - `quote`: it quotes another post.
 * - `long`: more than core's `LONG_POST_CHARACTERS` characters.
 */
export type PostFeature = (typeof POST_FEATURES)[number];

/** The owner's two reading languages, and everything else, by X's language code. */
export const LIBRARY_LANGUAGES = ["en", "tr", "other"] as const;
export type LibraryLanguage = (typeof LIBRARY_LANGUAGES)[number];
const NAMED_LANGUAGES = LIBRARY_LANGUAGES.filter(
  (language) => language !== "other",
);

/**
 * How a bookmark stands on X now.
 * - `removed`: a capture showed the owner removing it on X.
 * - `withheld`: X no longer sends the post.
 */
export const X_STANDINGS = ["removed", "withheld"] as const;
export type XStanding = (typeof X_STANDINGS)[number];

/**
 * Why a bookmark is under "other": the stored text was too little to tell,
 * or there was text enough and no category fitted. The two mean opposite
 * things and are never counted as one (LAB-10).
 */
export const OTHER_REASONS = ["little", "enough"] as const;
export type OtherReason = (typeof OTHER_REASONS)[number];

/** In place of a category: the bookmarks filed under none yet. */
export const NOT_CLASSIFIED = "none";

/** What to list. An empty query is the whole library, without what was removed on X. */
export interface LibraryQuery {
  /**
   * A search, read as core's `searchBookmarks` reads it: every word, and
   * every phrase in double quotes, must be found. With one, the list is
   * ordered best match first.
   */
  text?: string | undefined;
  /** Every one of these must hold. */
  features?: readonly PostFeature[] | undefined;
  language?: LibraryLanguage | undefined;
  /** Saved at or after this time. */
  savedFrom?: Date | undefined;
  /** Saved before this time. */
  savedBefore?: Date | undefined;
  /** X's numeric id of the author. */
  authorId?: string | undefined;
  standing?: XStanding | undefined;
  /** A category id of the taxonomy, or `NOT_CLASSIFIED` for the bookmarks filed under none yet. */
  category?: string | undefined;
  /** Among the bookmarks under "other", only those there for this reason. */
  otherReason?: OtherReason | undefined;
  /** A format id of the taxonomy. */
  format?: string | undefined;
  /**
   * Every one of these tags must be on the bookmark. Each is a tag of the
   * vocabulary or another way of writing one; a text that is neither matches
   * nothing, and `getLibraryFacets` names it in `unknownTags`.
   */
  tags?: readonly string[] | undefined;
  /** Bookmarks the classifier proposed this tag for, a tag the vocabulary does not hold. */
  proposedTag?: string | undefined;
}

/** A bookmark in the library. When it was saved is its `bookmarkedAt`. */
export interface LibraryBookmark {
  kind: "bookmark";
  bookmark: Bookmark;
}

/** A bookmark whose post X withholds and the library never held. Only its id is known. */
export interface WithheldPost {
  kind: "withheld";
  postId: string;
}

export type LibraryItem = LibraryBookmark | WithheldPost;

export interface LibraryPage {
  /**
   * Newest saved first, or best match first for a search. Withheld posts
   * the library never held, which have no time, come last.
   */
  items: LibraryItem[];
  /** Pass as `after` for the next page, with the same query. Null on the last page. */
  nextCursor: string | null;
  /** How many items match the query, on every page together. */
  total: number;
  /**
   * What a search looked for, as core folded it, for marking in each post.
   * Empty when the query has no search, or one with nothing to look for.
   */
  terms: string[];
}

export interface PageRequest {
  after?: string | null | undefined;
  /** Defaults to `DEFAULT_PAGE_SIZE`, and is capped at core's `MAX_PAGE_SIZE`. */
  limit?: number | undefined;
  /**
   * How many items the query matched when the reader's last page was read:
   * that page's `total`. A search is counted off by position, and a match
   * that has left the search since, such as a post the reader has just
   * filed out of the filter, moves every later match one place up. Given
   * this, a search's page starts as many places earlier as matches have
   * left, so none is passed over; the reader drops what it is sent twice.
   * A list by time continues from a bookmark and needs none of it.
   */
  seen?: number | undefined;
}

export const DEFAULT_PAGE_SIZE = 40;

/**
 * How many items each filter would leave, given the rest of the query. A
 * count for one group ignores that group's own choice, so the other languages
 * and years stay visible while one is chosen; features narrow, so a feature's
 * count is what adding it would leave.
 */
export interface LibraryFacets {
  /** Items matching the whole query. */
  total: number;
  /** Bookmarks in the library, whatever the query, without what was removed on X. */
  librarySize: number;
  features: Record<PostFeature, number>;
  languages: Record<LibraryLanguage, number>;
  /** Calendar years in the server's time zone, newest first, with at least one bookmark. */
  savedYears: { year: number; count: number }[];
  standings: Record<XStanding, number>;
  /** The author the query names, when it names one that is in the library. */
  author: { id: string; handle: string; name: string } | null;
  /**
   * Whether any bookmark of the library is filed under a category at all.
   * Before the first run of the classifier none is, and the screen says so
   * in place of a list of empty categories.
   */
  anyFiled: boolean;
  /**
   * Every category of the taxonomy but "other", in the taxonomy's order,
   * with how many bookmarks choosing it would leave.
   */
  categories: { id: string; count: number }[];
  /** The bookmarks under "other", by why they are there. */
  other: Record<OtherReason, number>;
  /** The bookmarks filed under no category yet. */
  notClassified: number;
  /** Every format of the taxonomy, in its order. */
  formats: { id: string; count: number }[];
  /**
   * The tags on the matching bookmarks, most bookmarks first: each count is
   * what adding that tag to the query would leave.
   */
  tags: { tag: string; count: number }[];
  /** The query's tags as the vocabulary writes them, an alias resolved to its tag. */
  chosenTags: string[];
  /** What the query gave as a tag that is none, or one that was retired. With any, nothing matches. */
  unknownTags: string[];
}

/**
 * How capture, parsing and the backups are doing. This route fails silently
 * when X changes a response, and a backup that has stopped is only missed
 * when it is needed, so the UI shows this on every screen.
 *
 * - `problem`: a capture or an entry was not understood, so bookmarks are
 *   missing from the library until it is fixed; or the last backup failed,
 *   so the library is not being backed up.
 * - `attention`: captures are waiting for a re-parse.
 * - `ok`: neither.
 */
export interface LibraryStatus {
  level: "ok" | "attention" | "problem";
  /** Captures from the extension: how many, and the latest. */
  captures: { count: number; lastReceivedAt: Date | null };
  parsing: ParsingSummary;
  backups: BackupStatus;
}

const searchOf = (query: LibraryQuery): string | undefined => {
  const text = query.text?.trim() ?? "";
  return text === "" ? undefined : text;
};

/**
 * The query's tags as the vocabulary writes them, each once, and the texts
 * that are no tag of it. Core refuses a filter that names an unknown tag,
 * and an address can hold anything, so they are told apart here.
 */
export function readTags(
  store: Store,
  tags: readonly string[] = [],
): { known: string[]; unknown: string[] } {
  const known = new Set<string>();
  const unknown = new Set<string>();
  for (const text of tags) {
    const tag = resolveTag(store, text);
    if (tag === undefined) unknown.add(text);
    else known.add(tag);
  }
  return { known: [...known], unknown: [...unknown] };
}

/**
 * What a bookmark can be filed under, for the menus on each row: the
 * taxonomy's categories and formats, and the vocabulary's tags as it stands,
 * each with the other ways it is written.
 */
export function labelChoices(store: Store): LabelChoices {
  const { tags, aliases } = getVocabulary(store);
  const written = new Map<string, string[]>();
  for (const [alias, tag] of Object.entries(aliases)) {
    written.set(tag, [...(written.get(tag) ?? []), alias]);
  }
  const choice = ({
    id,
    label,
    definition,
  }:
    | (typeof TAXONOMY.categories)[number]
    | (typeof TAXONOMY.formats)[number]) => ({
    id,
    label,
    definition,
  });
  return {
    categories: TAXONOMY.categories.map(choice),
    formats: TAXONOMY.formats.map(choice),
    tags: tags.map((tag) => ({ tag, aliases: written.get(tag) ?? [] })),
  };
}

/** The screen's query as core's filter. The search is passed beside it. */
function filterOf(store: Store, query: LibraryQuery): BookmarkFilter {
  const has = (feature: PostFeature) =>
    query.features?.includes(feature) ? true : undefined;
  const filed =
    query.category !== undefined && query.category !== NOT_CLASSIFIED;
  return {
    category: filed ? query.category : undefined,
    classified: query.category === NOT_CLASSIFIED ? false : undefined,
    tooLittleText:
      query.category === OTHER_CATEGORY && query.otherReason !== undefined
        ? query.otherReason === "little"
        : undefined,
    format: query.format,
    tags: readTags(store, query.tags).known,
    proposedTag: query.proposedTag,
    authorId: query.authorId,
    hasMedia: has("media"),
    hasVideo: has("video"),
    hasLink: has("link"),
    hasArticle: has("article"),
    hasQuote: has("quote"),
    isLong: has("long"),
    lang: query.language === "other" ? undefined : query.language,
    langNot: query.language === "other" ? NAMED_LANGUAGES : undefined,
    bookmarkedSince: query.savedFrom,
    bookmarkedBefore: query.savedBefore,
    onlyRemoved: query.standing === "removed" ? true : undefined,
    onlyWithheld: query.standing === "withheld" ? true : undefined,
  };
}

/**
 * Whether a query asks for something only a post that was captured can
 * have. A withheld post the library never held has an id and nothing else,
 * so such a query cannot match one.
 */
const asksForContent = (query: LibraryQuery): boolean =>
  searchOf(query) !== undefined ||
  (query.features?.length ?? 0) > 0 ||
  query.language !== undefined ||
  query.savedFrom !== undefined ||
  query.savedBefore !== undefined ||
  query.authorId !== undefined ||
  query.category !== undefined ||
  query.format !== undefined ||
  (query.tags?.length ?? 0) > 0 ||
  query.proposedTag !== undefined;

const neverHeld = (store: Store, page: { limit: number; offset?: number }) =>
  listWithheldPosts(store, { ...page, bookmarked: false });

const NOT_A_CURSOR = "after must be the nextCursor of an earlier page.";

/**
 * A search is ranked, so its pages are counted off (`s:40`), and so are the
 * withheld posts that close a list (`w:2`). A list by time continues from
 * core's own cursor, which keeps its place while captures arrive.
 */
function offsetOf(after: string, kind: "s" | "w"): number {
  const [, offset] =
    new RegExp(`^${kind}:([0-9]{1,9})$`).exec(after) ?? ([] as string[]);
  if (offset === undefined) throw new RangeError(NOT_A_CURSOR);
  return Number(offset);
}

/**
 * One page of what `query` matches. Throws a `RangeError` for a cursor that
 * no page of this query returned.
 */
export function listLibrary(
  store: Store,
  query: LibraryQuery = {},
  page: PageRequest = {},
): LibraryPage {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(page.limit ?? DEFAULT_PAGE_SIZE)),
  );
  const after = page.after ?? null;
  // A tag the vocabulary does not hold is on no bookmark.
  if (readTags(store, query.tags).unknown.length > 0) {
    return { items: [], nextCursor: null, total: 0, terms: [] };
  }
  const filter = filterOf(store, query);

  const text = searchOf(query);
  if (text !== undefined) {
    const asked = after === null ? 0 : offsetOf(after, "s");
    const search = (offset: number, count: number) =>
      searchBookmarks(store, { ...filter, query: text, limit: count, offset });
    let offset = asked;
    let found = search(offset, limit);
    // Fewer matches than the reader's last page knew of: as many may have
    // left from before this page's place, and the matches that stood there
    // are now before it. The page is read again from that much earlier, and
    // that much longer, as far as a page may be.
    const left = Math.min(
      asked,
      MAX_PAGE_SIZE - limit,
      Math.max(0, (page.seen ?? found.total) - found.total),
    );
    if (left > 0) {
      offset = asked - left;
      found = search(offset, limit + left);
    }
    const shown = offset + found.hits.length;
    return {
      items: found.hits.map(({ bookmark }) => ({ kind: "bookmark", bookmark })),
      nextCursor: shown < found.total ? `s:${shown}` : null,
      total: found.total,
      terms: found.terms,
    };
  }

  // The bookmarks first. Where the query asks for withheld posts and for
  // nothing a post would need, those the library never held follow them.
  const closing = query.standing === "withheld" && !asksForContent(query);
  const inClosing = after?.startsWith("w:") ?? false;
  if (inClosing && !closing) throw new RangeError(NOT_A_CURSOR);
  const listed = inClosing
    ? {
        total: listBookmarks(store, { ...filter, limit: 1 }).total,
        bookmarks: [],
        nextCursor: null,
      }
    : listBookmarks(store, { ...filter, limit, after: after ?? undefined });
  const items: LibraryItem[] = listed.bookmarks.map((bookmark) => ({
    kind: "bookmark",
    bookmark,
  }));
  if (!closing) {
    return {
      items,
      nextCursor: listed.nextCursor,
      total: listed.total,
      terms: [],
    };
  }
  const offset = inClosing && after !== null ? offsetOf(after, "w") : 0;
  // Only once the bookmarks have run out, and as far as the page has room.
  const room = listed.nextCursor === null ? limit - items.length : 0;
  const withheld = neverHeld(store, { limit: Math.max(1, room), offset });
  const taken = withheld.posts.slice(0, room);
  for (const { postId } of taken) items.push({ kind: "withheld", postId });
  const shown = offset + taken.length;
  return {
    items,
    nextCursor:
      listed.nextCursor ?? (shown < withheld.total ? `w:${shown}` : null),
    total: listed.total + withheld.total,
    terms: [],
  };
}

/** The counts beside each filter, for `query`. */
export function getLibraryFacets(
  store: Store,
  query: LibraryQuery = {},
): LibraryFacets {
  const options: MatchOptions = {
    ...filterOf(store, query),
    query: searchOf(query),
  };
  const { known, unknown } = readTags(store, query.tags);
  const matches = summariseMatches(store, options);
  // What choosing a category would leave is counted with the category that
  // is chosen now, and the reason beside it, set aside.
  const anyCategory =
    query.category === undefined
      ? matches
      : summariseMatches(store, {
          ...options,
          category: undefined,
          classified: undefined,
          tooLittleText: undefined,
        });
  const filedUnder = new Map(
    anyCategory.categories.map(({ category, bookmarks }) => [
      category,
      bookmarks,
    ]),
  );
  const ofFormat = new Map(
    matches.formats.map(({ format, bookmarks }) => [format, bookmarks]),
  );
  const library = summariseLibrary(store, { topAuthors: 0 });
  // What choosing a standing would leave is counted with the standing that
  // is chosen now set aside, like every other group.
  const open =
    query.standing === undefined
      ? matches
      : summariseMatches(store, {
          ...options,
          onlyRemoved: undefined,
          onlyWithheld: undefined,
        });
  const unheld = asksForContent(query)
    ? 0
    : neverHeld(store, { limit: 1 }).total;

  const languages: LibraryFacets["languages"] = { en: 0, tr: 0, other: 0 };
  for (const { lang, bookmarks } of matches.languages) {
    languages[lang === "en" || lang === "tr" ? lang : "other"] += bookmarks;
  }
  const [author] =
    query.authorId === undefined
      ? []
      : listBookmarks(store, {
          authorId: query.authorId,
          includeRemoved: true,
          limit: 1,
        }).bookmarks;
  return {
    total:
      unknown.length > 0
        ? 0
        : matches.total + (query.standing === "withheld" ? unheld : 0),
    librarySize: library.bookmarks,
    anyFiled: library.categories.some(({ category }) => category !== null),
    categories: TAXONOMY.categories
      .filter(({ id }) => id !== OTHER_CATEGORY)
      .map(({ id }) => ({ id, count: filedUnder.get(id) ?? 0 })),
    other: {
      little: anyCategory.tooLittleText,
      enough: (filedUnder.get(OTHER_CATEGORY) ?? 0) - anyCategory.tooLittleText,
    },
    notClassified: filedUnder.get(null) ?? 0,
    formats: TAXONOMY.formats.map(({ id }) => ({
      id,
      count: ofFormat.get(id) ?? 0,
    })),
    tags: matches.tags.map(({ tag, bookmarks }) => ({ tag, count: bookmarks })),
    chosenTags: known,
    unknownTags: unknown,
    features: {
      media: matches.withMedia,
      video: matches.withVideo,
      link: matches.withLinks,
      article: matches.withArticle,
      quote: matches.withQuote,
      long: matches.long,
    },
    languages,
    savedYears: matches.years.map(({ year, bookmarks }) => ({
      year,
      count: bookmarks,
    })),
    standings: {
      removed: open.removedOnX,
      withheld: open.withheldOnX + unheld,
    },
    author:
      author === undefined
        ? null
        : {
            id: author.authorId,
            handle: author.authorHandle,
            name: author.authorName,
          },
  };
}

/**
 * How capture, parsing and the backups are doing. The backups are passed in,
 * as `backupStatus()` reports them: they are this process's own, not the
 * store's.
 */
export function getLibraryStatus(
  store: Store,
  backups: BackupStatus,
): LibraryStatus {
  const parsing = summariseParsing(store);
  const { count, lastReceivedAt } = summariseRawCaptures(store, CAPTURE_SOURCE);
  const broken =
    parsing.captures.failed > 0 ||
    parsing.failedEntries > 0 ||
    backupFailure(backups) !== null;
  const waiting = parsing.captures.pending + parsing.captures.outdated > 0;
  return {
    level: broken ? "problem" : waiting ? "attention" : "ok",
    captures: { count, lastReceivedAt },
    parsing,
    backups,
  };
}
