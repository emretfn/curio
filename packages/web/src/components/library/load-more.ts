/**
 * The list's one request: the next page of the library, from this app, by a
 * relative address. It is kept in a file of its own so that the only code in
 * the browser that asks a server for data is these few lines.
 */
import type { LibraryPageAnswer } from "@/server/library-page";

/**
 * The address of a list's next page. `search` is the page's own query
 * string, without the `?`. `limit` asks for a longer page than usual, for a
 * reader returning to a place far down the list; the app caps it. `seen` is
 * how many items the last page said the list had, which is how a search
 * keeps its place when matches have left it since.
 */
export function nextPageAddress(
  search: string,
  after: string,
  more: { limit?: number | undefined; seen?: number | undefined } = {},
): string {
  const query = new URLSearchParams(search);
  query.set("after", after);
  if (more.limit !== undefined) query.set("limit", String(more.limit));
  if (more.seen !== undefined) query.set("seen", String(more.seen));
  return `/api/library?${query}`;
}

export async function loadMore(
  search: string,
  after: string,
  more: { limit?: number | undefined; seen?: number | undefined } = {},
): Promise<LibraryPageAnswer> {
  const response = await fetch(nextPageAddress(search, after, more), {
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`The library answered ${response.status}.`);
  }
  return (await response.json()) as LibraryPageAnswer;
}
