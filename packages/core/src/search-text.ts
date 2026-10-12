/**
 * The text side of search: turning what someone typed into a full-text
 * query, and cutting a post's text down to the part that matched. Pure
 * functions; `library.ts` runs the query.
 */

/** Whether a search finds bookmarks holding every word, or any of them. */
export type SearchMatch = "all" | "any";

/** A typed query, read into what the index is asked. */
export interface ParsedSearchQuery {
  /**
   * The words and phrases searched for, folded as the index folds them. Empty
   * when the query held nothing to search for.
   */
  terms: string[];
  /** The FTS5 query, or null when there are no terms. */
  expression: string | null;
}

/** A word this short is matched whole: as a prefix, `go` would find `google` and `good`. */
const SHORTEST_PREFIX = 3;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const WORD_CHARACTERS = /[\p{L}\p{N}]/gu;

/**
 * Writes the dotless and the dotted capital i as a plain `i`, one character
 * for one, as migration 5 does to the indexed text. Everything else the
 * index folds (case, accents) its tokenizer folds on both sides.
 */
function foldDotlessI(text: string): string {
  return text.replace(/[ıİ]/g, "i");
}

/**
 * Reads a query as typed into the query the index is asked.
 *
 * - Words are separated by spaces. With `all`, a bookmark must hold every
 *   one; with `any`, at least one, and those holding more rank higher.
 * - A word of three characters or more also matches as the start of a
 *   longer word (`agent` finds `agents`, `kitap` finds `kitaplar`), with the
 *   exact word ranked above the longer ones.
 * - Words inside double quotes are a phrase: those words, in that order,
 *   with nothing between them.
 * - Case, accents and the Turkish dotless i make no difference.
 *
 * Nothing typed is passed to the index as syntax: every term is quoted, so
 * `AND`, `*`, `:` and the rest are searched for as text or ignored.
 */
export function parseSearchQuery(
  query: string,
  match: SearchMatch = "all",
): ParsedSearchQuery {
  const terms: string[] = [];
  const clauses: string[] = [];
  for (const [, phrase, word] of foldDotlessI(query).matchAll(
    /"([^"]*)"|([^\s"]+)/g,
  )) {
    const term = (phrase ?? word ?? "").trim().toLowerCase();
    if (!WORD_CHARACTER.test(term)) continue;
    terms.push(term);
    // Quoted for FTS5: a string, in which a double quote is written twice.
    const quoted = `"${term.replaceAll('"', '""')}"`;
    const prefixed =
      phrase === undefined &&
      (term.match(WORD_CHARACTERS)?.length ?? 0) >= SHORTEST_PREFIX;
    clauses.push(prefixed ? `(${quoted} OR ${quoted}*)` : quoted);
  }
  return {
    terms,
    expression:
      clauses.length === 0
        ? null
        : clauses.join(match === "all" ? " AND " : " OR "),
  };
}

/** A text folded the way the index folds it, with where each folded character came from. */
function folded(text: string): { text: string; origin: number[] } {
  let result = "";
  const origin: number[] = [];
  let position = 0;
  for (const character of text) {
    const plain = foldDotlessI(character)
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "");
    for (let index = 0; index < plain.length; index++) origin.push(position);
    result += plain;
    position += character.length;
  }
  return { text: result, origin };
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NOT_A_WORD_CHARACTER = "[^\\p{L}\\p{N}]";

/**
 * A pattern that finds `terms` in a folded text where the index finds them:
 * at the start of a word, the words of a term in order with anything but a
 * word between them, and a term too short to be a prefix only as a whole
 * word. Null when no term holds a word.
 */
function finder(terms: readonly string[]): RegExp | null {
  const wanted: string[] = [];
  for (const term of terms) {
    const words = folded(term).text.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.length === 0) continue;
    const whole = [...words.join("")].length < SHORTEST_PREFIX;
    wanted.push(
      `${words.map(escapeRegExp).join(`${NOT_A_WORD_CHARACTER}+`)}${whole ? "(?![\\p{L}\\p{N}])" : ""}`,
    );
  }
  return wanted.length === 0
    ? null
    : new RegExp(`(?<![\\p{L}\\p{N}])(?:${wanted.join("|")})`, "gu");
}

/** Where in `text` the first of `terms` begins a word, or -1. */
function firstMatch(text: string, terms: readonly string[]): number {
  const pattern = finder(terms);
  if (pattern === null) return -1;
  const haystack = folded(text);
  const found = pattern.exec(haystack.text);
  return found === null ? -1 : (haystack.origin[found.index] ?? -1);
}

/** A stretch of a text, and whether a searched-for term was found in it. */
export interface MarkedText {
  text: string;
  marked: boolean;
}

/**
 * `text` cut into the stretches where one of `terms` is found and the
 * stretches between them, in order, to show a reader why a bookmark matched.
 * `terms` are as `searchBookmarks` returns them, and a term is found as the
 * search finds it: whatever its case and accents, at the start of a word,
 * and for a term shorter than three characters only as a whole word. A text
 * no term is found in comes back as one unmarked stretch.
 */
export function markMatches(
  text: string,
  terms: readonly string[],
): MarkedText[] {
  const pattern = finder(terms);
  if (pattern === null || text === "") return [{ text, marked: false }];
  const haystack = folded(text);
  const pieces: MarkedText[] = [];
  let position = 0;
  for (const found of haystack.text.matchAll(pattern)) {
    const from = haystack.origin[found.index] ?? text.length;
    // A character that folds to several ends where the next one begins.
    let end = found.index + found[0].length;
    while (
      end < haystack.origin.length &&
      haystack.origin[end] === haystack.origin[end - 1]
    ) {
      end += 1;
    }
    const to = haystack.origin[end] ?? text.length;
    if (from > position) {
      pieces.push({ text: text.slice(position, from), marked: false });
    }
    pieces.push({ text: text.slice(from, to), marked: true });
    position = to;
  }
  if (pieces.length === 0) return [{ text, marked: false }];
  if (position < text.length) {
    pieces.push({ text: text.slice(position), marked: false });
  }
  return pieces;
}

const ELLIPSIS = "…";
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * At most `maxLength` characters of `text`, cut at spaces where it can be,
 * with an ellipsis at each end that was cut. A text that fits is returned
 * whole. Given `terms`, as `searchBookmarks` returns them, the cut is placed
 * around the first one found in the text, and at the start when none is: a
 * search can match a bookmark by its author or its quoted post alone.
 */
export function excerpt(
  text: string,
  maxLength: number,
  terms: readonly string[] = [],
): string {
  if (text.length <= maxLength) return text;
  const match = firstMatch(text, terms);
  // A quarter of the room goes before the match, the rest after it.
  let start = Math.max(0, match - Math.floor(maxLength / 4));
  if (start + maxLength >= text.length) start = text.length - maxLength;
  let end = Math.min(text.length, start + maxLength);

  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < Math.max(match, start + maxLength / 4)) {
      start = space + 1;
    }
    if (isLowSurrogate(text.charCodeAt(start))) start += 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + maxLength / 2) end = space;
    if (isLowSurrogate(text.charCodeAt(end))) end -= 1;
  }
  return `${start > 0 ? ELLIPSIS : ""}${text.slice(start, end).trim()}${end < text.length ? ELLIPSIS : ""}`;
}
