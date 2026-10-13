/**
 * A week written out for a reader, in English and in the server's time
 * zone, like every other date the app shows. A week is core's: seven local
 * days from a Monday. These only word it.
 */
const LOCALE = "en-GB";
const day = new Intl.DateTimeFormat(LOCALE, { day: "numeric" });
const dayMonth = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "long",
});
const dayMonthYear = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const dayShortMonth = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
});
const weekday = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** A week's Sunday, from its Monday. */
const sundayOf = (monday: Date) =>
  new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

/**
 * `5–11 October 2026`. Across a month's end, `28 September – 4 October
 * 2026`, and across a year's, both years.
 */
export function weekRange(monday: Date): string {
  const sunday = sundayOf(monday);
  if (monday.getFullYear() !== sunday.getFullYear()) {
    return `${dayMonthYear.format(monday)} – ${dayMonthYear.format(sunday)}`;
  }
  if (monday.getMonth() !== sunday.getMonth()) {
    return `${dayMonth.format(monday)} – ${dayMonthYear.format(sunday)}`;
  }
  return `${day.format(monday)}–${dayMonthYear.format(sunday)}`;
}

/** `5–11 Oct`, or `28 Sep – 4 Oct`: a week in a list of weeks, under its year. */
export function weekRangeShort(monday: Date): string {
  const sunday = sundayOf(monday);
  return monday.getMonth() === sunday.getMonth()
    ? `${day.format(monday)}–${dayShortMonth.format(sunday)}`
    : `${dayShortMonth.format(monday)} – ${dayShortMonth.format(sunday)}`;
}

/** `Monday 5 October`: a day of a week, as a heading over what was saved on it. */
export function dayHeading(date: Date): string {
  // en-GB writes "Monday 5 October" with no comma in current engines, and
  // "Monday, 5 October" in some: the comma is dropped either way.
  return weekday.format(date).replace(",", "");
}

/** A local day as `YYYY-MM-DD`, for grouping and for `<time dateTime>`. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
