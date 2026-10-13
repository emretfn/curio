import { ListChecks } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LabelChoicesProvider } from "@/components/library/label-choices";
import { LibraryList } from "@/components/library/library-list";
import { Column, Shell } from "@/components/library/shell";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { toItemView } from "@/lib/post-view";
import { whole } from "@/lib/words";
import { backupStatus } from "@/server/backups";
import { OTHER_CATEGORY, TAXONOMY, UNCLEAR_FORMAT } from "@/server/core";
import { sharedStore } from "@/server/data";
import {
  getLibraryFacets,
  getLibraryStatus,
  type LibraryFacets,
  labelChoices,
  listLibrary,
} from "@/server/library";
import {
  type LibraryParams,
  libraryHref,
  NO_PARAMS,
  toLibraryQuery,
} from "@/server/library-params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review" };

/** The taxonomy's own names for the two places these queues are made of. */
const OTHER =
  TAXONOMY.categories.find(({ id }) => id === OTHER_CATEGORY)?.label ??
  OTHER_CATEGORY;
const UNCLEAR =
  TAXONOMY.formats.find(({ id }) => id === UNCLEAR_FORMAT)?.label ??
  UNCLEAR_FORMAT;

/**
 * What is worth a second look, by hand: the two kinds of "other", kept apart
 * because they mean opposite things (LAB-10), and the posts whose format the
 * stored text did not show. Each is a filter of the library, so a queue is
 * the same list, with the same keys, as anywhere else.
 */
const QUEUES = [
  {
    id: "little",
    label: "Too little text",
    params: { ...NO_PARAMS, cat: OTHER_CATEGORY, text: "little" },
    count: (facets: LibraryFacets) => facets.other.little,
    about: `Under ${OTHER} because the stored text does not say what the post is about: a bare link, a few words beside a picture. Look at the post, and file it where it belongs.`,
  },
  {
    id: "unfit",
    label: "No category fits",
    params: { ...NO_PARAMS, cat: OTHER_CATEGORY, text: "enough" },
    count: (facets: LibraryFacets) => facets.other.enough,
    about: `Under ${OTHER} with text enough to tell, because no category fitted. File each where it belongs. When many of them belong together, the taxonomy is missing a category.`,
  },
  {
    id: "unclear",
    label: `${UNCLEAR} format`,
    params: { ...NO_PARAMS, fmt: UNCLEAR_FORMAT },
    count: (facets: LibraryFacets) =>
      facets.formats.find(({ id }) => id === UNCLEAR_FORMAT)?.count ?? 0,
    about:
      "The stored text did not show what kind of post each of these is. Look at the post, and give it its format.",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  params: LibraryParams;
  count: (facets: LibraryFacets) => number;
  about: string;
}[];

const KEYS: [string, string][] = [
  ["J", "next"],
  ["K", "previous"],
  ["C", "category"],
  ["R", "format"],
  ["T", "tags"],
  ["M", "media"],
];

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { queue: asked } = await searchParams;
  const store = sharedStore();
  const facets = getLibraryFacets(store);
  const queue = QUEUES.find(({ id }) => id === asked);
  if (queue === undefined) {
    // No queue named: the first with anything in it. It is put into the
    // address, so that the queue being read does not change under the
    // reader when its last post is filed.
    const first = QUEUES.find(({ count }) => count(facets) > 0) ?? QUEUES[0];
    redirect(`/review?queue=${first.id}`);
  }
  const page = listLibrary(store, toLibraryQuery(queue.params));
  const search = libraryHref(queue.params).slice(2);

  return (
    <Shell
      current="review"
      title="Review"
      skipTo="the review queue"
      status={getLibraryStatus(store, backupStatus())}
    >
      <Column className="pt-6 pb-16">
        <h1 className="pb-3 font-semibold text-2xl leading-tight tracking-[-0.015em]">
          Review
        </h1>
        <nav aria-label="What to review" className="-mx-1">
          <ul className="flex flex-wrap gap-1">
            {QUEUES.map(({ id, label, count }) => (
              <li key={id}>
                <Link
                  href={`/review?queue=${id}`}
                  prefetch={false}
                  aria-current={id === queue.id ? "page" : undefined}
                  className="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 font-medium text-[0.8125rem] text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-secondary aria-[current=page]:text-foreground"
                >
                  {label}
                  <span
                    data-testid={`review-count-${id}`}
                    className="font-normal text-xs tabular-nums"
                  >
                    {whole(count(facets))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <p className="mt-3 max-w-prose text-[0.875rem] text-muted-foreground leading-normal">
          {queue.about}
        </p>

        {page.total === 0 ? (
          <Empty className="py-16" data-testid="nothing-to-review">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ListChecks aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle className="text-base">
                {facets.anyFiled ? "Nothing here" : "Nothing to review yet"}
              </EmptyTitle>
              <EmptyDescription>
                {facets.anyFiled
                  ? "No bookmark is waiting in this queue."
                  : "A queue fills as bookmarks are classified, and none has been. The status page has the command that files the library."}
              </EmptyDescription>
            </EmptyHeader>
            {facets.anyFiled ? null : (
              <EmptyContent>
                <Link
                  href="/status#tagging"
                  prefetch={false}
                  className="rounded-sm text-sm underline underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Open the status page
                </Link>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <>
            {/* Only where there is a keyboard to press them on. */}
            <dl className="mt-3 hidden flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs [@media(hover:hover)]:flex">
              {KEYS.map(([key, does]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <dt>
                    <Kbd>{key}</Kbd>
                  </dt>
                  <dd>{does}</dd>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <dt>
                  <Kbd>1</Kbd>–<Kbd>9</Kbd>
                </dt>
                <dd>choose in an open menu</dd>
              </div>
            </dl>
            <div className="mt-4">
              <LabelChoicesProvider choices={labelChoices(store)}>
                <LibraryList
                  key={search}
                  initialItems={page.items.map((item) => toItemView(item))}
                  initialCursor={page.nextCursor}
                  search={search}
                  ranked={false}
                  total={page.total}
                />
              </LabelChoicesProvider>
            </div>
          </>
        )}
      </Column>
    </Shell>
  );
}
