/**
 * A library for the classifier's tests: invented bookmarks in a temporary
 * database, and a key file beside it.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BookmarkSighting,
  getBookmark,
  insertRawCapture,
  type Store,
  upsertBookmark,
} from "@curio/core";
import { openTempStore, tempDatabasePath } from "@curio/core/testing";
import { APP_TAGGING_VARIABLE, ENV_FILE, KEY_VARIABLE } from "../api-key.ts";
import { FAKE_KEY } from "./fake-api.ts";

export const postId = (n: number) => String(1975000000000000000n + BigInt(n));

/** A text that says enough to be classified, and names its number. */
export const textOf = (n: number) =>
  `Bookmark number ${n}: a walkthrough of building and shipping a small web application.`;

export interface TestLibrary {
  store: Store;
  /** The directory that holds the database, and the `.env` file once `writeKey` has run. */
  directory: string;
  /** Where that `.env` file is, or would be. */
  envFile: string;
  path: string;
  /** Adds a bookmark numbered `n`, bookmarked `n` days into June 2026. */
  add(n: number, parts?: Partial<BookmarkSighting>): string;
  labels(n: number): NonNullable<ReturnType<typeof getBookmark>>["labels"];
}

/** A library of `count` bookmarks numbered from 1, each with text enough to classify. */
export function library(count = 0): TestLibrary {
  const path = tempDatabasePath();
  const store = openTempStore(path);
  const captureId = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: new Date("2026-10-05T09:00:00.000Z"),
  }).id;
  const made: TestLibrary = {
    store,
    directory: dirname(path),
    envFile: join(dirname(path), ENV_FILE),
    path,
    add(n, parts = {}) {
      upsertBookmark(store, {
        postId: postId(n),
        authorId: String(1000 + n),
        authorHandle: `author${n}`,
        authorName: `Author ${n}`,
        text: textOf(n),
        lang: "en",
        postedAt: new Date("2026-01-01T00:00:00.000Z"),
        sortIndex: String(BigInt(Date.UTC(2026, 5, n, 12)) << 20n),
        captureId,
        ...parts,
      });
      return postId(n);
    },
    labels(n) {
      const bookmark = getBookmark(store, postId(n));
      if (bookmark === undefined) throw new Error(`There is no bookmark ${n}.`);
      return bookmark.labels;
    },
  };
  for (let n = 1; n <= count; n += 1) made.add(n);
  return made;
}

/** The line of the `.env` file with which the owner lets the app tag by itself. */
export const APP_TAGGING_ON = `${APP_TAGGING_VARIABLE}=on\n`;

/**
 * Puts a `.env` file holding a key in `directory`, as the owner would: the
 * key under this project's variable, the file readable by its owner alone.
 * `appTagging` adds the line that lets the app tag by itself, which the
 * file does not hold otherwise. `content` writes something else in the
 * file's place.
 */
export function writeKey(
  directory: string,
  options: {
    key?: string;
    mode?: number;
    appTagging?: boolean;
    content?: string;
  } = {},
): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ENV_FILE);
  writeFileSync(
    path,
    options.content ??
      `${KEY_VARIABLE}=${options.key ?? FAKE_KEY}\n${options.appTagging === true ? APP_TAGGING_ON : ""}`,
    { mode: 0o600 },
  );
  chmodSync(path, options.mode ?? 0o600);
  return path;
}
