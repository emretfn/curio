/**
 * A library for tests: a temporary database holding core's redacted
 * fixtures, parsed as the app parses a capture. Real structure, invented
 * content, and nothing of anybody's bookmarks.
 */
import {
  type Bookmark,
  correctBookmark,
  insertRawCapture,
  listBookmarks,
  MAX_PAGE_SIZE,
  type NewClassification,
  parsePendingCaptures,
  recordClassification,
  type Store,
} from "@curio/core";
import { openTempStore, readFixture } from "@curio/core/testing";
import { CAPTURE_SOURCE } from "@curio/extension";
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
 * What the classifier is made to have said of the fixture library's first
 * bookmarks, newest first: a few categories and formats, the two kinds of
 * "other", an unclear format, and proposals under two spellings. The rest
 * of the library stays unclassified, and one of the rest is filed by the
 * owner alone. No model is asked: the answers are written through core, as
 * the classifier writes them.
 */
const ANSWERS: Omit<
  NewClassification,
  "postId" | "instructionsVersion" | "model"
>[] = [
  {
    category: "web-dev",
    format: "guide",
    tags: ["nextjs", "react"],
    proposedTags: ["server-actions"],
    tooLittleText: false,
  },
  {
    category: "web-dev",
    format: "tip",
    tags: ["react"],
    proposedTags: ["server-actions", "drizzle"],
    tooLittleText: false,
  },
  {
    category: "design",
    format: "showcase",
    tags: ["animation"],
    proposedTags: ["server-action"],
    tooLittleText: false,
  },
  { category: "other", format: "unclear", tags: [], tooLittleText: true },
  { category: "other", format: "discussion", tags: [], tooLittleText: false },
  {
    category: "tools",
    format: "unclear",
    tags: ["self-hosting"],
    tooLittleText: false,
  },
  {
    category: "ai-agents",
    format: "launch",
    tags: ["claude-code", "mcp"],
    tooLittleText: false,
  },
];

/** The fixture library with some of it filed. See `ANSWERS`. */
export interface FiledLibrary {
  store: Store;
  /** Every bookmark, newest first, as it stands after the filing. */
  bookmarks: Bookmark[];
  /** The bookmarks the classifier answered for, in the order of `ANSWERS`. */
  classified: Bookmark[];
  /** The one the owner filed, under "life", that the classifier never saw. */
  filedByOwner: Bookmark;
}

/** Files some of a library's bookmarks, as `ANSWERS` says. */
export function fileSomeBookmarks(store: Store): FiledLibrary {
  const before = listBookmarks(store, { limit: MAX_PAGE_SIZE }).bookmarks;
  if (before.length < ANSWERS.length + 3) {
    throw new Error("The library is too small to file part of it.");
  }
  ANSWERS.forEach((answer, index) => {
    recordClassification(store, {
      ...answer,
      postId: before[index]?.postId ?? "",
      instructionsVersion: 1,
      model: "a-model",
    });
  });
  correctBookmark(store, before[ANSWERS.length]?.postId ?? "", {
    category: "life",
  });
  const bookmarks = listBookmarks(store, { limit: MAX_PAGE_SIZE }).bookmarks;
  const filedByOwner = bookmarks[ANSWERS.length];
  if (filedByOwner === undefined) throw new Error("A bookmark went missing.");
  return {
    store,
    bookmarks,
    classified: bookmarks.slice(0, ANSWERS.length),
    filedByOwner,
  };
}

/** The fixture library, with some of it filed. */
export const openFiledLibrary = (): FiledLibrary =>
  fileSomeBookmarks(openFixtureLibrary());

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
