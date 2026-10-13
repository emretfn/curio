import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Section } from "@/components/digest/parts";
import { TaxonomySuggestions } from "@/components/digest/taxonomy-suggestions";
import { WeekCounts } from "@/components/digest/week-counts";
import { WeekList } from "@/components/digest/week-list";
import { WeekPosts } from "@/components/digest/week-posts";
import { WrittenSummary } from "@/components/digest/written-summary";
import { LabelChoicesProvider } from "@/components/library/label-choices";
import { Column, Shell } from "@/components/library/shell";
import { StatusBanner } from "@/components/library/status";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { weekRange } from "@/lib/week-label";
import { counted } from "@/lib/words";
import { backupStatus } from "@/server/backups";
import { MIN_DIGEST_BOOKMARKS, OTHER_CATEGORY, TAXONOMY } from "@/server/core";
import { sharedStore } from "@/server/data";
import { getDigestPage, WEEK_POSTS_SHOWN } from "@/server/digest";
import {
  digestHref,
  LIBRARY_LINKS,
  parseDigestWeek,
} from "@/server/digest-params";
import { getLibraryStatus, labelChoices } from "@/server/library";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Weekly digest" };

/** A step to the week before or after: a link, or its place when there is no such week yet. */
function Step({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: ReactNode;
}) {
  const shape = buttonVariants({ variant: "outline", size: "icon-lg" });
  if (href === null) {
    return (
      <button type="button" disabled aria-label={label} className={shape}>
        {children}
      </button>
    );
  }
  return (
    <Link href={href} prefetch={false} aria-label={label} className={shape}>
      {children}
    </Link>
  );
}

const labelOf = (
  entries: readonly { id: string; label: string }[],
  id: string,
) => entries.find((entry) => entry.id === id)?.label ?? id;

export default async function DigestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const now = new Date();
  const week = parseDigestWeek(await searchParams, now);
  // The week the page shows when none is named.
  const latest = parseDigestWeek({}, now);
  const store = sharedStore();
  const status = getLibraryStatus(store, backupStatus());
  const page = getDigestPage(store, week, now);
  const { summary } = page;
  const range = weekRange(week.start);
  const latestWithBookmarks = page.weeks.find(
    ({ bookmarks }) => bookmarks > 0,
  )?.week;

  return (
    <Shell
      current="digest"
      title="Weekly digest"
      skipTo="the digest"
      status={status}
      side={
        <section aria-labelledby="digest-weeks" className="flex flex-col gap-1">
          <h2
            id="digest-weeks"
            className="px-2 font-medium text-muted-foreground text-xs"
          >
            Weeks
          </h2>
          <WeekList weeks={page.weeks} current={week.key} label="Weeks" />
        </section>
      }
      bar={
        <>
          {week.key === latest.key ? null : (
            <Link
              href="/digest"
              prefetch={false}
              data-testid="digest-latest"
              className={buttonVariants({ variant: "ghost", size: "lg" })}
            >
              Latest
            </Link>
          )}
          <Step
            href={digestHref(page.previous)}
            label={`The week before: ${weekRange(page.previous.start)}`}
          >
            <ChevronLeft aria-hidden="true" />
          </Step>
          <Step
            href={page.next === null ? null : digestHref(page.next)}
            label={
              page.next === null
                ? "The week after has not begun"
                : `The week after: ${weekRange(page.next.start)}`
            }
          >
            <ChevronRight aria-hidden="true" />
          </Step>
        </>
      }
    >
      <Column className="flex flex-col gap-10 pt-6 pb-16">
        <StatusBanner status={status} />

        <div className="flex flex-col gap-1.5">
          <p className="font-medium text-[0.8125rem] text-muted-foreground">
            Weekly digest
          </p>
          <h1
            data-testid="digest-week"
            data-week={week.key}
            className="text-balance font-semibold text-2xl leading-tight tracking-[-0.015em]"
          >
            <time dateTime={week.key}>{range}</time>
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
            <p
              data-testid="digest-count"
              className="text-[0.875rem] text-muted-foreground tabular-nums"
            >
              {counted(
                summary.bookmarks,
                "{n} bookmark saved",
                "{n} bookmarks saved",
              )}
              {summary.removedOnX > 0
                ? counted(
                    summary.removedOnX,
                    ", and {n} more since removed on X",
                    ", and {n} more since removed on X",
                  )
                : ""}
            </p>
            {page.running ? (
              <Badge variant="outline" data-testid="digest-running">
                <CalendarDays aria-hidden="true" />
                Still running, ends Sunday
              </Badge>
            ) : null}
          </div>
        </div>

        {summary.bookmarks === 0 ? (
          <Empty className="py-16" data-testid="digest-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarDays aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle className="text-base">
                {page.running
                  ? "Nothing saved this week yet"
                  : "Nothing was saved this week"}
              </EmptyTitle>
              <EmptyDescription>
                A week runs from Monday to Sunday, by when each post was
                bookmarked on X.
              </EmptyDescription>
            </EmptyHeader>
            {latestWithBookmarks !== undefined ? (
              <EmptyContent>
                <Link
                  href={digestHref(latestWithBookmarks)}
                  prefetch={false}
                  className={buttonVariants()}
                >
                  Open the week of {weekRange(latestWithBookmarks.start)}
                </Link>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <>
            <WrittenSummary
              written={page.written}
              weekKey={week.key}
              enough={page.enoughForSummary}
              minimum={MIN_DIGEST_BOOKMARKS}
            />

            <Section id="digest-saved" title="What you saved">
              <WeekCounts
                categories={summary.categories.map(
                  ({ category, bookmarks }) => ({
                    key: category,
                    label: labelOf(TAXONOMY.categories, category),
                    bookmarks,
                    href: LIBRARY_LINKS.category(category),
                  }),
                )}
                formats={summary.formats.map(({ format, bookmarks }) => ({
                  key: format,
                  label: labelOf(TAXONOMY.formats, format),
                  bookmarks,
                  href: LIBRARY_LINKS.format(format),
                }))}
                tags={summary.tags.map(({ tag, bookmarks }) => ({
                  key: tag,
                  label: tag,
                  bookmarks,
                  href: LIBRARY_LINKS.tag(tag),
                }))}
                unfiled={summary.unfiled}
                bookmarks={summary.bookmarks}
              />
            </Section>
          </>
        )}

        <TaxonomySuggestions
          suggestions={page.suggestions}
          classifiedInLibrary={page.classifiedInLibrary}
          otherCategory={OTHER_CATEGORY}
        />

        {page.posts.length > 0 ? (
          <Section
            id="digest-posts-heading"
            title="The posts"
            aside={
              summary.bookmarks > page.posts.length
                ? `The latest ${WEEK_POSTS_SHOWN} of ${summary.bookmarks}`
                : undefined
            }
            className="gap-0"
          >
            <LabelChoicesProvider choices={labelChoices(store)}>
              <WeekPosts posts={page.posts} />
            </LabelChoicesProvider>
          </Section>
        ) : null}

        <section
          aria-labelledby="digest-other-weeks"
          className="flex flex-col gap-2 lg:hidden"
        >
          <h2
            id="digest-other-weeks"
            className="border-b py-2.5 font-semibold text-[0.9375rem] leading-snug"
          >
            Other weeks
          </h2>
          <div className="-mx-2">
            <WeekList
              weeks={page.weeks}
              current={week.key}
              label="Other weeks"
            />
          </div>
        </section>
      </Column>
    </Shell>
  );
}
