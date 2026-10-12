/**
 * What the library may load from X's media CDN, and when: X-7 to X-11 in
 * CODING_STANDARDS.md.
 *
 * A bookmark's photos, video posters, videos, link-card images and article
 * covers are hosted by X. Showing one means the owner's browser asks X's CDN
 * for it, so nothing is loaded until the owner asks:
 *
 * - by default no media loads, and a placeholder says what is there;
 * - "Show media" on a post loads that post's media and no other's;
 * - a setting, off by default and kept in this browser, loads media for the
 *   posts on screen as they come into view, and never ahead of that;
 * - avatars are never loaded;
 * - the server never requests, proxies or stores any of it.
 *
 * This file is the policy's data: the two hosts, the check a stored address
 * must pass before the browser is given it, and the Content-Security-Policy
 * that makes the browser refuse everything else.
 */

/**
 * The only hosts media is ever loaded from: X's image CDN and its video CDN.
 * A media address anywhere else is never given to the browser.
 */
export const X_MEDIA_HOSTS = {
  image: "pbs.twimg.com",
  video: "video.twimg.com",
} as const;

export type XMediaKind = keyof typeof X_MEDIA_HOSTS;

/**
 * A stored media address as one the browser may load when the owner asks, or
 * null unless it is HTTPS on the one host for its kind. A capture is data
 * from a web page, so a stored address is not trusted to be what its field
 * says.
 */
export function xMediaUrl(
  stored: string | null | undefined,
  kind: XMediaKind,
): string | null {
  if (stored === null || stored === undefined) return null;
  let url: URL;
  try {
    url = new URL(stored);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== X_MEDIA_HOSTS[kind] ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.href;
}

/**
 * The Content-Security-Policy every page is served with: the browser's half
 * of the policy. Whatever the markup says, an image or video from any host
 * but these two, a frame, an object, or a connection made by script to
 * anywhere but this app is refused before a request is made.
 *
 * There is no `default-src` and no `script-src`: Next's own inline scripts
 * would need a nonce on every request, and scripts are not how media loads.
 */
export function contentSecurityPolicy(): string {
  return [
    `img-src 'self' data: blob: https://${X_MEDIA_HOSTS.image}`,
    `media-src 'self' https://${X_MEDIA_HOSTS.video}`,
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Where this browser keeps the "load media automatically" setting. It is the
 * owner's choice in this browser, off unless the stored value is exactly
 * `on`, and the server never sees it.
 */
export const AUTO_MEDIA_STORAGE_KEY = "x-bookmarks:auto-media";

/**
 * How long a post's media must stay on screen before the automatic setting
 * loads it, so that scrolling past a post asks X for nothing.
 */
export const AUTO_MEDIA_DWELL_MS = 300;
