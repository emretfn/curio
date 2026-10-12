/**
 * The list's one request: the next page of the library, from this app, by a
 * relative address. It is kept in a file of its own so that the only code in
 * the browser that asks a server for data is these few lines.
 */
import type { LibraryPageAnswer } from "@/server/library-page";

/**
 * `search` is the page's own query string, without the `?`. `limit` asks for
 * a longer page than usual, for a reader returning to a place far down the
 * list; the app caps it.
 */
export async function loadMore(
  search: string,
  after: string,
  limit?: number,
): Promise<LibraryPageAnswer> {
  const query = new URLSearchParams(search);
  query.set("after", after);
  if (limit !== undefined) query.set("limit", String(limit));
  const response = await fetch(`/api/library?${query}`, {
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`The library answered ${response.status}.`);
  }
  return (await response.json()) as LibraryPageAnswer;
}
