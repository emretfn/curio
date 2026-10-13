/**
 * What was saved in the week, counted by what it is filed under: the free
 * part of a digest, read from the library each time. The labels are the
 * taxonomy's own; a tag is shown by its name.
 */
import { counted, whole } from "@/lib/words";

/** How many tags are listed before the rest are summed. */
const TAGS_SHOWN = 10;

interface Count {
  key: string;
  label: string;
  bookmarks: number;
}

function CountList({
  title,
  counts,
  more,
}: {
  title: string;
  counts: readonly Count[];
  /** How many further entries are not listed. */
  more?: number;
}) {
  const id = `digest-count-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 id={id} className="font-medium text-muted-foreground text-xs">
        {title}
      </h3>
      {counts.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">None</p>
      ) : (
        <ul aria-labelledby={id} className="flex flex-col gap-1">
          {counts.map(({ key, label, bookmarks }) => (
            <li
              key={key}
              className="flex items-baseline justify-between gap-3 text-[0.8125rem] leading-snug"
            >
              <span className="min-w-0 break-words">{label}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {whole(bookmarks)}
              </span>
            </li>
          ))}
          {more !== undefined && more > 0 ? (
            <li className="text-[0.8125rem] text-muted-foreground leading-snug">
              {counted(more, "and {n} more tag", "and {n} more tags")}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

export function WeekCounts({
  categories,
  formats,
  tags,
  unfiled,
  bookmarks,
}: {
  /** Each with its label from the taxonomy, most bookmarks first. */
  categories: readonly Count[];
  formats: readonly Count[];
  tags: readonly Count[];
  /** How many of the week's bookmarks are filed under nothing yet, and how many there are. */
  unfiled: number;
  bookmarks: number;
}) {
  return (
    <div data-testid="digest-counts" className="flex flex-col gap-4">
      {unfiled < bookmarks ? (
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-3">
          <CountList title="Category" counts={categories} />
          <CountList title="Format" counts={formats} />
          <CountList
            title="Tag"
            counts={tags.slice(0, TAGS_SHOWN)}
            more={tags.length - TAGS_SHOWN}
          />
        </div>
      ) : null}
      {unfiled > 0 ? (
        <p
          data-testid="digest-unfiled"
          className="max-w-prose text-[0.8125rem] text-muted-foreground leading-normal"
        >
          {unfiled === bookmarks
            ? counted(
                bookmarks,
                "This week’s bookmark is not filed under a category yet.",
                "None of this week’s {n} bookmarks is filed under a category yet.",
              )
            : `${whole(unfiled)} of this week’s ${whole(bookmarks)} bookmarks ${unfiled === 1 ? "is" : "are"} not filed yet, and ${unfiled === 1 ? "is" : "are"} in no count above.`}{" "}
          The app files new bookmarks by itself once an API key is set;{" "}
          <code className="font-mono text-foreground">pnpm tag</code> files the
          ones that are waiting.
        </p>
      ) : null}
    </div>
  );
}
