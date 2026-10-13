/**
 * Every week that holds something, latest first, under its year: the way
 * to any past week's digest. Each is a plain link, so it works with the
 * keyboard, the back button and a new tab, and needs no script.
 *
 * On a wide screen it stands in the side column; on a narrow one the same
 * list closes the page.
 */
import { ChevronDown, PenLine } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { weekRangeShort } from "@/lib/week-label";
import { whole } from "@/lib/words";
import type { WeekLink } from "@/server/digest";
import { digestHref } from "@/server/digest-params";

const ROW =
  "flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-[0.8125rem] leading-snug outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring";

export function WeekList({
  weeks,
  current,
  label,
}: {
  weeks: readonly WeekLink[];
  /** The key of the week on show. */
  current: string;
  /** What the list is called, for a reader who cannot see where it stands. */
  label: string;
}) {
  const years: { year: number; weeks: WeekLink[] }[] = [];
  for (const entry of weeks) {
    // A week belongs to the year its Monday is in.
    const year = entry.week.start.getFullYear();
    const group = years.at(-1);
    if (group?.year === year) group.weeks.push(entry);
    else years.push({ year, weeks: [entry] });
  }
  const currentYear = Number(current.slice(0, 4));
  const shown = years.some(({ year }) => year === currentYear)
    ? currentYear
    : years[0]?.year;
  if (years.length === 0) {
    return (
      <p className="px-2 text-[0.8125rem] text-muted-foreground">
        No week holds a bookmark yet.
      </p>
    );
  }
  return (
    <nav aria-label={label} className="flex flex-col gap-1">
      {years.map(({ year, weeks: ofYear }) => (
        <details
          key={year}
          open={year === shown}
          className="group/year flex flex-col"
        >
          <summary className="flex cursor-default list-none items-center justify-between rounded-md px-2 py-1.5 font-medium text-muted-foreground text-xs outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>
              {year}
              <span className="sr-only">
                , {whole(ofYear.length)}{" "}
                {ofYear.length === 1 ? "week" : "weeks"}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 group-open/year:rotate-180"
            />
          </summary>
          <ul className="flex flex-col gap-px pt-px pb-1">
            {ofYear.map(({ week, bookmarks, written }) => {
              const active = week.key === current;
              return (
                <li key={week.key}>
                  <Link
                    href={digestHref(week)}
                    prefetch={false}
                    aria-current={active ? "page" : undefined}
                    className={cn(ROW, active && "bg-muted font-medium")}
                  >
                    <span className="min-w-0 flex-1">
                      {weekRangeShort(week.start)}
                    </span>
                    {written ? (
                      <PenLine
                        role="img"
                        aria-label="Summary written"
                        className="size-3.5 shrink-0 opacity-70"
                      />
                    ) : null}
                    <span className="shrink-0 font-normal text-muted-foreground text-xs tabular-nums">
                      {whole(bookmarks)}
                      <span className="sr-only">
                        {bookmarks === 1 ? " bookmark" : " bookmarks"}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
    </nav>
  );
}
