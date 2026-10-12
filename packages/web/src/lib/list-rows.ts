/**
 * The library list as the rows it is drawn in: a heading where a month
 * begins, then that month's posts. The list is long and only the rows near
 * the screen are in the page at any time, so every row has a place in one
 * flat order and a key that stays its own as more are loaded.
 */
import type { ItemView, PostView, WithheldView } from "./post-view.ts";

export type ListRow =
  | { kind: "heading"; key: string; label: string }
  /** What the posts X withholds are, said once above them. */
  | { kind: "note"; key: string }
  /** `position` is the item's place among all the items, from 1. */
  | { kind: "post"; key: string; item: PostView; position: number }
  | { kind: "withheld"; key: string; item: WithheldView; position: number };

const WITHHELD = { key: "withheld", label: "Withheld by X, never captured" };
const RANKED = { key: "ranked", label: "Best match first" };

/**
 * Items under the month they were saved in. Posts X withholds have no time
 * and come under a heading of their own, and a search is in the order of its
 * matches, not of time, under one heading for all of it.
 */
export function listRows(
  items: readonly ItemView[],
  ranked: boolean,
): ListRow[] {
  const rows: ListRow[] = [];
  let group: string | undefined;
  items.forEach((item, index) => {
    const heading =
      item.kind !== "post" ? WITHHELD : ranked ? RANKED : item.month;
    if (heading.key !== group) {
      group = heading.key;
      rows.push({
        kind: "heading",
        key: `heading:${heading.key}`,
        label: heading.label,
      });
      if (item.kind !== "post") rows.push({ kind: "note", key: "note" });
    }
    rows.push(
      item.kind === "post"
        ? { kind: "post", key: `post:${item.id}`, item, position: index + 1 }
        : {
            kind: "withheld",
            key: `withheld:${item.id}`,
            item,
            position: index + 1,
          },
    );
  });
  return rows;
}

/** Whether a row is one the reader moves between with the keyboard. */
export const isItemRow = (row: ListRow | undefined): boolean =>
  row?.kind === "post" || row?.kind === "withheld";

/**
 * The next item row from `from` in a direction, passing over headings, or
 * -1 when the list ends first.
 */
export function nextItemRow(
  rows: readonly ListRow[],
  from: number,
  step: 1 | -1,
): number {
  for (
    let index = from + step;
    index >= 0 && index < rows.length;
    index += step
  ) {
    if (isItemRow(rows[index])) return index;
  }
  return -1;
}

/**
 * The heading that stays at the top of the screen: the last one at or
 * before row `index`, or -1 when there is none.
 */
export function headingFor(rows: readonly ListRow[], index: number): number {
  for (let at = Math.min(index, rows.length - 1); at >= 0; at -= 1) {
    if (rows[at]?.kind === "heading") return at;
  }
  return -1;
}
