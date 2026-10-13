/**
 * How the tagging stands, at `GET /api/tagging`: what the app's last pass
 * came to, and how many bookmarks are classified, waiting or failed. Counts,
 * times, money and a message fit to show; never a bookmark.
 *
 * It reads and never writes, and starts no pass. Like every API route it
 * sits outside `src/proxy.ts`, so it makes the `Host` check itself; it sends
 * no CORS header, and a browser that says the request came from another
 * site is refused.
 */
import type { Store, TaggingSummary } from "@x-bookmarks/core";
import { summariseTagging } from "./core.ts";
import { isLocalHost } from "./guard.ts";
import { type TaggingStatus, taggingStatus } from "./tagging.ts";

export interface TaggingStatusAnswer extends TaggingStatus {
  library: Omit<TaggingSummary, "lastRun">;
}

function refusal(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export function handleTaggingStatus(request: Request, store: Store): Response {
  if (!isLocalHost(request.headers.get("host"))) {
    return refusal(403, "This app answers only on its local address.");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return refusal(403, "Only the library's own page may read its status.");
  }
  const { lastRun, ...library } = summariseTagging(store);
  const answer: TaggingStatusAnswer = { ...taggingStatus(), library };
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}
