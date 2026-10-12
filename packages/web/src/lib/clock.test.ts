import { expect, test } from "vitest";
import { clock } from "./clock.ts";

test.each([
  [0, "0:00"],
  [7, "0:07"],
  [65.9, "1:05"],
  [600, "10:00"],
  [3723, "1:02:03"],
  [-4, "0:00"],
  [Number.NaN, "0:00"],
  [Number.POSITIVE_INFINITY, "0:00"],
])("%s seconds reads %s", (seconds, shown) => {
  expect(clock(seconds)).toBe(shown);
});
