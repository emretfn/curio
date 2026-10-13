import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { paddingClearOf } from "./popup-padding.ts";

test("a popup stays out of the band the page keeps clear at its top, and near the other edges", () => {
  expect(paddingClearOf("64px")).toEqual({
    top: 64,
    right: 5,
    bottom: 5,
    left: 5,
  });
  expect(paddingClearOf("71.5px").top).toBe(71.5);
  // A page that keeps no band, or a smaller one than a popup keeps anyway.
  for (const none of ["auto", "", "0px", "3px"]) {
    expect(paddingClearOf(none).top).toBe(5);
  }
});

test("the page still keeps that band, and every popup that takes the keyboard is placed clear of it", () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");

  expect(read("../app/globals.css")).toMatch(
    /html \{[^}]*scroll-padding-block-start: calc\(var\(--header-height\) \+ 0\.5rem\);/,
  );
  for (const popup of ["dropdown-menu.tsx", "combobox.tsx"]) {
    const source = read(`../components/ui/${popup}`);
    const positioners = source.match(/Primitive\.Positioner\b(?!\.)/g) ?? [];
    expect(positioners.length, popup).toBeGreaterThan(0);
    expect(
      source.match(/collisionPadding=\{padding\}/g)?.length,
      `${popup}: every positioner keeps out of the band`,
    ).toBe(positioners.length / 2);
  }
});
