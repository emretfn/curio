/**
 * How the tagging stands, at `GET /api/tagging`: whether the owner has let
 * the app tag by itself, what the app's last pass came to, and how many
 * bookmarks are classified, waiting or failed. Counts, times, money and
 * messages fit to show; never a bookmark.
 *
 * It reads and never writes, and starts no pass. In particular it cannot
 * turn the app's tagging on: `appTagging` reports a line of a file the
 * owner edits by hand, and there is no request that changes it. Like every API route it
 * sits outside `src/proxy.ts`, so it makes the `Host` check itself; it sends
 * no CORS header, and a browser that says the request came from another
 * site is refused.
 */
import type { Store, TaggingSummary } from "@curio/core";
import { summariseTagging } from "./core.ts";
import { isLocalHost } from "./guard.ts";
import { appTagging, type TaggingStatus, taggingStatus } from "./tagging.ts";

export interface TaggingStatusAnswer extends TaggingStatus {
  /**
   * Whether the app tags by itself. Off unless the owner turned it on; the
   * message says how, and which commands do the same by hand.
   */
  appTagging: { on: boolean; message: string };
  library: Omit<TaggingSummary, "lastRun">;
}

function refusal(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export async function handleTaggingStatus(
  request: Request,
  store: Store,
  /** Reads the owner's setting. Replaced in tests. */
  setting: typeof appTagging = appTagging,
): Promise<Response> {
  if (!isLocalHost(request.headers.get("host"))) {
    return refusal(403, "This app answers only on its local address.");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return refusal(403, "Only the library's own page may read its status.");
  }
  const { lastRun, ...library } = summariseTagging(store);
  const { on, message } = await setting();
  const answer: TaggingStatusAnswer = {
    appTagging: { on, message },
    ...taggingStatus(),
    library,
  };
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}
