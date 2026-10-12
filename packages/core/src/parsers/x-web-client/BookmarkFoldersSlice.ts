/**
 * Parses a `BookmarkFoldersSlice` response of X's web client: the list of the
 * account's bookmark folders.
 *
 * The only real sample so far is from an account with no folders, so the one
 * shape understood is the empty list. A response that lists folders is
 * reported as not understood, which is the cue to add a fixture of it and
 * read the folders here.
 */
import type { CaptureParser } from "../parsed.ts";
import { attempt, descend, items, rootNode, ShapeError } from "../shape.ts";

export const parseBookmarkFoldersSlice: CaptureParser = (payload) => {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return {
      outcome: "failed",
      issue: { code: "not-json", path: "$", detail: "the payload is not JSON" },
    };
  }
  const read = attempt(() => {
    const folders = descend(
      rootNode(json),
      "data",
      "viewer",
      "user_results",
      "result",
      "bookmark_collections_slice",
      "items",
    );
    if (items(folders).length > 0) {
      throw new ShapeError({
        code: "unsupported-content",
        path: folders.path,
        detail:
          "the response lists bookmark folders, and no parser reads folders yet",
      });
    }
  });
  return read.ok
    ? { outcome: "parsed", entries: [], warnings: [] }
    : { outcome: "failed", issue: read.issue };
};
