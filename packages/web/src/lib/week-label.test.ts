import { expect, test } from "vitest";
import { dayHeading, dayKey, weekRange, weekRangeShort } from "./week-label.ts";

// Mondays, built from local parts as a week's start is.
const monday = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day);

test("a week inside one month is written as two days of it", () => {
  expect(weekRange(monday(2026, 10, 5))).toBe("5–11 October 2026");
  expect(weekRangeShort(monday(2026, 10, 5))).toBe("5–11 Oct");
});

test("a week across a month's end names both months, and across a year's end both years", () => {
  expect(weekRange(monday(2026, 9, 28))).toBe("28 September – 4 October 2026");
  expect(weekRangeShort(monday(2026, 9, 28))).toMatch(/^28 Sept? – 4 Oct$/);
  expect(weekRange(monday(2026, 12, 28))).toBe(
    "28 December 2026 – 3 January 2027",
  );
  expect(weekRangeShort(monday(2026, 12, 28))).toBe("28 Dec – 3 Jan");
});

test("a day is headed by its weekday and date, and keyed by its local date", () => {
  const evening = new Date(2026, 9, 5, 23, 30);

  expect(dayHeading(evening)).toBe("Monday 5 October");
  expect(dayKey(evening)).toBe("2026-10-05");
  expect(dayKey(new Date(2026, 0, 9, 0, 0))).toBe("2026-01-09");
});
