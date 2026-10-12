"use client";

/**
 * What the search box and the list share: one way to move to another search,
 * and whether that move is still under way. While it is, the list stays
 * where it is and dims a little, so that typing never blanks the screen.
 */
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useTransition,
} from "react";
import { cn } from "@/lib/utils";

interface Frame {
  pending: boolean;
  /** Replaces the address, and so the search, without adding to history. */
  go: (href: string) => void;
}

const FrameContext = createContext<Frame>({ pending: false, go: () => {} });

export const useLibraryFrame = (): Frame => useContext(FrameContext);

export function LibraryFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = useCallback(
    (href: string) => {
      startTransition(() => router.replace(href, { scroll: false }));
    },
    [router],
  );
  const frame = useMemo(() => ({ pending, go }), [pending, go]);
  return (
    <FrameContext.Provider value={frame}>{children}</FrameContext.Provider>
  );
}

/** The part of the screen a search replaces. */
export function Results({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { pending } = useLibraryFrame();
  return (
    <div
      aria-busy={pending}
      className={cn(
        "transition-opacity duration-150 ease-out",
        // The wait before dimming keeps a quick answer from flickering.
        pending && "opacity-60 delay-150",
        className,
      )}
    >
      {children}
    </div>
  );
}
