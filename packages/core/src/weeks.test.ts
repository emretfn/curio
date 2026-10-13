import { expect, test } from "vitest";
import {
  lastDayOf,
  latestWeekEnded,
  WEEK_ENDS_SUNDAY_AT_HOUR,
  weekAfter,
  weekBefore,
  weekFromKey,
  weekOf,
} from "./weeks.ts";

// Every time here is built from local parts, so the tests mean the same in
// any time zone they are run in. 5 October 2026 is a Monday.
const local = (day: number, hour = 0, minute = 0) =>
  new Date(2026, 9, day, hour, minute);

test("a week runs from Monday's midnight to the next Monday's, and is named by its Monday", () => {
  const week = weekOf(local(7, 15, 30));

  expect(week.key).toBe("2026-10-05");
  expect(week.start).toEqual(local(5));
  expect(week.end).toEqual(local(12));
  expect(lastDayOf(week)).toEqual(local(11));
});

test("Monday's first moment opens a week and Sunday's last one closes it", () => {
  expect(weekOf(local(5)).key).toBe("2026-10-05");
  expect(weekOf(local(11, 23, 59)).key).toBe("2026-10-05");
  expect(weekOf(new Date(local(5).getTime() - 1)).key).toBe("2026-09-28");
  expect(weekOf(local(12)).key).toBe("2026-10-12");
});

test("every moment of a week is at or after its start and before its end", () => {
  for (let day = 1; day <= 31; day += 1) {
    for (const hour of [0, 3, 12, 23]) {
      const at = local(day, hour);
      const week = weekOf(at);
      expect(week.start.getDay()).toBe(1);
      expect(week.start.getTime()).toBeLessThanOrEqual(at.getTime());
      expect(week.end.getTime()).toBeGreaterThan(at.getTime());
    }
  }
});

test("a week's name leads back to the same week, and nothing else is a week's name", () => {
  expect(weekFromKey("2026-10-05")).toEqual(weekOf(local(8)));
  for (const text of [
    "2026-10-06", // a Tuesday
    "2026-10-11", // a Sunday
    "2026-02-30", // no such day
    "2026-13-01",
    "2026-10-5",
    "26-10-05",
    "2026-10-05T00:00:00",
    " 2026-10-05",
    "last week",
    "",
  ]) {
    expect(weekFromKey(text), text).toBeUndefined();
  }
});

test("the weeks before and after are seven days away, across a month's end and a year's", () => {
  const week = weekOf(local(5));

  expect(weekBefore(week).key).toBe("2026-09-28");
  expect(weekAfter(week).key).toBe("2026-10-12");
  expect(weekAfter(weekBefore(week))).toEqual(week);
  // 28 December 2026 is a Monday; the week after it begins in 2027.
  const last = weekFromKey("2026-12-28");
  expect(last).toBeDefined();
  if (last !== undefined) {
    expect(weekAfter(last).key).toBe("2027-01-04");
    expect(weekBefore(weekAfter(last))).toEqual(last);
  }
});

test("a week ends at a midnight even where the clocks change inside it", () => {
  // Whatever this computer's zone does in late March and late October, a
  // week's bounds are midnights seven calendar days apart.
  for (const key of ["2026-03-02", "2026-03-23", "2026-10-19", "2026-11-02"]) {
    const week = weekFromKey(key);
    expect(week, key).toBeDefined();
    if (week === undefined) continue;
    const hours = (week.end.getTime() - week.start.getTime()) / 3_600_000;
    expect(week.end.getDay(), key).toBe(1);
    expect(week.end.getHours(), key).toBe(week.start.getHours());
    expect([167, 168, 169], key).toContain(hours);
    expect(weekAfter(week).start, key).toEqual(week.end);
  }
});

test("the week a digest is for is the one that last reached its Sunday evening", () => {
  const evening = WEEK_ENDS_SUNDAY_AT_HOUR;

  // Through the week, and on Sunday until the evening, it is the week before.
  expect(latestWeekEnded(local(5, 8)).key).toBe("2026-09-28");
  expect(latestWeekEnded(local(8, 12)).key).toBe("2026-09-28");
  expect(latestWeekEnded(local(11, evening - 1, 59)).key).toBe("2026-09-28");
  // From Sunday evening it is the week then ending, and stays so on Monday.
  expect(latestWeekEnded(local(11, evening)).key).toBe("2026-10-05");
  expect(latestWeekEnded(local(11, 23, 59)).key).toBe("2026-10-05");
  expect(latestWeekEnded(local(12, 7)).key).toBe("2026-10-05");
});

test("a time that is not one has no week", () => {
  expect(() => weekOf(new Date(Number.NaN))).toThrow(RangeError);
});
