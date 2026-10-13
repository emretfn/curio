"use client";

/**
 * The list itself: the items the address asks for, newest saved first under
 * the month each was saved in, or, for a search, best match first under one
 * heading. It starts with the page the server rendered and asks for the next
 * as the reader nears the end.
 *
 * Only the rows near the screen are in the page. The list keeps every item
 * it has loaded, but draws a window of them (TanStack Virtual), each at the
 * place its measured height gives it, so a library scrolled to its end is as
 * light a page as one just opened. What that could break is kept:
 *
 * - a row is measured as it is, and again whenever it changes, so opening a
 *   long text or showing media moves what is below it and nothing else;
 * - what a row remembers outlives it (`row-memory.tsx`), a row showing media
 *   from X stays in the page so that nothing is asked for twice, and so does
 *   the row that has the keyboard's focus;
 * - the month in view stays at the top, J and K move by the list's order
 *   whether or not the next row is drawn yet, and a reload or Back returns
 *   to the same place (`place.ts`).
 *
 * The browser's own find-in-page sees only the rows that are drawn. The
 * search field, `/`, searches all of the library.
 *
 * Keys, for a reader who lives here: J and K move between posts, E opens and
 * closes a long one, M shows a post's media, O opens it on X, and C, R and T
 * open what it is filed under: its category, its format, its tags. None of
 * them animates anything.
 */
import {
  defaultRangeExtractor,
  type Range,
  useWindowVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { LoaderCircle } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  headingFor,
  isItemRow,
  type ListRow,
  listRows,
  nextItemRow,
} from "@/lib/list-rows";
import type { ItemView } from "@/lib/post-view";
import { LIST_KEYS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { loadMore } from "./load-more.ts";
import { placeKey, readPlace, writePlace } from "./place.ts";
import { PostItem, WithheldItem } from "./post-item.tsx";
import { type RowMemory, RowMemoryProvider } from "./row-memory.tsx";

/** Rows drawn beyond the screen, above and below, so a scroll never outruns them. */
const OVERSCAN = 3;
/** What a row is taken to measure until it has been drawn once, in pixels. */
const ESTIMATE = { heading: 45, note: 84, post: 380, withheld: 61 } as const;
/** The most items one request brings a reader returning to a place far down. */
const RETURN_PAGE = 100;
/** The search bar and the month under it: what a row scrolled to must clear. */
const HEADER_PX = 56;

/** The line that ends an item. It is the row's, which has square corners. */
const DIVIDED = "border-b";

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Whether a key was pressed in something that is open over the list: a menu,
 * a list of choices, a dialog. Its keys are its own, a letter typed to find
 * a choice among them.
 */
const isOverTheList = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest(
    '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
  ) !== null;

/** The key that opens each part of what a post is filed under. */
const LABEL_KEYS: Record<string, string> = {
  c: "category",
  r: "format",
  t: "tags",
};

function Row({ row, total }: { row: ListRow; total: number }) {
  switch (row.kind) {
    case "heading":
      return (
        <h2 className="-mx-1 border-b bg-background/90 px-1 py-2.5 font-semibold text-[0.9375rem] leading-snug backdrop-blur-sm">
          {row.label}
        </h2>
      );
    case "note":
      return (
        <p className="max-w-prose pt-4 pb-1 text-[0.875rem] text-muted-foreground leading-normal">
          These are still in your bookmarks on X, but X no longer sends them:
          each post was deleted, or its author’s account is protected or
          suspended. The library never captured them, so only their ids are
          known.
        </p>
      );
    case "post":
      return <PostItem post={row.item} position={row.position} total={total} />;
    case "withheld":
      return (
        <WithheldItem post={row.item} position={row.position} total={total} />
      );
  }
}

export function LibraryList({
  initialItems,
  initialCursor,
  search,
  ranked,
  total,
}: {
  initialItems: ItemView[];
  initialCursor: string | null;
  /** The page's query string, which names the search to continue. */
  search: string;
  /** Whether the items are a search's, best match first. */
  ranked: boolean;
  /** How many items the search matches, loaded or not. */
  total: number;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // The request in flight, so that two triggers never ask for the same page.
  const asking = useRef(false);

  const rows = useMemo(() => listRows(items, ranked), [items, ranked]);
  const rowsNow = useRef(rows);
  rowsNow.current = rows;

  // Where the reader was, if this entry of the browser's history has been
  // here before. Read once, in the browser; the server knows of none.
  const [place] = useState(() => readPlace(search));
  /**
   * Going back to it: not begun, as on the server and in the first moment
   * here; loading the items the reader had; or there, with them in hand.
   */
  const [back, setBack] = useState<"not-begun" | "loading" | "there">(
    "not-begun",
  );
  const returning = back === "loading";
  /** Whether the list is where it will be: nowhere to return to, or returned. */
  const settled = place === null || back === "there";

  // Until the page is live the first rows are laid out as plain blocks, as
  // the server sent them. Then they are placed one by one, and counted.
  const [live, setLive] = useState(false);
  /** How far down the page the list begins. */
  const [listTop, setListTop] = useState(0);

  // Rows that stay in the page wherever it is scrolled to: those showing
  // media from X, and the one with the keyboard's focus.
  const pinned = useRef(new Set<string>());
  const [pins, setPins] = useState(0);
  const [focused, setFocused] = useState(-1);
  const memory = useRef(new Map<string, unknown>());
  const memories = useRef(new Map<string, RowMemory>());
  const memoryOf = (row: string): RowMemory => {
    let known = memories.current.get(row);
    if (known === undefined) {
      known = {
        recall: (key, otherwise) =>
          memory.current.has(`${row}/${key}`)
            ? (memory.current.get(`${row}/${key}`) as typeof otherwise)
            : otherwise,
        remember: (key, value) => memory.current.set(`${row}/${key}`, value),
        pin: () => {
          if (pinned.current.has(row)) return;
          pinned.current.add(row);
          setPins((count) => count + 1);
        },
      };
      memories.current.set(row, known);
    }
    return known;
  };

  const indexOf = useMemo(
    () => new Map(rows.map((row, index) => [row.key, index])),
    [rows],
  );
  const virtualizerNow = useRef<Virtualizer<Window, HTMLDivElement> | null>(
    null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pins` counts the pinned rows, which are kept in a ref; a new pin has to redraw.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const drawn = new Set(defaultRangeExtractor(range));
      // The month of the row under the search bar, which stays in view.
      const top = virtualizerNow.current?.getVirtualItemForOffset(
        (virtualizerNow.current.scrollOffset ?? 0) + HEADER_PX,
      );
      const heading = headingFor(rows, top?.index ?? range.startIndex);
      if (heading !== -1) drawn.add(heading);
      if (focused >= 0 && focused < rows.length) drawn.add(focused);
      for (const key of pinned.current) {
        const index = indexOf.get(key);
        if (index !== undefined) drawn.add(index);
      }
      return [...drawn].sort((a, b) => a - b);
    },
    [rows, indexOf, focused, pins],
  );

  const virtualizer = useWindowVirtualizer<HTMLDivElement>({
    count: rows.length,
    estimateSize: (index) => ESTIMATE[rows[index]?.kind ?? "post"],
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin: listTop,
    rangeExtractor,
    initialMeasurementsCache: place?.sizes ?? [],
    enabled: live,
  });
  virtualizerNow.current = virtualizer;

  useLayoutEffect(() => {
    const node = list.current;
    if (node === null) return;
    const measure = () =>
      setListTop(Math.round(node.getBoundingClientRect().top + window.scrollY));
    measure();
    setLive(true);
    // A banner above the list can come and go, and move where it begins.
    const observer = new ResizeObserver(measure);
    if (node.parentElement !== null) observer.observe(node.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const more = useCallback(async () => {
    if (cursor === null || asking.current) return;
    asking.current = true;
    setState("loading");
    try {
      const page = await loadMore(search, cursor);
      // A search is paged by position, so a capture that arrives between
      // two pages can send an item a second time. It is shown once.
      setItems((shown) => {
        const ids = new Set(shown.map((item) => item.id));
        return [...shown, ...page.items.filter((item) => !ids.has(item.id))];
      });
      setCursor(page.nextCursor);
      setState("idle");
    } catch {
      setState("failed");
    } finally {
      asking.current = false;
    }
  }, [cursor, search]);

  // A reader who was further down than the first page: the items they had
  // are asked for again, from this app, and then the page goes where it was.
  useEffect(() => {
    if (place === null || back !== "not-begun") return;
    if (place.loaded <= initialItems.length) {
      setBack("there");
      return;
    }
    setBack("loading");
  }, [place, back, initialItems.length]);
  useEffect(() => {
    if (place === null || back !== "loading") return;
    let left = false;
    const load = async () => {
      let shown = initialItems;
      let next = initialCursor;
      try {
        while (!left && next !== null && shown.length < place.loaded) {
          const page = await loadMore(search, next, RETURN_PAGE);
          const ids = new Set(shown.map((item) => item.id));
          shown = [...shown, ...page.items.filter((item) => !ids.has(item.id))];
          next = page.nextCursor;
        }
      } catch {
        // What was reached is shown, and the rest loads as the reader scrolls.
      }
      if (left) return;
      setItems(shown);
      setCursor(next);
      setBack("there");
    };
    void load();
    return () => {
      left = true;
    };
  }, [place, back, search, initialItems, initialCursor]);
  // Once the rows the reader had are placed, the page goes where it was.
  const replaced = useRef(false);
  useLayoutEffect(() => {
    if (place === null || !live || back !== "there" || replaced.current) {
      return;
    }
    replaced.current = true;
    window.scrollTo(0, place.offset);
  }, [place, live, back]);

  // The place is kept as the reader moves: a moment after the page comes to
  // rest, and as it is left.
  useEffect(() => {
    if (!live || !settled || placeKey() === null) return;
    // The browser would put the page back where it was before the rows it
    // was at exist. The list does it, once they do.
    const restoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    let timer: number | undefined;
    // The entry this list is in: the one to write to even as it is left,
    // when the browser may already be at another.
    const entry = placeKey();
    const keep = () => {
      const now = virtualizerNow.current;
      if (now === null || entry === null) return;
      writePlace(entry, {
        search,
        loaded: items.length,
        offset: Math.round(window.scrollY),
        sizes: now.takeSnapshot(),
      });
    };
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(keep, 150);
    };
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("pagehide", keep);
    return () => {
      // Not kept once more here: by the time the list is taken away the
      // page is already scrolled for whatever replaces it.
      window.clearTimeout(timer);
      window.removeEventListener("scroll", soon);
      window.removeEventListener("pagehide", keep);
      window.history.scrollRestoration = restoration;
    };
  }, [live, settled, search, items.length]);

  // Ask for the next page a little before the reader reaches the end. After
  // a failure the reader asks again by hand, so a server that is down is not
  // asked in a loop.
  useEffect(() => {
    const node = sentinel.current;
    if (node === null || cursor === null || state === "failed" || returning) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void more();
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, state, more, returning]);

  // The row the keyboard is in stays in the page while it is.
  useEffect(() => {
    const node = list.current;
    if (node === null) return;
    const rowOf = (target: EventTarget | null) =>
      target instanceof Element
        ? Number(target.closest<HTMLElement>("[data-row]")?.dataset.index ?? -1)
        : -1;
    const onIn = (event: FocusEvent) => setFocused(rowOf(event.target));
    const onOut = (event: FocusEvent) => {
      if (rowOf(event.relatedTarget) === -1) setFocused(-1);
    };
    node.addEventListener("focusin", onIn);
    node.addEventListener("focusout", onOut);
    return () => {
      node.removeEventListener("focusin", onIn);
      node.removeEventListener("focusout", onOut);
    };
  }, []);

  useEffect(() => {
    const drawn = (index: number) =>
      list.current?.querySelector<HTMLElement>(
        `[data-row][data-index="${index}"] [data-post]`,
      ) ?? null;
    /** Puts the keyboard on a row, drawing it first if it is not in the page. */
    const go = (index: number) => {
      const land = (post: HTMLElement) => {
        post.focus({ preventScroll: true });
        post.scrollIntoView({ block: "start" });
      };
      const post = drawn(index);
      if (post !== null) return land(post);
      virtualizerNow.current?.scrollToIndex(index, { align: "start" });
      let tries = 0;
      const wait = () => {
        const arrived = drawn(index);
        if (arrived !== null) land(arrived);
        else if (tries++ < 30) requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target) ||
        isOverTheList(event.target)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (!LIST_KEYS.includes(key)) return;
      const post =
        document.activeElement?.closest<HTMLElement>("[data-post]") ?? null;
      const at = Number(
        post?.closest<HTMLElement>("[data-row]")?.dataset.index ?? -1,
      );
      if (key === "j" || key === "k") {
        let next: number;
        if (at === -1) {
          // With nothing chosen yet, start from the first post in view.
          const first = Array.from(
            list.current?.querySelectorAll<HTMLElement>("[data-post]") ?? [],
          ).find((row) => row.getBoundingClientRect().bottom > 120);
          next = Number(
            first?.closest<HTMLElement>("[data-row]")?.dataset.index ?? -1,
          );
        } else {
          next = nextItemRow(rowsNow.current, at, key === "j" ? 1 : -1);
          // At the first post, K stays on it.
          if (next === -1 && key === "k") next = at;
        }
        if (next === -1 || !isItemRow(rowsNow.current[next])) return;
        event.preventDefault();
        go(next);
        return;
      }
      if (post === null) return;
      if (key === "o" && post.dataset.url !== undefined) {
        // The owner's own navigation: a new tab, told nothing about this one.
        window.open(post.dataset.url, "_blank", "noopener,noreferrer");
      } else if (key === "e") {
        post.querySelector<HTMLElement>("[data-expand]")?.click();
      } else if (key === "m") {
        post.querySelector<HTMLElement>("[data-show-media]")?.click();
      } else if (LABEL_KEYS[key] !== undefined) {
        const control = post.querySelector<HTMLElement>(
          `[data-edit="${LABEL_KEYS[key]}"]`,
        );
        if (control === null) return;
        // The key must not also be typed into the field the control opens.
        event.preventDefault();
        control.click();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const drawn = live ? virtualizer.getVirtualItems() : [];
  const top = live
    ? (virtualizer.getVirtualItemForOffset(
        (virtualizer.scrollOffset ?? 0) + HEADER_PX,
      )?.index ?? 0)
    : 0;
  const stuck = headingFor(rows, top);

  return (
    <div className="flex flex-col">
      <div
        ref={list}
        data-list={live ? "live" : "static"}
        aria-busy={returning || undefined}
        className="relative [overflow-anchor:none]"
        style={live ? { height: virtualizer.getTotalSize() } : undefined}
      >
        {live
          ? drawn.map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              const sticks = item.index === stuck;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-row={row.kind}
                  data-index={item.index}
                  className={cn(
                    "w-full",
                    sticks
                      ? "sticky top-(--header-height) z-10"
                      : "absolute top-0 left-0",
                    isItemRow(row) && DIVIDED,
                  )}
                  style={
                    sticks
                      ? undefined
                      : {
                          transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                        }
                  }
                >
                  <RowMemoryProvider value={memoryOf(row.key)}>
                    <Row row={row} total={total} />
                  </RowMemoryProvider>
                </div>
              );
            })
          : rows.map((row, index) => (
              <div
                key={row.key}
                data-row={row.kind}
                data-index={index}
                className={cn(isItemRow(row) && DIVIDED)}
              >
                <RowMemoryProvider value={memoryOf(row.key)}>
                  <Row row={row} total={total} />
                </RowMemoryProvider>
              </div>
            ))}
      </div>

      <div
        ref={sentinel}
        className="flex min-h-24 flex-col items-center justify-center gap-2 py-8 text-[0.8125rem] text-muted-foreground"
      >
        {state === "failed" ? (
          <p role="alert" className="text-center text-foreground">
            The next bookmarks did not load. Check that the app is still
            running, then try again.
          </p>
        ) : null}
        {returning ? (
          <p role="status">Returning to where you were…</p>
        ) : cursor !== null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={state === "loading"}
            onClick={() => void more()}
          >
            {state === "loading" ? (
              <LoaderCircle
                data-icon="inline-start"
                aria-hidden="true"
                className="motion-safe:animate-spin"
              />
            ) : null}
            {state === "loading"
              ? "Loading more"
              : state === "failed"
                ? "Try again"
                : "Load more"}
          </Button>
        ) : (
          <p>End of the list.</p>
        )}
      </div>
    </div>
  );
}
