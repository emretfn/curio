/**
 * The frame of a screen that stands beside the library: the weekly digest,
 * the review queue, the Tags page. The same side column as the library's,
 * with the same list of screens at its top and the same status at its foot,
 * and the same bar above the content. What is the screen's own goes in the
 * column under the list, in the bar, and in the page.
 *
 * On a narrow screen the side column is not shown, and the bar leads back
 * to the library, whose filters sheet holds the list of screens.
 */
import { ArrowLeft, Bookmark } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LibraryStatus } from "@/server/library";
import { type Place, Places } from "./places.tsx";
import { ThemeSetting } from "./settings.tsx";
import { SidebarFooter } from "./sidebar.tsx";

/** The column a screen's content is read in: the library's own measure, or a wider one for a table. */
export function Column({
  wide,
  className,
  children,
}: {
  wide?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 sm:px-6",
        wide ? "max-w-2xl" : "max-w-[37rem]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Shell({
  current,
  title,
  skipTo,
  status,
  side,
  bar,
  wide,
  children,
}: {
  current: Place;
  /** The screen's name, in the bar on a wide screen. */
  title: string;
  /** What the first Tab stop says it skips to: `the digest`. */
  skipTo: string;
  status: LibraryStatus;
  /** The screen's own part of the side column. */
  side?: ReactNode;
  /** The screen's own controls, at the end of the bar. */
  bar?: ReactNode;
  wide?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <>
      <a
        href="#content"
        className="-translate-y-16 fixed start-3 top-3 z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm focus-visible:translate-y-0"
      >
        Skip to {skipTo}
      </a>
      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh flex-col border-e bg-sidebar lg:flex">
          <div className="flex h-(--header-height) shrink-0 items-center justify-between gap-2 ps-5 pe-3">
            <p className="flex items-center gap-2 font-semibold text-[0.9375rem]">
              <Bookmark aria-hidden="true" className="size-4" />
              Bookmarks
            </p>
            <ThemeSetting compact />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-3 pt-1 pb-4">
            <nav aria-label="Library">
              <Places current={current} />
            </nav>
            {side}
          </div>
          <div className="shrink-0 px-3 pb-3">
            <SidebarFooter status={status} />
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur-sm">
            <Column
              wide={wide}
              className="flex h-(--header-height) items-center gap-2"
            >
              <Link
                href="/"
                prefetch={false}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "lg" }),
                  "-ms-2.5 lg:hidden",
                )}
              >
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                Library
              </Link>
              <p className="hidden min-w-0 flex-1 truncate font-medium text-[0.875rem] lg:block">
                {title}
              </p>
              {bar !== undefined ? (
                <div className="ms-auto flex items-center gap-1.5">{bar}</div>
              ) : null}
            </Column>
          </header>

          <main id="content" tabIndex={-1} className="outline-none">
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
