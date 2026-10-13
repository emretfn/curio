/**
 * A page of the library as the browser asks for it while scrolling: the
 * address bar's query string and a cursor in, item views out. The list's
 * first page is rendered with the screen; this serves the pages after it, at
 * `GET /api/library`.
 *
 * It reads and never writes, and takes nothing but its address. Like every
 * API route it sits outside `src/proxy.ts`, so it makes the `Host` check
 * itself. It sends no CORS header, so a page on another site cannot read an
 * answer; a browser that says the request came from another site is refused
 * all the same.
 */
import type { Store } from "@curio/core";
import { type ItemView, toItemView } from "../lib/post-view.ts";
import { isLocalHost } from "./guard.ts";
import { type LibraryPage, listLibrary } from "./library.ts";
import { parseLibraryParams, toLibraryQuery } from "./library-params.ts";

export interface LibraryPageAnswer {
  items: ItemView[];
  nextCursor: string | null;
  /** How many items the query matches now. Sent back as `seen` with the next page asked for. */
  total: number;
}

/** The three shapes `listLibrary` gives a cursor: by time, in a search, among the withheld. */
const CURSOR = /^(?:[0-9]{1,15}:[0-9]{1,15}|[sw]:[0-9]{1,9})$/;

const NOT_A_CURSOR = "The cursor is not one this app gave out.";

function refusal(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export function handleLibraryPage(request: Request, store: Store): Response {
  if (!isLocalHost(request.headers.get("host"))) {
    return refusal(403, "This app answers only on its local address.");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return refusal(403, "Only the library's own page may read the library.");
  }
  const search = new URL(request.url).searchParams;
  const after = search.get("after");
  if (after !== null && !CURSOR.test(after)) {
    return refusal(400, NOT_A_CURSOR);
  }
  // How many, when the page asks for more than the usual: a reader returning
  // to a place far down the list. `listLibrary` caps it.
  const asked = search.get("limit");
  if (asked !== null && !/^[1-9][0-9]{0,3}$/.test(asked)) {
    return refusal(400, "The limit is not a number of items.");
  }
  // How many items the reader's last page said there were. See `PageRequest.seen`.
  const seen = search.get("seen");
  if (seen !== null && !/^[0-9]{1,9}$/.test(seen)) {
    return refusal(400, "What was seen is not a number of items.");
  }
  const query = toLibraryQuery(parseLibraryParams(search));
  let page: LibraryPage;
  try {
    page = listLibrary(store, query, {
      after,
      limit: asked === null ? undefined : Number(asked),
      seen: seen === null ? undefined : Number(seen),
    });
  } catch (error) {
    // A cursor of the right shape that belongs to another kind of list.
    if (error instanceof RangeError) return refusal(400, NOT_A_CURSOR);
    throw error;
  }
  const answer: LibraryPageAnswer = {
    items: page.items.map((item) => toItemView(item, page.terms)),
    nextCursor: page.nextCursor,
    total: page.total,
  };
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}
