"use client";

/**
 * What a row of the list remembers while it is out of the page.
 *
 * Only the rows near the screen are rendered, so a row that scrolls away is
 * unmounted and comes back as new. Two things keep that from showing:
 *
 * - what the reader did to a row and can be done again for nothing, such as
 *   opening a long text, is remembered here and found again when the row
 *   returns;
 * - a row that is showing media from X is pinned: it stays in the page
 *   wherever the list is scrolled to, so that its pictures are never asked
 *   for a second time and a video in it plays on, where it is.
 *
 * Outside a list there is nothing to remember and nothing to pin.
 */
import { createContext, useCallback, useContext, useState } from "react";

export interface RowMemory {
  recall<T>(key: string, otherwise: T): T;
  remember(key: string, value: unknown): void;
  /** Keeps this row in the page from now on. */
  pin(): void;
}

const RowMemoryContext = createContext<RowMemory>({
  recall: (_, otherwise) => otherwise,
  remember() {},
  pin() {},
});

export const RowMemoryProvider = RowMemoryContext.Provider;

/** State that a row keeps across leaving the page and coming back. */
export function useRemembered<T>(
  key: string,
  initial: T,
): [T, (value: T) => void] {
  const memory = useContext(RowMemoryContext);
  const [value, setValue] = useState(() => memory.recall(key, initial));
  const set = useCallback(
    (next: T) => {
      memory.remember(key, next);
      setValue(next);
    },
    [memory, key],
  );
  return [value, set];
}

/** Keeps the row this is in rendered from now on. */
export function usePinRow(): () => void {
  return useContext(RowMemoryContext).pin;
}
