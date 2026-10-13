/**
 * The library's side column: where you are, what narrows the list, and at
 * its foot the settings and the capture status. On a wide screen it stands
 * beside the list; on a narrow one the same content opens as a sheet.
 *
 * Every filter is a plain link to the list with that filter switched, so
 * filtering works with the keyboard, the back button and a new tab, and
 * needs no script. The number beside each is how many bookmarks it would
 * leave.
 *
 * What a bookmark is filed under comes first: its category, its format and
 * its tags, from core's taxonomy and vocabulary, never from a list written
 * here. Before anything is classified those three are one line that says
 * so. Beside "All bookmarks" stand the screens of their own: the weekly
 * digest, the review queue and the Tags page. A chat is a further entry.
 */
import {
  BookmarkX,
  Check,
  ChevronDown,
  Clapperboard,
  EyeOff,
  FileText,
  ImageIcon,
  Link2,
  type LucideIcon,
  Quote,
  ScrollText,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { whole } from "@/lib/words";
import { OTHER_CATEGORY, TAXONOMY } from "@/server/core";
import {
  LIBRARY_LANGUAGES,
  type LibraryFacets,
  type LibraryLanguage,
  type LibraryStatus,
  NOT_CLASSIFIED,
  type OtherReason,
  POST_FEATURES,
  type PostFeature,
  X_STANDINGS,
  type XStanding,
} from "@/server/library";
import {
  isNarrowed,
  type LibraryParams,
  libraryHref,
  toggleCategory,
  toggleFeature,
  toggleTag,
} from "@/server/library-params";
import { Places } from "./places.tsx";
import { AutoMediaSetting } from "./settings.tsx";
import { StatusLine } from "./status.tsx";

export const FEATURE_LABELS: Record<
  PostFeature,
  { label: string; icon: LucideIcon }
> = {
  media: { label: "Media", icon: ImageIcon },
  video: { label: "Video", icon: Clapperboard },
  link: { label: "Links", icon: Link2 },
  article: { label: "Articles", icon: FileText },
  quote: { label: "Quotes", icon: Quote },
  long: { label: "Long posts", icon: ScrollText },
};

export const LANGUAGE_LABELS: Record<LibraryLanguage, string> = {
  en: "English",
  tr: "Turkish",
  other: "Other",
};

export const STANDING_LABELS: Record<
  XStanding,
  { label: string; icon: LucideIcon }
> = {
  removed: { label: "Removed on X", icon: BookmarkX },
  withheld: { label: "Withheld by X", icon: EyeOff },
};

/** Why a bookmark is under "other", as a filter names it. */
export const OTHER_REASON_LABELS: Record<OtherReason, string> = {
  little: "too little text",
  enough: "no category fits",
};

export const NOT_CLASSIFIED_LABEL = "Not classified yet";

/** The name of a category or a format, from the taxonomy. */
export const categoryLabel = (id: string): string =>
  TAXONOMY.categories.find((entry) => entry.id === id)?.label ?? id;
export const formatLabel = (id: string): string =>
  TAXONOMY.formats.find((entry) => entry.id === id)?.label ?? id;

/** How many tags the side column lists before it points at the page that has them all. */
const TAGS_SHOWN = 12;

const ROW =
  "flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-[0.8125rem] leading-snug";

function FilterRow({
  href,
  active,
  count,
  icon: Icon,
  children,
}: {
  href: string;
  active: boolean;
  count: number;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  const content = (
    <>
      {Icon !== undefined ? (
        <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
      ) : null}
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {whole(count)}
      </span>
    </>
  );
  // A filter that would leave nothing is shown, so the list of filters does
  // not jump about, but it is not a link to an empty page.
  if (count === 0 && !active) {
    return (
      <li>
        <span aria-disabled="true" className={cn(ROW, "opacity-45")}>
          {content}
        </span>
      </li>
    );
  }
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        aria-current={active ? "true" : undefined}
        className={cn(
          ROW,
          "outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          active && "bg-muted font-medium",
        )}
      >
        {content}
        {active ? (
          <span className="sr-only">Selected. Select to remove.</span>
        ) : null}
      </Link>
    </li>
  );
}

function FilterGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const id = `filters-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="px-2 font-medium text-muted-foreground text-xs">
        {title}
      </h2>
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}

const SHORTCUTS: [string, string][] = [
  ["/", "Search"],
  ["J", "Next post"],
  ["K", "Previous post"],
  ["E", "Open or close a long post"],
  ["M", "Show the post’s media"],
  ["O", "Open the post on X"],
  ["C", "Change the post’s category"],
  ["R", "Change its format"],
  ["T", "Add or remove its tags"],
];

/** With focus in a video player. `src/lib/shortcuts.ts` is what they do. */
const PLAYER_SHORTCUTS: [string, string][] = [
  ["Space", "Play or pause"],
  ["← →", "Back or on 5 seconds"],
  ["↑ ↓", "Volume"],
  ["< >", "Slower or faster"],
  ["0–9", "Jump to that tenth"],
  ["M", "Mute or unmute"],
  ["F", "Full screen"],
];

function Shortcuts({ keys }: { keys: [string, string][] }) {
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-1.5 text-muted-foreground">
      {keys.map(([key, action]) => (
        <div key={key} className="contents">
          <dt>
            <Kbd>{key}</Kbd>
          </dt>
          <dd>{action}</dd>
        </div>
      ))}
    </dl>
  );
}

interface SidebarProps {
  params: LibraryParams;
  facets: LibraryFacets;
}

/** Category, format and tags: what the bookmarks are filed under. */
function FiledUnder({ params, facets }: SidebarProps) {
  if (!facets.anyFiled) {
    return (
      <section aria-labelledby="filters-filed-under" className="px-2">
        <h2
          id="filters-filed-under"
          className="font-medium text-muted-foreground text-xs"
        >
          Category, format and tags
        </h2>
        <p className="mt-1.5 text-[0.8125rem] text-muted-foreground leading-normal">
          Nothing is classified yet. The{" "}
          <Link
            href="/status#tagging"
            prefetch={false}
            className="rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            status page
          </Link>{" "}
          has the command that files the library.
        </p>
      </section>
    );
  }
  const reasons = (["little", "enough"] as const).filter(
    (reason) =>
      facets.other[reason] > 0 ||
      (params.cat === OTHER_CATEGORY && params.text === reason),
  );
  // The tags chosen stay in the list, whatever else they leave of it.
  const shown = facets.tags.filter(
    ({ tag }, index) => index < TAGS_SHOWN || facets.chosenTags.includes(tag),
  );
  return (
    <>
      <FilterGroup title="Category">
        {facets.categories.map(({ id, count }) => (
          <FilterRow
            key={id}
            href={libraryHref(toggleCategory(params, id))}
            active={params.cat === id}
            count={count}
          >
            {categoryLabel(id)}
          </FilterRow>
        ))}
        {reasons.map((reason) => (
          <FilterRow
            key={reason}
            href={libraryHref(toggleCategory(params, OTHER_CATEGORY, reason))}
            active={params.cat === OTHER_CATEGORY && params.text === reason}
            count={facets.other[reason]}
          >
            {categoryLabel(OTHER_CATEGORY)}: {OTHER_REASON_LABELS[reason]}
          </FilterRow>
        ))}
        {facets.notClassified > 0 || params.cat === NOT_CLASSIFIED ? (
          <FilterRow
            href={libraryHref(toggleCategory(params, NOT_CLASSIFIED))}
            active={params.cat === NOT_CLASSIFIED}
            count={facets.notClassified}
          >
            {NOT_CLASSIFIED_LABEL}
          </FilterRow>
        ) : null}
      </FilterGroup>

      <FilterGroup title="Format">
        {facets.formats.map(({ id, count }) => (
          <FilterRow
            key={id}
            href={libraryHref({
              ...params,
              fmt: params.fmt === id ? undefined : id,
            })}
            active={params.fmt === id}
            count={count}
          >
            {formatLabel(id)}
          </FilterRow>
        ))}
      </FilterGroup>

      {shown.length > 0 ? (
        <FilterGroup title="Tags">
          {shown.map(({ tag, count }) => (
            <FilterRow
              key={tag}
              href={libraryHref(toggleTag(params, tag))}
              active={facets.chosenTags.includes(tag)}
              count={count}
            >
              {tag}
            </FilterRow>
          ))}
          {facets.tags.length > shown.length ? (
            <li>
              <Link
                href="/tags#vocabulary"
                prefetch={false}
                className={cn(
                  ROW,
                  "text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                All {whole(facets.tags.length)} tags here
              </Link>
            </li>
          ) : null}
        </FilterGroup>
      ) : null}
    </>
  );
}

/** The filters. This part scrolls when it is taller than the screen. */
export function SidebarNav({ params, facets }: SidebarProps) {
  const standings = X_STANDINGS.filter(
    (standing) => facets.standings[standing] > 0 || params.on === standing,
  );
  const years =
    params.year === undefined ||
    facets.savedYears.some(({ year }) => year === params.year)
      ? facets.savedYears
      : [{ year: params.year, count: 0 }, ...facets.savedYears];
  return (
    <nav aria-label="Library" className="flex flex-col gap-5">
      <Places
        current={isNarrowed(params) ? undefined : "library"}
        librarySize={facets.librarySize}
      />

      <FiledUnder params={params} facets={facets} />

      <FilterGroup title="Contains">
        {POST_FEATURES.map((feature) => (
          <FilterRow
            key={feature}
            href={libraryHref(toggleFeature(params, feature))}
            active={params.has.includes(feature)}
            count={facets.features[feature]}
            icon={FEATURE_LABELS[feature].icon}
          >
            {FEATURE_LABELS[feature].label}
          </FilterRow>
        ))}
      </FilterGroup>

      <FilterGroup title="Language">
        {LIBRARY_LANGUAGES.map((language) => (
          <FilterRow
            key={language}
            href={libraryHref({
              ...params,
              lang: params.lang === language ? undefined : language,
            })}
            active={params.lang === language}
            count={facets.languages[language]}
          >
            {LANGUAGE_LABELS[language]}
          </FilterRow>
        ))}
      </FilterGroup>

      {years.length > 0 ? (
        <FilterGroup title="Saved in">
          {years.map(({ year, count }) => (
            <FilterRow
              key={year}
              href={libraryHref({
                ...params,
                year: params.year === year ? undefined : year,
              })}
              active={params.year === year}
              count={count}
            >
              {year}
            </FilterRow>
          ))}
        </FilterGroup>
      ) : null}

      {standings.length > 0 ? (
        <FilterGroup title="On X">
          {standings.map((standing) => (
            <FilterRow
              key={standing}
              href={libraryHref({
                ...params,
                on: params.on === standing ? undefined : standing,
              })}
              active={params.on === standing}
              count={facets.standings[standing]}
              icon={STANDING_LABELS[standing].icon}
            >
              {STANDING_LABELS[standing].label}
            </FilterRow>
          ))}
        </FilterGroup>
      ) : null}

      <details className="group/keys hidden px-2 text-[0.8125rem] lg:block">
        <summary className="-mx-2 flex cursor-default list-none items-center justify-between rounded-md px-2 py-1.5 text-muted-foreground text-xs outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="font-medium">Keyboard shortcuts</span>
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 group-open/keys:rotate-180"
          />
        </summary>
        <Shortcuts keys={SHORTCUTS} />
        <h3 className="mt-3 font-medium text-muted-foreground text-xs">
          In a video
        </h3>
        <Shortcuts keys={PLAYER_SHORTCUTS} />
        <p className="mt-3 text-muted-foreground text-xs leading-normal">
          The browser’s own Find sees only the posts near the screen. Search
          looks through all of them.
        </p>
      </details>
    </nav>
  );
}

/**
 * The foot of the side column, which never scrolls away: the media setting,
 * and how capture is doing.
 */
export function SidebarFooter({ status }: { status: LibraryStatus }) {
  return (
    <div className="flex flex-col gap-3 border-t px-2 pt-3">
      <AutoMediaSetting />
      <StatusLine status={status} />
    </div>
  );
}
