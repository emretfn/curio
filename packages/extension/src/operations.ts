/**
 * Which of the page's requests are captured. Kept apart from the rest of the
 * protocol so that the script injected into X's page holds this and nothing
 * else.
 */

/**
 * The GraphQL operations whose payloads are kept. This list is the only place
 * they are named: the page hook, the service worker and the app's ingest
 * endpoint all check against it, and nothing else X's page loads is read.
 */
export const CAPTURED_OPERATIONS = [
  "Bookmarks",
  "BookmarkFolderTimeline",
  "BookmarkFoldersSlice",
  "CreateBookmark",
  "DeleteBookmark",
] as const;

export type CapturedOperation = (typeof CAPTURED_OPERATIONS)[number];

export function isCapturedOperation(name: unknown): name is CapturedOperation {
  return (CAPTURED_OPERATIONS as readonly unknown[]).includes(name);
}

const GRAPHQL_PATH = /\/graphql\/[^/]+\/([^/]+)$/;

/**
 * The allowlisted operation a request URL belongs to, or undefined for every
 * other request. X's web client calls `/i/api/graphql/<query id>/<Operation>`;
 * the query id rotates, so only the host and the operation name are matched.
 */
export function capturedOperationOf(
  url: string,
  base?: string,
): CapturedOperation | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.hostname !== "x.com" && !parsed.hostname.endsWith(".x.com")) {
    return undefined;
  }
  const name = GRAPHQL_PATH.exec(parsed.pathname)?.[1];
  return isCapturedOperation(name) ? name : undefined;
}
