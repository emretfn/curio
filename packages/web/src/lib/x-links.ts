/**
 * Addresses on X, for links the owner clicks. Nothing here is requested by
 * the app: these become the `href` of a plain link that opens in a new tab,
 * which is the owner's own navigation ("Requests to X" in
 * CODING_STANDARDS.md).
 */

const DIGITS = /^[0-9]{1,20}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Where a post lives on X, or null when the id is not one. The handle is
 * decoration, X finds the post by id, so a handle that does not look like one
 * is replaced by X's own neutral path.
 */
export function postUrlOnX(postId: string, handle?: string): string | null {
  if (!DIGITS.test(postId)) return null;
  const owner = handle !== undefined && HANDLE.test(handle) ? handle : "i/web";
  return `https://x.com/${owner}/status/${postId}`;
}

/**
 * A stored link as an `href`, or null unless it is plain HTTP or HTTPS. A
 * capture is data from a web page: a `javascript:` address in one must never
 * become a link.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
