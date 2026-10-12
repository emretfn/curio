/**
 * The library's address bar: what the page's query string means, and the
 * query string for a given choice of filters. The whole state of the screen
 * is in the address, so a search can be bookmarked, reloaded and shared with
 * oneself.
 *
 *   /?q=words&has=media,quote&lang=tr&year=2025&author=123&on=withheld
 */
import {
  LIBRARY_LANGUAGES,
  type LibraryLanguage,
  type LibraryQuery,
  POST_FEATURES,
  type PostFeature,
  X_STANDINGS,
  type XStanding,
} from "./library.ts";

export interface LibraryParams {
  q: string;
  has: PostFeature[];
  lang: LibraryLanguage | undefined;
  year: number | undefined;
  author: string | undefined;
  on: XStanding | undefined;
}

export const NO_PARAMS: LibraryParams = {
  q: "",
  has: [],
  lang: undefined,
  year: undefined,
  author: undefined,
  on: undefined,
};

const MAX_SEARCH_LENGTH = 200;

function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

/** Reads a query string. Anything it does not recognise is dropped, never trusted. */
export function parseLibraryParams(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
): LibraryParams {
  const get = (name: string): string | undefined => {
    if (input instanceof URLSearchParams) return input.get(name) ?? undefined;
    const value = input[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const asked = new Set((get("has") ?? "").split(","));
  const year = Number(get("year"));
  const author = get("author");
  return {
    q: (get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
    has: POST_FEATURES.filter((feature) => asked.has(feature)),
    lang: oneOf(LIBRARY_LANGUAGES, get("lang")),
    year:
      Number.isInteger(year) && year >= 2006 && year <= 9999 ? year : undefined,
    author:
      author !== undefined && /^[0-9]{1,20}$/.test(author) ? author : undefined,
    on: oneOf(X_STANDINGS, get("on")),
  };
}

/** The query a set of parameters asks for. A year is that calendar year, in the server's time zone. */
export function toLibraryQuery(params: LibraryParams): LibraryQuery {
  return {
    text: params.q,
    features: params.has,
    language: params.lang,
    savedFrom:
      params.year === undefined ? undefined : new Date(params.year, 0, 1),
    savedBefore:
      params.year === undefined ? undefined : new Date(params.year + 1, 0, 1),
    authorId: params.author,
    standing: params.on,
  };
}

/** The address of the library with these parameters. */
export function libraryHref(params: LibraryParams): string {
  const search = new URLSearchParams();
  if (params.q !== "") search.set("q", params.q);
  if (params.has.length > 0) search.set("has", params.has.join(","));
  if (params.lang !== undefined) search.set("lang", params.lang);
  if (params.year !== undefined) search.set("year", String(params.year));
  if (params.author !== undefined) search.set("author", params.author);
  if (params.on !== undefined) search.set("on", params.on);
  const query = search.toString();
  return query === "" ? "/" : `/?${query}`;
}

/** Whether anything narrows the library. */
export function isNarrowed(params: LibraryParams): boolean {
  return libraryHref(params) !== "/";
}

/** The same parameters with one feature switched on or off. */
export function toggleFeature(
  params: LibraryParams,
  feature: PostFeature,
): LibraryParams {
  const has = params.has.includes(feature)
    ? params.has.filter((other) => other !== feature)
    : POST_FEATURES.filter(
        (other) => other === feature || params.has.includes(other),
      );
  return { ...params, has };
}
