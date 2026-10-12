"use client";

/**
 * The side column on a narrow screen: a button in the header that opens it
 * as a sheet. The sheet stays open while filters are switched, since more
 * than one is often wanted, and says how many bookmarks are left.
 */
import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function MobileFilters({
  active,
  summary,
  footer,
  children,
}: {
  /** How many filters are on. */
  active: number;
  /** `37 of 1,446 bookmarks`. */
  summary: string;
  /** What stays at the foot of the sheet while the filters scroll. */
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger
        render={<Button variant="outline" size="lg" className="lg:hidden" />}
      >
        <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
        Filters
        {active > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-primary-foreground text-xs tabular-nums">
            {active}
            <span className="sr-only"> on</span>
          </span>
        ) : null}
      </SheetTrigger>
      <SheetContent side="left" className="w-[min(20rem,85vw)] gap-0">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>{summary}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
          {children}
        </div>
        <SheetFooter className="gap-3 px-3 pt-0 pb-3">
          {footer}
          <SheetClose render={<Button size="lg" />}>Show bookmarks</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
