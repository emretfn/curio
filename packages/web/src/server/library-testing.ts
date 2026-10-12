/**
 * A library for tests: a temporary database holding core's redacted
 * fixtures, parsed as the app parses a capture. Real structure, invented
 * content, and nothing of anybody's bookmarks.
 */
import {
  insertRawCapture,
  listBookmarks,
  MAX_PAGE_SIZE,
  parsePendingCaptures,
  type Store,
} from "@x-bookmarks/core";
import { openTempStore, readFixture } from "@x-bookmarks/core/testing";
import { CAPTURE_SOURCE } from "@x-bookmarks/extension";
import type { BackupStatus } from "./backups.ts";

/** Every `Bookmarks` fixture, by what it shows. */
export const BOOKMARKS_FIXTURES = [
  "animated-gif",
  "cards-not-read-yet",
  "end-of-list",
  "links-and-cards",
  "long-posts",
  "media",
  "no-view-count",
  "quoted-posts",
  "shared-media",
  "summary-cards",
  "text-posts",
  "visibility-wrapper",
  "withheld-posts",
] as const;

export function bookmarksFixture(
  name: (typeof BOOKMARKS_FIXTURES)[number],
): string {
  return readFixture(`x-web-client/Bookmarks/2026-10-12-${name}.json`);
}

/**
 * Stores one response as a capture from the extension. It is not parsed yet.
 * `more` is the rest of the capture: a time it was received, or the body of
 * the request it answered.
 */
export function storeCapture(
  store: Store,
  payload: string,
  operation = "Bookmarks",
  more: { receivedAt?: Date; requestBody?: string } = {},
): number {
  return insertRawCapture(store, {
    source: CAPTURE_SOURCE,
    operation,
    payload,
    ...more,
  }).id;
}

/** What the app reports of its backups before it has looked, with nothing wrong. */
export const BACKUPS_WELL: BackupStatus = {
  directory: "/somewhere/else",
  snapshots: 0,
  latest: null,
  lastAttempt: null,
  unreadable: null,
};

/** A store holding every fixture, parsed. Closed and removed when the test ends. */
export function openFixtureLibrary(): Store {
  const store = openTempStore();
  for (const name of BOOKMARKS_FIXTURES) {
    storeCapture(store, bookmarksFixture(name));
  }
  parsePendingCaptures(store);
  return store;
}

/**
 * The word of the library's text that the most posts hold, for a search
 * with many matches. The fixtures' text is invented, so no word can be
 * written into a test.
 */
export function commonWord(store: Store): string {
  const holders = new Map<string, number>();
  for (const { text } of listBookmarks(store, { limit: MAX_PAGE_SIZE })
    .bookmarks) {
    for (const word of new Set(text.toLowerCase().match(/\b[a-z]{4,}\b/g))) {
      holders.set(word, (holders.get(word) ?? 0) + 1);
    }
  }
  const [word] = [...holders].sort(([, a], [, b]) => b - a)[0] ?? [];
  if (word === undefined) throw new Error("The library holds no word.");
  return word;
}
