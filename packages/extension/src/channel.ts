import type { HookEvent } from "./protocol.ts";

/** The DOM event that carries a `HookEvent`, as JSON text, from the page hook to the relay. */
export const HOOK_EVENT = "curio:hook";

/**
 * Whether the app has shown that it holds the extension's token.
 * `unconfirmed`: a token is saved and the app has not answered since.
 * `refused`: something answered on the app's port without proving it.
 */
export type Pairing = "none" | "unconfirmed" | "paired" | "refused";

/**
 * What a recorded error is about, so that the popup can say what to do next
 * without reading the error's prose.
 * - `not-paired`: captures are waiting and no token is saved.
 * - `app-unreachable`: nothing answered at the app's address.
 * - `app-unproven`: something answered without proving it holds the token.
 * - `capture-refused`: the app would not accept a capture.
 * - `capture-unconfirmed`: the app answered without confirming a capture.
 * - `not-captured`: an allowlisted response could not be taken from the page.
 */
export type Trouble =
  | "not-paired"
  | "app-unreachable"
  | "app-unproven"
  | "capture-refused"
  | "capture-unconfirmed"
  | "not-captured";

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
  /**
   * The most recent thing that went wrong. `trouble` is null for an error an
   * earlier version of the extension stored without saying what it was about.
   */
  lastError: { at: number; message: string; trouble: Trouble | null } | null;
}

/** Messages to the service worker, from the relay and from the popup. */
export type Message =
  | { type: "hook-event"; event: HookEvent }
  | { type: "get-status" }
  | { type: "set-token"; token: string }
  | { type: "check-pairing" }
  | { type: "deliver-now" };
