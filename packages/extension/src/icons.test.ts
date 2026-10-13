import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { shapesOf } from "./testing.ts";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url));
const manifest: {
  icons: Record<string, string>;
  action: { default_icon: Record<string, string> };
} = JSON.parse(read("manifest.json").toString());
const svg = read("icons/icon.svg").toString();

test("the manifest names an icon at each size Chrome asks for, and the toolbar uses two of them", () => {
  expect(Object.keys(manifest.icons)).toEqual(["16", "32", "48", "128"]);
  expect(manifest.action.default_icon).toEqual({
    "16": manifest.icons["16"],
    "32": manifest.icons["32"],
  });
});

test.each(Object.entries(manifest.icons))(
  "the %s-pixel icon is a PNG of that size, with transparency",
  (size, path) => {
    const png = read(path);

    expect(png.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(Number(size));
    expect(png.readUInt32BE(20)).toBe(Number(size));
    // Colour type 6: red, green, blue and alpha.
    expect(png[25]).toBe(6);
  },
);

test("the PNGs were rendered from the SVG as it stands", () => {
  expect(
    read("icons/rendered-from.sha256").toString().trim(),
    "icons/icon.svg has changed since the PNGs were rendered. Run `pnpm icons:build`.",
  ).toBe(createHash("sha256").update(svg).digest("hex"));
});

test("the web app's icon is the same file, so the tab and the toolbar match", () => {
  expect(
    read("../web/src/app/icon.svg").toString(),
    "packages/web/src/app/icon.svg is a copy of icons/icon.svg. Run `pnpm icons:build`.",
  ).toBe(svg);
});

test("the mark is drawn on whole units of a 16 grid, in three colours, with no letters", () => {
  const drawing = svg.replace(/<!--[\s\S]*?-->/g, "");

  expect(drawing).toContain('viewBox="0 0 16 16"');
  expect(drawing).not.toMatch(/<text|<tspan|font|<image|href|url\(/i);
  const shapes = shapesOf(drawing);
  expect(shapes.length).toBeGreaterThan(0);
  for (const shape of shapes) {
    expect(shape).toMatch(/^<rect /);
    // Every edge on a whole pixel of the 16-pixel icon: nothing blurs.
    for (const [, value] of shape.matchAll(
      / (?:x|y|width|height)="([^"]+)"/g,
    )) {
      expect(Number.isInteger(Number(value)), `${shape}: ${value}`).toBe(true);
    }
  }
  expect(
    new Set(shapes.map((shape) => /fill="([^"]+)"/.exec(shape)?.[1])).size,
  ).toBe(3);
});
