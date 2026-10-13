import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "@curio/core";
import { openStore } from "./core.ts";
import { dataDirectory } from "./data-directory.ts";
import { loadOrCreateToken } from "./token.ts";

interface Shared {
  store?: Store;
  token?: string;
}

// Kept on globalThis because Next evaluates this module once per server layer
// (pages, route handlers), and again on every edit in development. The
// process must still open the database once.
const shared = globalThis as typeof globalThis & { __curio?: Shared };

function state(): Shared {
  shared.__curio ??= {};
  return shared.__curio;
}

/** The process-wide store, opened on first use. */
export function sharedStore(): Store {
  const current = state();
  if (current.store === undefined) {
    // Private to this user when this app is what creates it.
    mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
    current.store = openStore(join(dataDirectory(), "bookmarks.db"));
  }
  return current.store;
}

/** The pairing token, created on first use. */
export function sharedToken(): string {
  const current = state();
  current.token ??= loadOrCreateToken(dataDirectory());
  return current.token;
}
