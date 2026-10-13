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

test("the mark is a tile, a C and a dot, drawn as shapes on a 16 grid and needing no font", () => {
  const drawing = svg.replace(/<!--[\s\S]*?-->/g, "");

  expect(drawing).toContain('viewBox="0 0 16 16"');
  // The C is a path, not type: it looks the same wherever it is drawn.
  expect(drawing).not.toMatch(/<text|<tspan|font|<image|href|url\(/i);
  const [tile, c, dot, ...more] = shapesOf(drawing);
  expect(more).toEqual([]);

  // The tile fills the box, so the same file serves a light toolbar and a dark one.
  expect(tile).toBe('<rect width="16" height="16" rx="4" fill="#171717"');
  // A ring from 6 units out to 4, about the centre, open to the right
  // between y 6 and y 10: where it crosses the axes it falls on whole
  // pixels of the 16-pixel icon.
  expect(c).toBe(
    '<path d="M13.657 6A6 6 0 1 0 13.657 10H11.464A4 4 0 1 1 11.464 6Z" fill="#fafafa"',
  );
  for (const [radius, reach] of [
    [6, 13.657],
    [4, 11.464],
  ] as const) {
    // Each end of the opening is on its circle, 2 above or below the centre.
    expect(Math.hypot(reach - 8, 2)).toBeCloseTo(radius, 2);
  }
  // The dot is as wide as the opening it sits behind.
  expect(dot).toBe('<circle cx="8" cy="8" r="2" fill="#fcdd5b"');
});
