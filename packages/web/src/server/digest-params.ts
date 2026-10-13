/**
 * The digest's address bar: which week `/digest` shows, and the addresses
 * the digest links to.
 *
 *   /digest                  the week that last reached its Sunday evening
 *   /digest?week=2026-10-05  the week of that Monday; any day of a week
 *                            names it
 */
import type { Week } from "@x-bookmarks/core";
import { latestWeekEnded, weekOf } from "./core.ts";
import { libraryHref, NO_PARAMS } from "./library-params.ts";

const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/**
 * The week an address asks for. A `week` that is no day at all is dropped,
 * never trusted, and the page shows the week it would show with none.
 */
export function parseDigestWeek(
  input: Record<string, string | string[] | undefined>,
  now: Date,
): Week {
  const value = Array.isArray(input.week) ? input.week[0] : input.week;
  const [, year, month, day] = DAY.exec(value ?? "") ?? [];
  if (year !== undefined && Number(year) >= 2006) {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    // A date that does not exist rolls over to another: 30 February is none.
    if (
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day)
    ) {
      return weekOf(date);
    }
  }
  return latestWeekEnded(now);
}

/** The address of a week's digest. */
export function digestHref(week: Week): string {
  return `/digest?week=${week.key}`;
}

/**
 * Where the digest leads in the library. Each is a filter of core's query
 * functions, written as the library's own address bar writes it
 * (`libraryHref`), so the digest and the screen it leads to ask core the
 * same question and there is one spelling of each filter. This is the one
 * place the digest writes them.
 */
export const LIBRARY_LINKS = {
  /** Every bookmark that said enough and fitted no category. */
  fittedNoCategory: (other: string) =>
    libraryHref({ ...NO_PARAMS, cat: other, text: "enough" }),
  /** The bookmarks a tag was proposed for. */
  proposedTag: (proposal: string) =>
    libraryHref({ ...NO_PARAMS, proposed: proposal }),
  /** The bookmarks filed under a category, of a format, or with a tag. */
  category: (category: string) => libraryHref({ ...NO_PARAMS, cat: category }),
  format: (format: string) => libraryHref({ ...NO_PARAMS, fmt: format }),
  tag: (tag: string) => libraryHref({ ...NO_PARAMS, tag: [tag] }),
} as const;
