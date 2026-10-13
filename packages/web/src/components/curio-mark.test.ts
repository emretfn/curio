import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

/** A drawing's shapes, one string each, however they are spaced and indented. */
const shapesOf = (markup: string) =>
  (markup.match(/<rect\b[^>]*>/g) ?? []).map((shape) =>
    shape.replace(/\s+/g, " ").replace(/ ?\/?>$/, ""),
  );

test("the mark beside the app's name is the app's icon, shape for shape", () => {
  const icon = shapesOf(
    read("../app/icon.svg").replace(/<!--[\s\S]*?-->/g, ""),
  );

  expect(icon.length).toBeGreaterThan(0);
  expect(shapesOf(read("./curio-mark.tsx"))).toEqual(icon);
});
