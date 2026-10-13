/**
 * The screens of the app that stand beside one another: the library, the
 * weekly digest, the review queue and the Tags page. One list of them, at
 * the top of the side column of each, so that every screen is one press from
 * every other and names itself the same way everywhere. A chat is a further
 * entry here.
 */
import {
  LibraryBig,
  ListChecks,
  type LucideIcon,
  Newspaper,
  Tags,
} from "lucide-react";
import Link from "next/link";
import { whole } from "@/lib/words";

export type Place = "library" | "digest" | "review" | "tags";

const PLACES: { id: Place; href: string; label: string; icon: LucideIcon }[] = [
  { id: "library", href: "/", label: "All bookmarks", icon: LibraryBig },
  { id: "digest", href: "/digest", label: "Weekly digest", icon: Newspaper },
  { id: "review", href: "/review", label: "Review", icon: ListChecks },
  { id: "tags", href: "/tags", label: "Tags", icon: Tags },
];

export function Places({
  current,
  librarySize,
}: {
  /** The screen this is on. Left out on the library while a search or a filter narrows it. */
  current?: Place | undefined;
  /** How many bookmarks the library holds, shown beside it where it is known. */
  librarySize?: number | undefined;
}) {
  return (
    <ul className="flex flex-col gap-px">
      {PLACES.map(({ id, href, label, icon: Icon }) => (
        <li key={id}>
          <Link
            href={href}
            prefetch={false}
            aria-current={id === current ? "page" : undefined}
            className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1 font-medium text-[0.8125rem] leading-snug outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-muted"
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {id === "library" && librarySize !== undefined ? (
              <span className="shrink-0 font-normal text-muted-foreground text-xs tabular-nums">
                {whole(librarySize)}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
