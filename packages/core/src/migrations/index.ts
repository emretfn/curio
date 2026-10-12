import type { Migration } from "../migrate.ts";
import { migration as init } from "./0001-init.ts";
import { migration as captureKeyAndRequestBody } from "./0002-capture-key-and-request-body.ts";
import { migration as parsedBookmarks } from "./0003-parsed-bookmarks.ts";
import { migration as bookmarkMutations } from "./0004-bookmark-mutations.ts";
import { migration as searchIndex } from "./0005-search-index.ts";

/** Every migration, in the order it is applied. Append only. */
export const migrations: readonly Migration[] = [
  init,
  captureKeyAndRequestBody,
  parsedBookmarks,
  bookmarkMutations,
  searchIndex,
];
