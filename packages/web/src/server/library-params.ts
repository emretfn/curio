/**
 * The library's address bar: what the page's query string means, and the
 * query string for a given choice of filters. The whole state of the screen
 * is in the address, so a search can be bookmarked, reloaded and shared with
 * oneself.
 *
 *   /?q=words&has=media,quote&lang=tr&year=2025&author=123&on=withheld
 *    &cat=<category>&fmt=<format>&tag=<tag>,<tag>
 *
 * `cat` is a category of the taxonomy, or `none` for what is filed under no
 * category yet; with `cat=other`, `text=little` or `text=enough` picks one of
 * the two reasons a bookmark is there. `proposed` names a tag the classifier
 * proposed, for the bookmarks it proposed it for.
 */
import { OTHER_CATEGORY, TAXONOMY } from "./core.ts";
import {
  LIBRARY_LANGUAGES,
  type LibraryLanguage,
  type LibraryQuery,
  NOT_CLASSIFIED,
  OTHER_REASONS,
  type OtherReason,
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
  /** A category id, or `none`. */
  cat: string | undefined;
  /** Only beside `cat=other`. */
  text: OtherReason | undefined;
  fmt: string | undefined;
  /** As typed into the address: a tag, or another way of writing one. */
  tag: string[];
  proposed: string | undefined;
}

export const NO_PARAMS: LibraryParams = {
  q: "",
  has: [],
  lang: undefined,
  year: undefined,
  author: undefined,
  on: undefined,
  cat: undefined,
  text: undefined,
  fmt: undefined,
  tag: [],
  proposed: undefined,
};

const MAX_SEARCH_LENGTH = 200;
/** More tags than a bookmark is ever given find nothing, and an address is not a place for a list. */
const MAX_TAGS = 8;
const MAX_TAG_TEXT = 64;

function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

const CATEGORIES = [NOT_CLASSIFIED, ...TAXONOMY.categories.map(({ id }) => id)];
const FORMATS = TAXONOMY.formats.map(({ id }) => id);

/** A name as an address may carry one: short, and of one line. */
function nameOf(value: string | undefined): string | undefined {
  const name = (value ?? "").trim();
  return name === "" || name.length > MAX_TAG_TEXT || /[\n\r,]/.test(name)
    ? undefined
    : name;
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
  const cat = oneOf(CATEGORIES, get("cat"));
  const tags = new Set(
    (get("tag") ?? "")
      .split(",")
      .map(nameOf)
      .filter((tag) => tag !== undefined),
  );
  return {
    q: (get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
    has: POST_FEATURES.filter((feature) => asked.has(feature)),
    lang: oneOf(LIBRARY_LANGUAGES, get("lang")),
    year:
      Number.isInteger(year) && year >= 2006 && year <= 9999 ? year : undefined,
    author:
      author !== undefined && /^[0-9]{1,20}$/.test(author) ? author : undefined,
    on: oneOf(X_STANDINGS, get("on")),
    cat,
    text:
      cat === OTHER_CATEGORY ? oneOf(OTHER_REASONS, get("text")) : undefined,
    fmt: oneOf(FORMATS, get("fmt")),
    tag: [...tags].slice(0, MAX_TAGS),
    proposed: nameOf(get("proposed")),
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
    category: params.cat,
    otherReason: params.text,
    format: params.fmt,
    tags: params.tag,
    proposedTag: params.proposed,
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
  if (params.cat !== undefined) search.set("cat", params.cat);
  if (params.cat === OTHER_CATEGORY && params.text !== undefined) {
    search.set("text", params.text);
  }
  if (params.fmt !== undefined) search.set("fmt", params.fmt);
  if (params.tag.length > 0) search.set("tag", params.tag.join(","));
  if (params.proposed !== undefined) search.set("proposed", params.proposed);
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

/** The same parameters with one category chosen, or let go when it is the one chosen. */
export function toggleCategory(
  params: LibraryParams,
  cat: string,
  text?: OtherReason,
): LibraryParams {
  const chosen = params.cat === cat && params.text === text;
  return {
    ...params,
    cat: chosen ? undefined : cat,
    text: chosen ? undefined : text,
  };
}

/** The same parameters with one tag added, or taken off when it is there. */
export function toggleTag(params: LibraryParams, tag: string): LibraryParams {
  return {
    ...params,
    tag: params.tag.includes(tag)
      ? params.tag.filter((other) => other !== tag)
      : [...params.tag, tag],
  };
}
