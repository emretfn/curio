import { join } from "node:path";
import {
  listParseIssues,
  openStore,
  reparseAllCaptures,
  summariseParsing,
} from "./src/server/core.ts";
import { dataDirectory } from "./src/server/data-directory.ts";

// Parses every stored raw capture again with the current parsers and prints
// the totals. Run it after fixing or adding a parser. Raw captures are only
// read and no first-seen time moves, so it is safe to run at any time, also
// while the app is running, and a second run changes nothing.
//
// What it prints is structure: counts, and for anything not understood the
// path into the response and the field or type that was unexpected. It never
// prints a bookmark.
const store = openStore(join(dataDirectory(), "bookmarks.db"));
const { captures, changed } = reparseAllCaptures(store);
const summary = summariseParsing(store);
const issues = listParseIssues(store);
store.close();

const lines = [
  "",
  `Re-parsed ${captures} captures; the recorded result changed for ${changed}.`,
  "",
  `  Bookmarks                    ${summary.bookmarks}`,
  `  Captures parsed              ${summary.captures.parsed}`,
  `  Captures failed              ${summary.captures.failed}`,
  `  Captures with no parser yet  ${summary.captures.noParser}`,
  `  Entries failed               ${summary.failedEntries}`,
  `  Parts left empty             ${summary.warnings}`,
  `  Posts X withholds            ${summary.unavailableEntries}`,
  "",
];

// The same mismatch usually repeats across entries and captures, so issues
// are grouped by what went wrong and where, with positions blanked.
const groups = new Map<string, { count: number; captureIds: Set<number> }>();
for (const issue of issues) {
  if (issue.kind === "post-unavailable") continue;
  const where = issue.path.replace(/\[\d+\]/g, "[]");
  const key = `${issue.kind}  ${issue.code}\n      at ${where}\n      ${issue.detail}`;
  const group = groups.get(key) ?? { count: 0, captureIds: new Set() };
  group.count += 1;
  group.captureIds.add(issue.captureId);
  groups.set(key, group);
}
if (groups.size > 0) {
  lines.push("Not understood:", "");
  for (const [key, { count, captureIds }] of groups) {
    const ids = [...captureIds];
    lines.push(
      `  ${count} x ${key}`,
      `      in capture ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", ..." : ""}`,
      "",
    );
  }
}
console.log(lines.join("\n"));
