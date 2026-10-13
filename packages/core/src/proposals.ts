/**
 * The tags the classifier has proposed beyond the vocabulary, arranged for
 * someone who has to decide on them. A library of a thousand bookmarks
 * yields hundreds of proposals, most of them made once, and many of them
 * the same subject under two names. So proposals are listed in groups of
 * near-duplicates, each with the tags of the vocabulary it resembles, most
 * proposed first, and a threshold leaves out the ones made too seldom to be
 * worth a look.
 *
 * The grouping is a suggestion and nothing more. It compares names, not
 * meanings, and it changes nothing: what becomes of a proposal is decided
 * with `acceptTagProposal` and `dismissTagProposal` in `vocabulary.ts`.
 */
import { connectionOf, type Store } from "./store.ts";

/** One subject the classifier proposed a tag for, under one name or several. */
export interface TagProposal {
  /** The name it was proposed under most often. */
  proposal: string;
  /** How many bookmarks it was proposed for, under any of its names. */
  bookmarks: number;
  /**
   * Every name in the group with the bookmarks it alone was proposed for,
   * most first. A proposal nothing else resembles is a group of one.
   */
  variants: { proposal: string; bookmarks: number }[];
  /** Tags of the vocabulary whose names resemble it: it may be another way of writing one of them. */
  similarTags: string[];
  /** When the classifier last proposed any of its names. */
  lastProposedAt: Date;
}

export interface TagProposalList {
  /** How many groups there are at or above the threshold, of which `proposals` is one page. */
  total: number;
  /** How many more groups fall below the threshold. */
  belowThreshold: number;
  proposals: TagProposal[];
}

export interface TagProposalOptions {
  /** Leave out groups proposed for fewer bookmarks than this. Defaults to 1, which leaves out none. */
  minBookmarks?: number | undefined;
  /** Only groups the classifier proposed at this time or later, as for a week's review. */
  proposedSince?: Date | undefined;
  /** 1 to `MAX_TAG_PROPOSALS`. Defaults to 50. */
  limit?: number | undefined;
  offset?: number | undefined;
}

export const MAX_TAG_PROPOSALS = 200;

/**
 * Words too common in the names of tags to say that two names are about the
 * same thing. Words, not tags: the vocabulary is in the database.
 */
const COMMON_WORDS = new Set([
  "ai",
  "api",
  "app",
  "apps",
  "based",
  "code",
  "coding",
  "data",
  "dev",
  "for",
  "js",
  "new",
  "open",
  "pro",
  "source",
  "the",
  "tool",
  "ui",
  "ux",
  "web",
  "with",
]);

/** A word shared by more names than this is a common one here, whatever the list above says. */
const MOST_NAMES_SHARING_A_WORD = 4;

/** A word without its ending, so that a plural or an "-ing" is the same word. */
function stem(word: string): string {
  if (word.length > 6 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** The words of a name that could tie it to another, stemmed. */
const wordsOf = (name: string) =>
  name
    .split(/[-.]/)
    .filter((word) => word.length >= 3 && !COMMON_WORDS.has(word))
    .map(stem);

/** A name with its separators taken out: "next-auth" and "nextauth" are the same letters. */
const lettersOf = (name: string) => name.replace(/[-.]/g, "");

/**
 * The proposals the vocabulary does not know, grouped and counted, the most
 * proposed first.
 *
 * Two names are put in one group when they are the same letters apart from
 * their hyphens, or share a word that few other names hold. A group
 * resembles a tag of the vocabulary on the same terms.
 */
export function listTagProposals(
  store: Store,
  options: TagProposalOptions = {},
): TagProposalList {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const minBookmarks = options.minBookmarks ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TAG_PROPOSALS) {
    throw new RangeError(
      `limit must be a whole number from 1 to ${MAX_TAG_PROPOSALS}; got ${limit}.`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(
      `offset must be a whole number, zero or above; got ${offset}.`,
    );
  }
  if (!Number.isInteger(minBookmarks) || minBookmarks < 1) {
    throw new RangeError(
      `minBookmarks must be a whole number of at least 1; got ${minBookmarks}.`,
    );
  }
  const db = connectionOf(store);
  const rows = db
    .prepare<[], { proposal: string; postId: string; at: number }>(
      `SELECT p.value AS proposal, cl.post_id AS postId, cl.classified_at AS at
       FROM bookmark_classifications cl, json_each(cl.proposed_tags) AS p`,
    )
    .all();
  const tags = db
    .prepare<[], string>("SELECT tag FROM tags WHERE retired_at IS NULL")
    .pluck()
    .all();

  const proposed = new Map<string, { posts: Set<string>; last: number }>();
  for (const { proposal, postId, at } of rows) {
    const entry = proposed.get(proposal) ?? { posts: new Set(), last: 0 };
    entry.posts.add(postId);
    entry.last = Math.max(entry.last, at);
    proposed.set(proposal, entry);
  }
  const names = [...proposed.keys()].toSorted();

  // How many names, proposals and tags alike, hold each word.
  const holders = new Map<string, number>();
  for (const name of [...names, ...tags]) {
    for (const word of new Set(wordsOf(name))) {
      holders.set(word, (holders.get(word) ?? 0) + 1);
    }
  }
  const telling = (name: string) =>
    wordsOf(name).filter(
      (word) => (holders.get(word) ?? 0) <= MOST_NAMES_SHARING_A_WORD,
    );
  const alike = (one: string, other: string) => {
    if (lettersOf(one) === lettersOf(other)) return true;
    const words = new Set(telling(one));
    return telling(other).some((word) => words.has(word));
  };

  // Names that are alike, and names alike to those, are one group.
  const group = new Map(names.map((name) => [name, name]));
  const groupOf = (name: string): string => {
    let root = name;
    for (;;) {
      const parent = group.get(root) ?? root;
      if (parent === root) return root;
      root = parent;
    }
  };
  for (const [index, one] of names.entries()) {
    for (const other of names.slice(index + 1)) {
      if (alike(one, other)) group.set(groupOf(other), groupOf(one));
    }
  }
  const members = new Map<string, string[]>();
  for (const name of names) {
    const root = groupOf(name);
    members.set(root, [...(members.get(root) ?? []), name]);
  }

  const since = options.proposedSince?.getTime() ?? 0;
  const groups: TagProposal[] = [];
  for (const variants of members.values()) {
    const posts = new Set<string>();
    let last = 0;
    const counted = variants
      .map((proposal) => {
        const entry = proposed.get(proposal);
        for (const post of entry?.posts ?? []) posts.add(post);
        last = Math.max(last, entry?.last ?? 0);
        return { proposal, bookmarks: entry?.posts.size ?? 0 };
      })
      .toSorted(
        (a, b) =>
          b.bookmarks - a.bookmarks ||
          a.proposal.length - b.proposal.length ||
          a.proposal.localeCompare(b.proposal),
      );
    if (last < since) continue;
    groups.push({
      proposal: counted[0]?.proposal ?? "",
      bookmarks: posts.size,
      variants: counted,
      similarTags: tags
        .filter((tag) => variants.some((name) => alike(name, tag)))
        .toSorted(),
      lastProposedAt: new Date(last),
    });
  }
  groups.sort(
    (a, b) =>
      b.bookmarks - a.bookmarks ||
      b.variants.length - a.variants.length ||
      a.proposal.localeCompare(b.proposal),
  );
  const shown = groups.filter(({ bookmarks }) => bookmarks >= minBookmarks);
  return {
    total: shown.length,
    belowThreshold: groups.length - shown.length,
    proposals: shown.slice(offset, offset + limit),
  };
}
