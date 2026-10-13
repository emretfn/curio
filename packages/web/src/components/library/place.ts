/**
 * Where the reader was in a list, kept for the page's own entry in the
 * browser's history, so that a reload, or Back to it, returns there.
 *
 * It holds how many items were loaded, how far the page was scrolled and
 * what each row measured: positions and numbers, and nothing of a post. It
 * is kept in this tab's session storage under the history entry's key, which
 * the browser keeps through a reload and gives back on Back and Forward; a
 * visit by a link is a new entry and starts at the top. A browser that has
 * no such key keeps no place.
 */
import type { VirtualItem } from "@tanstack/react-virtual";

export interface Place {
  /** The page's query string: a place belongs to one list. */
  search: string;
  /** How many items the list held. */
  loaded: number;
  /** How far down the page was scrolled, in pixels. */
  offset: number;
  /** What the rows that were drawn measured. */
  sizes: VirtualItem[];
}

/**
 * Where the place of the history entry the page is at now is kept, or null
 * in a browser that does not name its entries.
 */
export function placeKey(): string | null {
  if (typeof window === "undefined") return null;
  const entry = (
    window as { navigation?: { currentEntry?: { key?: string } | null } }
  ).navigation?.currentEntry;
  return typeof entry?.key === "string" ? `curio:place:${entry.key}` : null;
}

export function readPlace(search: string): Place | null {
  try {
    const key = placeKey();
    const stored: unknown =
      key === null
        ? null
        : JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    if (typeof stored !== "object" || stored === null) return null;
    const place = stored as Partial<Place>;
    return place.search === search &&
      typeof place.loaded === "number" &&
      typeof place.offset === "number" &&
      Array.isArray(place.sizes)
      ? (place as Place)
      : null;
  } catch {
    // Storage refused, or holds something else: no place.
    return null;
  }
}

/** Keeps a place under `key`, as `placeKey()` gave it when the list was shown. */
export function writePlace(key: string, place: Place): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(place));
  } catch {
    // Storage refused or full: the place is not kept.
  }
}
