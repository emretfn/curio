import { expect, test } from "vitest";
import { headingFor, listRows, nextItemRow } from "./list-rows.ts";
import type { ItemView, PostView } from "./post-view.ts";

const post = (id: string, month: string): PostView =>
  ({
    kind: "post",
    id,
    month: { key: month, label: `Month ${month}` },
  }) as PostView;
const withheld = (id: string): ItemView => ({
  kind: "withheld",
  id,
  url: null,
});

const shape = (items: ItemView[], ranked = false) =>
  listRows(items, ranked).map((row) =>
    row.kind === "heading"
      ? row.label
      : row.kind === "note"
        ? "(note)"
        : `${row.item.id}#${row.position}`,
  );

test("a heading opens each month, and every item keeps its place among all of them", () => {
  expect(
    shape([post("a", "2026-10"), post("b", "2026-10"), post("c", "2026-09")]),
  ).toEqual(["Month 2026-10", "a#1", "b#2", "Month 2026-09", "c#3"]);
  expect(listRows([], false)).toEqual([]);
});

test("a search has one heading for all of it, whatever the months", () => {
  expect(
    shape(
      [post("a", "2026-10"), post("b", "2024-01"), post("c", "2026-10")],
      true,
    ),
  ).toEqual(["Best match first", "a#1", "b#2", "c#3"]);
});

test("the posts X withholds come under their own heading, with what they are said once", () => {
  expect(shape([post("a", "2026-10"), withheld("7"), withheld("6")])).toEqual([
    "Month 2026-10",
    "a#1",
    "Withheld by X, never captured",
    "(note)",
    "7#2",
    "6#3",
  ]);
});

test("a row's key is its own however many rows are loaded after it", () => {
  const first = [post("a", "2026-10"), post("b", "2026-09")];
  const keys = (items: ItemView[]) =>
    listRows(items, false).map(({ key }) => key);

  expect(
    keys([...first, post("c", "2026-09"), withheld("7")]).slice(0, 4),
  ).toEqual(keys(first));
  const all = keys([...first, withheld("7")]);
  expect(new Set(all).size).toBe(all.length);
});

test("the keyboard moves between items and passes over headings", () => {
  const rows = listRows(
    [post("a", "2026-10"), post("b", "2026-09"), withheld("7")],
    false,
  );
  // heading, a, heading, b, heading, note, 7

  expect(nextItemRow(rows, 1, 1)).toBe(3);
  expect(nextItemRow(rows, 3, 1)).toBe(6);
  expect(nextItemRow(rows, 6, 1)).toBe(-1);
  expect(nextItemRow(rows, 3, -1)).toBe(1);
  expect(nextItemRow(rows, 1, -1)).toBe(-1);
  expect(nextItemRow(rows, -1, 1)).toBe(1);
});

test("the heading kept on screen is the last one at or before the row at the top", () => {
  const rows = listRows(
    [post("a", "2026-10"), post("b", "2026-09"), post("c", "2026-09")],
    false,
  );
  // heading, a, heading, b, c

  expect(headingFor(rows, 0)).toBe(0);
  expect(headingFor(rows, 1)).toBe(0);
  expect(headingFor(rows, 2)).toBe(2);
  expect(headingFor(rows, 4)).toBe(2);
  expect(headingFor(rows, 99)).toBe(2);
  expect(headingFor([], 0)).toBe(-1);
});
