/**
 * What the Tags screen reads: the tags the classifier proposed, in the
 * groups core arranges them in, and the vocabulary as it stands. Both are
 * core's (`listTagProposals`, `listTags`); this file asks for them and
 * holds no grouping, likeness or count of its own (LAB-8).
 */
import type { Store } from "@curio/core";
import { listTagProposals, listTags, MAX_TAG_PROPOSALS } from "./core.ts";

/** One subject the classifier proposed a tag for. */
export interface ProposalView {
  /** The name it was proposed under most often. */
  name: string;
  /** How many bookmarks that name was proposed for. */
  bookmarks: number;
  /** Other names core put in the same group, each with its own bookmarks. A guess about likeness, for the owner to agree with or not. */
  variants: { name: string; bookmarks: number }[];
  /** Tags of the vocabulary whose names resemble it. */
  similarTags: string[];
}

export interface TagView {
  tag: string;
  /** How many bookmarks have it. For a retired tag, how many would get it back. */
  bookmarks: number;
  aliases: string[];
}

export interface TagsScreen {
  proposals: ProposalView[];
  /** Groups at or above the threshold, of which `proposals` holds the first `MAX_TAG_PROPOSALS`. */
  proposalsTotal: number;
  /** Groups proposed for fewer bookmarks than the threshold, which are left out. */
  proposalsBelow: number;
  /** The threshold: groups proposed for fewer bookmarks than this are left out. */
  atLeast: number;
  /** Most used first. */
  tags: TagView[];
  retired: TagView[];
}

/**
 * Most proposals are made once, and a list of hundreds of them is not read.
 * So the screen opens on those made for two bookmarks or more, and offers
 * the rest.
 */
export const DEFAULT_AT_LEAST = 2;

/** Reads the screen's one parameter: `?least=1` shows every proposal. */
export function atLeastOf(value: string | string[] | undefined): number {
  const asked = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(asked) && asked >= 1 && asked <= 1000
    ? asked
    : DEFAULT_AT_LEAST;
}

export function getTagsScreen(store: Store, atLeast: number): TagsScreen {
  const listed = listTagProposals(store, {
    minBookmarks: atLeast,
    limit: MAX_TAG_PROPOSALS,
  });
  const all = listTags(store, { includeRetired: true }).map(
    ({ tag, bookmarks, aliases, retiredAt }) => ({
      retired: retiredAt !== null,
      view: { tag, bookmarks, aliases },
    }),
  );
  return {
    proposals: listed.proposals.map(({ proposal, variants, similarTags }) => ({
      name: proposal,
      bookmarks:
        variants.find((variant) => variant.proposal === proposal)?.bookmarks ??
        0,
      variants: variants
        .filter((variant) => variant.proposal !== proposal)
        .map((variant) => ({
          name: variant.proposal,
          bookmarks: variant.bookmarks,
        })),
      similarTags,
    })),
    proposalsTotal: listed.total,
    proposalsBelow: listed.belowThreshold,
    atLeast,
    tags: all.filter(({ retired }) => !retired).map(({ view }) => view),
    retired: all.filter(({ retired }) => retired).map(({ view }) => view),
  };
}
