/**
 * Which hosts are X's own. Nothing in this project requests anything from
 * one of them: see "Requests to X" in CODING_STANDARDS.md.
 *
 * The account that made the bookmarks is what is at risk. Accounts have been
 * suspended over extensions that sent their own requests to X, and nothing
 * here is worth that: a detail a capture lacks stays missing.
 */

/**
 * The registrable domains X serves from. A host is X's when it is one of
 * these or a subdomain of one: `x.com`, `api.x.com`, `pbs.twimg.com` (media),
 * `t.co` (link redirects), `publish.twitter.com` (oEmbed),
 * `cdn.syndication.twimg.com` (embeds).
 */
export const X_OWNED_DOMAINS = [
  "x.com",
  "twitter.com",
  "t.co",
  "twimg.com",
  "twttr.com",
  "tweetdeck.com",
  "pscp.tv",
  "periscope.tv",
] as const;

export function isXOwnedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return X_OWNED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/** Thrown instead of letting a request to X happen. */
export class XOwnedHostError extends Error {
  constructor(reason: string) {
    super(
      `${reason} Nothing in Curio requests anything from X: the user's account is at risk. A detail a capture lacks stays missing.`,
    );
    this.name = "XOwnedHostError";
  }
}

/**
 * The guard for any code that requests a URL it did not write itself: a link
 * from a post, a card, an image. Returns the parsed URL when its host is not
 * X's, and throws otherwise, or when the URL cannot be read, since what
 * cannot be read cannot be shown to be safe.
 *
 * A redirect is a new request. Whoever follows one calls this again for
 * where it leads, so request with redirects switched off.
 */
export function assertNotXOwnedUrl(url: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XOwnedHostError(
      "A URL that cannot be parsed was about to be requested.",
    );
  }
  if (isXOwnedHost(parsed.hostname)) {
    throw new XOwnedHostError(
      "A URL on one of X's own hosts was about to be requested.",
    );
  }
  return parsed;
}
