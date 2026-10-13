import { Bookmark, SearchX, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { LabelChoicesProvider } from "@/components/library/label-choices";
import { LibraryFrame, Results } from "@/components/library/library-frame";
import { LibraryList } from "@/components/library/library-list";
import { Listing } from "@/components/library/listing";
import { MobileFilters } from "@/components/library/mobile-filters";
import { SearchBox } from "@/components/library/search-box";
import { ThemeSetting } from "@/components/library/settings";
import {
  categoryLabel,
  FEATURE_LABELS,
  formatLabel,
  LANGUAGE_LABELS,
  NOT_CLASSIFIED_LABEL,
  OTHER_REASON_LABELS,
  SidebarFooter,
  SidebarNav,
  STANDING_LABELS,
} from "@/components/library/sidebar";
import { StatusBanner } from "@/components/library/status";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { toItemView } from "@/lib/post-view";
import { counted, whole } from "@/lib/words";
import { backupStatus } from "@/server/backups";
import { sharedStore } from "@/server/data";
import {
  getLibraryFacets,
  getLibraryStatus,
  type LibraryFacets,
  type LibraryStatus,
  labelChoices,
  listLibrary,
  NOT_CLASSIFIED,
  readTags,
} from "@/server/library";
import {
  isNarrowed,
  type LibraryParams,
  libraryHref,
  NO_PARAMS,
  parseLibraryParams,
  toLibraryQuery,
} from "@/server/library-params";

export const dynamic = "force-dynamic";

/** Each filter that is on, by name, with the address that switches it off. */
function activeFilters(
  params: LibraryParams,
  facets: LibraryFacets,
): { key: string; label: string; href: string }[] {
  const filters: { key: string; label: string; href: string }[] = [];
  if (params.q !== "") {
    filters.push({
      key: "q",
      label: `“${params.q}”`,
      href: libraryHref({ ...params, q: "" }),
    });
  }
  for (const feature of params.has) {
    filters.push({
      key: feature,
      label: FEATURE_LABELS[feature].label,
      href: libraryHref({
        ...params,
        has: params.has.filter((other) => other !== feature),
      }),
    });
  }
  if (params.lang !== undefined) {
    filters.push({
      key: "lang",
      label: LANGUAGE_LABELS[params.lang],
      href: libraryHref({ ...params, lang: undefined }),
    });
  }
  if (params.year !== undefined) {
    filters.push({
      key: "year",
      label: `Saved in ${params.year}`,
      href: libraryHref({ ...params, year: undefined }),
    });
  }
  if (params.author !== undefined) {
    filters.push({
      key: "author",
      label:
        facets.author === null
          ? "An author not in the library"
          : `By ${facets.author.name}`,
      href: libraryHref({ ...params, author: undefined }),
    });
  }
  if (params.on !== undefined) {
    filters.push({
      key: "on",
      label: STANDING_LABELS[params.on].label,
      href: libraryHref({ ...params, on: undefined }),
    });
  }
  if (params.cat !== undefined) {
    filters.push({
      key: "cat",
      label:
        params.cat === NOT_CLASSIFIED
          ? NOT_CLASSIFIED_LABEL
          : params.text === undefined
            ? categoryLabel(params.cat)
            : `${categoryLabel(params.cat)}: ${OTHER_REASON_LABELS[params.text]}`,
      href: libraryHref({ ...params, cat: undefined, text: undefined }),
    });
  }
  if (params.fmt !== undefined) {
    filters.push({
      key: "fmt",
      label: formatLabel(params.fmt),
      href: libraryHref({ ...params, fmt: undefined }),
    });
  }
  for (const tag of params.tag) {
    filters.push({
      key: `tag:${tag}`,
      label: facets.unknownTags.includes(tag)
        ? `#${tag} is not a tag`
        : `#${tag}`,
      href: libraryHref({
        ...params,
        tag: params.tag.filter((other) => other !== tag),
      }),
    });
  }
  if (params.proposed !== undefined) {
    filters.push({
      key: "proposed",
      label: `Proposed tag: ${params.proposed}`,
      href: libraryHref({ ...params, proposed: undefined }),
    });
  }
  return filters;
}

function EmptyLibrary({ status }: { status: LibraryStatus }) {
  const captured = status.captures.count > 0;
  return (
    <Empty className="enter-staged py-24">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Bookmark aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-base">
          {captured ? "No bookmarks could be read yet" : "No bookmarks yet"}
        </EmptyTitle>
        <EmptyDescription>
          {captured
            ? counted(
                status.captures.count,
                "{n} capture has arrived, and no bookmark could be read from it. The status page says why.",
                "{n} captures have arrived, and no bookmark could be read from them. The status page says why.",
              )
            : "This library fills itself. Pair the capture extension, then open your bookmarks on X and scroll through them: every page you see is kept here."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent style={{ "--stage": 1 } as React.CSSProperties}>
        {captured ? (
          <Link href="/status" prefetch={false} className={buttonVariants()}>
            Open the status page
          </Link>
        ) : (
          <Link href="/pair" prefetch={false} className={buttonVariants()}>
            Pair the extension
          </Link>
        )}
      </EmptyContent>
    </Empty>
  );
}

function NoResults({ params }: { params: LibraryParams }) {
  const onlySearch = libraryHref({ ...NO_PARAMS, q: params.q });
  const filtered = params.q !== "" && libraryHref(params) !== onlySearch;
  return (
    <Empty className="py-20" data-testid="no-results">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-base">
          {params.q === ""
            ? "No bookmarks match these filters"
            : `No bookmarks match “${params.q}”`}
        </EmptyTitle>
        <EmptyDescription>
          {params.q === ""
            ? "Switch a filter off to widen the list."
            : filtered
              ? "Nothing with these filters holds every word. Search the whole library, or try fewer words."
              : "Every word has to appear in a post, its author, its links or the post it quotes. Try fewer words, or the start of one."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        {filtered ? (
          <Link href={onlySearch} prefetch={false} className={buttonVariants()}>
            Search all bookmarks
          </Link>
        ) : null}
        <Link
          href="/"
          prefetch={false}
          className={buttonVariants({
            variant: filtered ? "outline" : "default",
          })}
        >
          {params.q === "" ? "Clear filters" : "Clear search"}
        </Link>
      </EmptyContent>
    </Empty>
  );
}

function Column({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`mx-auto w-full max-w-[37rem] px-4 sm:px-6 ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const asked = parseLibraryParams(await searchParams);
  const store = sharedStore();
  // A tag is shown, and linked to, as the vocabulary writes it, whatever
  // way of writing it the address used.
  const tags = readTags(store, asked.tag);
  const params = { ...asked, tag: [...tags.known, ...tags.unknown] };
  const query = toLibraryQuery(params);
  const status = getLibraryStatus(store, backupStatus());
  const facets = getLibraryFacets(store, query);
  const page = listLibrary(store, query);
  const narrowed = isNarrowed(params);
  const filters = activeFilters(params, facets);
  const search = libraryHref(params).slice(2);
  const empty = facets.librarySize === 0 && !narrowed && page.total === 0;
  // What was removed on X and what X withholds are listed apart from the
  // bookmarks the library counts, so they are not so many "of" them.
  const summary =
    narrowed && params.on === undefined
      ? counted(
          facets.librarySize,
          `${whole(page.total)} of {n} bookmark`,
          `${whole(page.total)} of {n} bookmarks`,
        )
      : counted(page.total, "{n} bookmark", "{n} bookmarks");
  const nav = <SidebarNav params={params} facets={facets} />;
  const footer = <SidebarFooter status={status} />;

  return (
    <LibraryFrame>
      <a
        href="#content"
        className="-translate-y-16 fixed start-3 top-3 z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm focus-visible:translate-y-0"
      >
        Skip to the bookmarks
      </a>
      {/*
        Two columns today: the side column and the list. A third, for a chat
        beside the list, is one more track here and one more child below.
      */}
      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh flex-col border-e bg-sidebar lg:flex">
          <div className="flex h-(--header-height) shrink-0 items-center justify-between gap-2 ps-5 pe-3">
            <p className="flex items-center gap-2 font-semibold text-[0.9375rem]">
              <Bookmark aria-hidden="true" className="size-4" />
              Bookmarks
            </p>
            <ThemeSetting compact />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-1 pb-4">
            {nav}
          </div>
          <div className="shrink-0 px-3 pb-3">{footer}</div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur-sm">
            <Column className="flex h-(--header-height) items-center gap-2">
              <MobileFilters
                active={filters.filter((filter) => filter.key !== "q").length}
                summary={summary}
                footer={footer}
              >
                {nav}
                <div className="mt-5 border-t px-2 pt-4">
                  <ThemeSetting />
                </div>
              </MobileFilters>
              <SearchBox query={params.q} />
            </Column>
          </header>

          <main id="content" tabIndex={-1} className="outline-none">
            <Column className="pt-4 pb-16">
              <h1 className="sr-only">Bookmarks</h1>
              <StatusBanner status={status} />
              {empty ? (
                <EmptyLibrary status={status} />
              ) : (
                <Results>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2">
                    <p
                      role="status"
                      data-testid="result-count"
                      className="text-[0.8125rem] text-muted-foreground tabular-nums"
                    >
                      {summary}
                    </p>
                    {filters.length > 0 ? (
                      <ul className="flex flex-wrap items-center gap-1.5">
                        {filters.map((filter) => (
                          <li key={filter.key}>
                            <Link
                              href={filter.href}
                              prefetch={false}
                              className="inline-flex h-6 max-w-64 items-center gap-1 rounded-full bg-secondary ps-2.5 pe-1.5 font-medium text-secondary-foreground text-xs outline-none transition-colors duration-150 ease-out hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="sr-only">Remove filter: </span>
                              <span className="truncate">{filter.label}</span>
                              <X
                                aria-hidden="true"
                                className="size-3 shrink-0"
                              />
                            </Link>
                          </li>
                        ))}
                        {filters.length > 1 ? (
                          <li>
                            <Link
                              href="/"
                              prefetch={false}
                              className="rounded-sm px-1 py-1 text-muted-foreground text-xs underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Clear all
                            </Link>
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </div>
                  {/* A list the reader is in stays, whatever a correction
                      made in it leaves the query matching. */}
                  <Listing
                    key={search}
                    total={page.total}
                    empty={<NoResults params={params} />}
                  >
                    <LabelChoicesProvider choices={labelChoices(store)}>
                      <LibraryList
                        initialItems={page.items.map((item) =>
                          toItemView(item, page.terms),
                        )}
                        initialCursor={page.nextCursor}
                        search={search}
                        ranked={page.terms.length > 0}
                        total={page.total}
                      />
                    </LabelChoicesProvider>
                  </Listing>
                </Results>
              )}
            </Column>
          </main>
        </div>
      </div>
    </LibraryFrame>
  );
}
