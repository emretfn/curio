/**
 * The week, as the weekly digest and everything that links to it means it:
 * seven days from a Monday's midnight to the next Monday's, in this
 * process's time zone, taken over a bookmark's `bookmarkedAt` (READ-2).
 *
 * A week is named by the date of its Monday, `2026-10-05`. That name is
 * what an address, a command and a stored digest carry; the two moments
 * that bound it are worked out from the name wherever it is read, so a
 * week means the same seven local days whatever the clocks did in between.
 *
 * Nothing here reads a database or a clock: `now` is always an argument.
 */

/** Seven local days, from a Monday's midnight up to the next Monday's. */
export interface Week {
  /** The date of the Monday the week begins on, as `YYYY-MM-DD`. */
  key: string;
  /** The first moment of the week. */
  start: Date;
  /** The first moment after it: the next week's `start`. */
  end: Date;
}

/**
 * The hour on Sunday, on this computer's clock, from which the week then
 * ending is the one a digest is for. Before it, the latest whole week is
 * the one before: on a Monday morning "this week's digest" is last week's.
 */
export const WEEK_ENDS_SUNDAY_AT_HOUR = 18;

const KEY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

const two = (value: number) => String(value).padStart(2, "0");

/** The week that begins on the local day `year`-`month`-`day`, which is a Monday. */
function weekStarting(year: number, month: number, day: number): Week {
  const start = new Date(year, month, day);
  return {
    key: `${String(start.getFullYear()).padStart(4, "0")}-${two(start.getMonth() + 1)}-${two(start.getDate())}`,
    start,
    // Seven calendar days on, not 168 hours: a week in which the clocks
    // change is an hour shorter or longer, and still ends at midnight.
    end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7),
  };
}

/** The week a moment falls in. */
export function weekOf(at: Date): Week {
  if (Number.isNaN(at.getTime())) {
    throw new RangeError("A week was asked for of a time that is not one.");
  }
  // Days since Monday: getDay() counts from Sunday.
  const sinceMonday = (at.getDay() + 6) % 7;
  return weekStarting(
    at.getFullYear(),
    at.getMonth(),
    at.getDate() - sinceMonday,
  );
}

/**
 * The week a key names, or undefined for a text that names none: anything
 * but the date of a real Monday. An address or an argument is read with
 * this, so nothing else has to decide what a week's name looks like.
 */
export function weekFromKey(key: string): Week | undefined {
  const [, year, month, day] = KEY.exec(key) ?? [];
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  const week = weekStarting(Number(year), Number(month) - 1, Number(day));
  // A date that does not exist rolls over to another, and a day that is no
  // Monday begins no week: either way the key read back is not the one given.
  return week.key === key && week.start.getDay() === 1 ? week : undefined;
}

/** The week before a week. */
export function weekBefore(week: Week): Week {
  return weekStarting(
    week.start.getFullYear(),
    week.start.getMonth(),
    week.start.getDate() - 7,
  );
}

/** The week after a week. */
export function weekAfter(week: Week): Week {
  return weekStarting(
    week.start.getFullYear(),
    week.start.getMonth(),
    week.start.getDate() + 7,
  );
}

/**
 * The week a digest is for when none is named: the one that has reached its
 * Sunday evening most recently. From Sunday at `WEEK_ENDS_SUNDAY_AT_HOUR`
 * that is the week then ending; until then it is the week before.
 */
export function latestWeekEnded(now: Date): Week {
  const current = weekOf(now);
  const sundayEvening = new Date(
    current.start.getFullYear(),
    current.start.getMonth(),
    current.start.getDate() + 6,
    WEEK_ENDS_SUNDAY_AT_HOUR,
  );
  return now.getTime() >= sundayEvening.getTime()
    ? current
    : weekBefore(current);
}

/** The last day of a week: its Sunday, at midnight. For writing a week out as two dates. */
export function lastDayOf(week: Week): Date {
  return new Date(
    week.start.getFullYear(),
    week.start.getMonth(),
    week.start.getDate() + 6,
  );
}
