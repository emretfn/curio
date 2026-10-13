"use client";

/**
 * What a bookmark can be filed under, held once by the page for every row
 * on it: the taxonomy's categories and formats, with the names a person
 * reads, and the vocabulary's tags as it stands. A row's labels are ids;
 * this is where their names come from, and what its menus offer.
 *
 * The server builds it from core's `TAXONOMY` and vocabulary (`labelChoices`
 * in `src/server/library.ts`), so no category, format or tag is written in
 * any component.
 */
import { createContext, type ReactNode, useContext } from "react";

export interface LabelChoice {
  id: string;
  label: string;
  /** What belongs under it, in the taxonomy's own words. */
  definition: string;
}

export interface LabelChoices {
  categories: LabelChoice[];
  formats: LabelChoice[];
  /** The vocabulary's tags, in alphabetical order, each with the other ways it is written. */
  tags: { tag: string; aliases: string[] }[];
}

const LabelChoicesContext = createContext<LabelChoices>({
  categories: [],
  formats: [],
  tags: [],
});

export function LabelChoicesProvider({
  choices,
  children,
}: {
  choices: LabelChoices;
  children: ReactNode;
}) {
  return (
    <LabelChoicesContext.Provider value={choices}>
      {children}
    </LabelChoicesContext.Provider>
  );
}

export const useLabelChoices = (): LabelChoices =>
  useContext(LabelChoicesContext);

/** The name of a category or a format. An id the taxonomy no longer holds is shown as it is stored. */
export const labelOf = (choices: readonly LabelChoice[], id: string): string =>
  choices.find((choice) => choice.id === id)?.label ?? id;
