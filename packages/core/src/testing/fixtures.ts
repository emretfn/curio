import { readFileSync } from "node:fs";

/**
 * The text of a committed fixture, by its path under
 * `src/parsers/fixtures`, such as
 * `x-web-client/Bookmarks/2026-10-12-media.json`. Fixtures are redacted
 * responses: real structure, invented content.
 */
export function readFixture(path: string): string {
  return readFileSync(
    new URL(`../parsers/fixtures/${path}`, import.meta.url),
    "utf8",
  );
}
