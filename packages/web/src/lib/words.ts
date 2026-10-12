/**
 * Counted phrases, each written whole. The product speaks English, and a
 * phrase is chosen by English's plural rule, never glued together from a
 * number and an "s".
 */
const rules = new Intl.PluralRules("en");
const numbers = new Intl.NumberFormat("en");

/** `counted(3, "{n} capture", "{n} captures")` is `3 captures`. */
export function counted(count: number, one: string, other: string): string {
  return (rules.select(count) === "one" ? one : other).replaceAll(
    "{n}",
    numbers.format(count),
  );
}

export function whole(count: number): string {
  return numbers.format(count);
}

const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** `12 Oct 2026, 20:24`, in the server's time zone. */
export function formatDateTime(at: Date): string {
  return dateTime.format(at);
}
