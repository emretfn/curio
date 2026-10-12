import type { PostContent, QuotedPost } from "../post.ts";
import type { ShapeIssue } from "./shape.ts";

/** A bookmark as a parser read it: a sighting without the capture it came from. */
export interface ParsedBookmark extends PostContent {
  quoted: QuotedPost | null;
  /** The timeline's ordering value for this entry, as a decimal string. */
  sortIndex: string | null;
}

interface EntryPosition {
  /** Position among the capture's entries, counted across its instructions from 0. */
  index: number;
  /** Where the entry sits in the payload, as a JSON path. */
  path: string;
  /** X's id for the timeline entry, such as `tweet-1975…`, when it could be read. */
  entryId: string | null;
}

/** What one timeline entry turned out to be. Entries that are not bookmarks (cursors) are not listed. */
export type ParsedEntry =
  | (EntryPosition & {
      kind: "bookmark";
      bookmark: ParsedBookmark;
      /** Parts of the post that were not understood and were left empty. */
      warnings: ShapeIssue[];
    })
  | (EntryPosition & {
      /** A bookmark whose post X no longer shows: deleted, or restricted. */
      kind: "unavailable";
      postId: string;
      /** Where in the payload X put its placeholder for the post. */
      withheldAt: string;
      /** What X sent in place of the post, by type name. */
      detail: string;
    })
  | (EntryPosition & {
      /** An entry the parser did not understand. Nothing was taken from it. */
      kind: "failed";
      /** The post the entry is about, when its id could still be read. */
      postId: string | null;
      issue: ShapeIssue;
    });

/**
 * What a parser made of one payload.
 *
 * `parsed` with no entries means the response was understood and held no
 * bookmarks. A payload that was not understood is always `failed`, never an
 * empty `parsed`: X breaking a parser must not look like an empty page.
 */
export type ParsedCapture =
  | {
      outcome: "parsed";
      entries: ParsedEntry[];
      /** Parts of the response outside any entry that were not understood. */
      warnings: ShapeIssue[];
    }
  | { outcome: "failed"; issue: ShapeIssue };

/** A parser: the text of one response in, what it holds out. No database access. */
export type CaptureParser = (payload: string) => ParsedCapture;
