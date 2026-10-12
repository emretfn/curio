/**
 * Parses a `Bookmarks` response of X's web client: one page of the bookmarks
 * timeline, as `data.bookmark_timeline_v2.timeline.instructions[].entries[]`.
 */
import type { CaptureParser, ParsedBookmark, ParsedEntry } from "../parsed.ts";
import {
  attempt,
  descend,
  field,
  id,
  invalid,
  items,
  type Node,
  required,
  rootNode,
  type ShapeIssue,
  text,
  unknownVariant,
} from "../shape.ts";
import { readPost, readQuoted, resolvePost } from "./post.ts";

const TWEET_ENTRY_ID = /^tweet-([0-9]+)$/;

type EntryReading =
  | { kind: "cursor" }
  | { kind: "bookmark"; bookmark: ParsedBookmark; warnings: ShapeIssue[] }
  | { kind: "unavailable"; postId: string; withheldAt: string; detail: string };

/** Reads one timeline entry. Throws a `ShapeError` when it is not understood. */
function readEntry(entry: Node): EntryReading {
  const content = required(entry, "content");
  const entryType = required(content, "entryType");
  if (entryType.value === "TimelineTimelineCursor") return { kind: "cursor" };
  if (entryType.value !== "TimelineTimelineItem") {
    unknownVariant(entryType, [
      "TimelineTimelineItem",
      "TimelineTimelineCursor",
    ]);
  }
  const item = required(content, "itemContent");
  const itemType = required(item, "itemType");
  if (itemType.value !== "TimelineTweet") {
    unknownVariant(itemType, ["TimelineTweet"]);
  }

  const resolved = resolvePost(
    field(required(item, "tweet_results"), "result"),
  );
  if ("withheld" in resolved) {
    // The post's id survives only in the entry's own id.
    const entryId = required(entry, "entryId");
    const postId = TWEET_ENTRY_ID.exec(text(entryId))?.[1];
    if (postId === undefined) throw invalid(entryId, "tweet-<post id>");
    return { kind: "unavailable", postId, ...resolved.withheld };
  }

  const warnings: ShapeIssue[] = [];
  const warn = (issue: ShapeIssue) => void warnings.push(issue);
  const secondary = <T>(fallback: T, read: () => T): T => {
    const result = attempt(read);
    if (!result.ok) warn(result.issue);
    return result.ok ? result.value : fallback;
  };
  const post = readPost(resolved.post, warn);
  return {
    kind: "bookmark",
    bookmark: {
      ...post,
      quoted: secondary(null, () => readQuoted(resolved.post, warn)),
      sortIndex: secondary(null, () => id(required(entry, "sortIndex"))),
    },
    warnings,
  };
}

/** The entry's own id and the post it names, read leniently for a failure report. */
function identify(entry: Node): {
  entryId: string | null;
  postId: string | null;
} {
  const entryId = attempt(() => text(required(entry, "entryId")));
  if (!entryId.ok) return { entryId: null, postId: null };
  return {
    entryId: entryId.value,
    postId: TWEET_ENTRY_ID.exec(entryId.value)?.[1] ?? null,
  };
}

export const parseBookmarks: CaptureParser = (payload) => {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return {
      outcome: "failed",
      issue: { code: "not-json", path: "$", detail: "the payload is not JSON" },
    };
  }

  const instructions = attempt(() =>
    items(
      descend(
        rootNode(json),
        "data",
        "bookmark_timeline_v2",
        "timeline",
        "instructions",
      ),
    ),
  );
  if (!instructions.ok) return { outcome: "failed", issue: instructions.issue };

  const entries: ParsedEntry[] = [];
  const warnings: ShapeIssue[] = [];
  let index = 0;
  for (const instruction of instructions.value) {
    // An instruction that is not a list of entries is reported and passed
    // over, so that the entries beside it are still read.
    const listed = attempt(() => {
      const type = required(instruction, "type");
      if (type.value !== "TimelineAddEntries") {
        unknownVariant(type, ["TimelineAddEntries"]);
      }
      return items(required(instruction, "entries"));
    });
    if (!listed.ok) {
      warnings.push(listed.issue);
      continue;
    }
    for (const entry of listed.value) {
      const position = { index, path: entry.path, ...identify(entry) };
      index += 1;
      const reading = attempt(() => readEntry(entry));
      if (!reading.ok) {
        entries.push({ ...position, kind: "failed", issue: reading.issue });
      } else if (reading.value.kind === "bookmark") {
        entries.push({ ...position, ...reading.value });
      } else if (reading.value.kind === "unavailable") {
        entries.push({ ...position, ...reading.value });
      }
    }
  }
  return { outcome: "parsed", entries, warnings };
};
