"use client";

/**
 * The choice between a list and the screen that says there is nothing to
 * list. It is made once for a query, when the reader arrives, and a list
 * that has been shown stays: a correction made in it can leave the query
 * matching nothing, and the page is read again from the server after every
 * correction. Were the choice made again then, the row just corrected would
 * go from under the keyboard, with the menu that was open on it, and the
 * rest of what the reader meant to do to it could not be done.
 *
 * The server gives it a new `key` for each query, so a new search starts
 * over.
 */
import { type ReactNode, useState } from "react";

export function Listing({
  total,
  empty,
  children,
}: {
  /** How many items the query matches, as the server last counted. */
  total: number;
  /** What to show while the query has matched nothing since the reader arrived. */
  empty: ReactNode;
  /** The list. */
  children: ReactNode;
}) {
  const [listed, setListed] = useState(total > 0);
  // Something to list has arrived since: a capture, a correction elsewhere.
  if (total > 0 && !listed) setListed(true);
  return listed ? children : empty;
}
