import type { HookEvent } from "./protocol.ts";

/** The DOM event that carries a `HookEvent`, as JSON text, from the page hook to the relay. */
export const HOOK_EVENT = "x-bookmarks:hook";

/**
 * Whether the app has shown that it holds the extension's token.
 * `unconfirmed`: a token is saved and the app has not answered since.
 * `refused`: something answered on the app's port without proving it.
 */
export type Pairing = "none" | "unconfirmed" | "paired" | "refused";

/** What the service worker reports to the popup. */
export interface Status {
  pairing: Pairing;
  /** Captures taken since the extension was installed. */
  captured: number;
  /** Captures the app has acknowledged. */
  delivered: number;
  /** Captures waiting for the app. */
  pending: number;
  /** Captures the app has refused. They stay in the extension. */
  rejected: number;
  lastCapturedAt: number | null;
  lastDeliveredAt: number | null;
  lastError: { at: number; message: string } | null;
}

/** Messages to the service worker, from the relay and from the popup. */
export type Message =
  | { type: "hook-event"; event: HookEvent }
  | { type: "get-status" }
  | { type: "set-token"; token: string }
  | { type: "deliver-now" };
