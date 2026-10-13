/**
 * `pnpm digest`: writes the summary of a week's bookmarks, as the owner
 * runs it or as the schedule the owner installed runs it. See the README
 * beside this package.
 *
 * What it prints is a week, counts and money, never a bookmark and never
 * the digest. A failure ends with a non-zero exit code and its reason.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  latestWeekEnded,
  listDigestRuns,
  openStore,
  type Week,
  weekOf,
} from "@curio/core";
import { createClaude } from "../anthropic.ts";
import {
  ApiKeyUnavailable,
  dataDirectory,
  envFilePath,
  readApiKey,
  standardKeyWarning,
} from "../api-key.ts";
import { MIN_DIGEST_BOOKMARKS } from "./input.ts";
import {
  describeDigestPlan,
  describeDigestReport,
  describeDigestRuns,
} from "./report.ts";
import { DEFAULT_DIGEST_CAP_USD, planDigest, writeDigest } from "./run.ts";

const HELP = `
pnpm digest [options]

Writes the weekly digest's summary with Claude: the themes of what you
bookmarked in a week, and what is worth going back to. One request a week.
With no option it writes the digest of the week that last reached its
Sunday evening, unless that week has one already.

  --dry-run        Say what would be sent and what it would cost. No request, no key, no change.
  --week <date>    The week to write, by any day of it: YYYY-MM-DD.
  --again          Write the week's digest again though it has one. The earlier one stays on record.
  --max-usd <x>    The most this run may spend, in US dollars (default ${DEFAULT_DIGEST_CAP_USD}).
  --scheduled      Record the run as started by the schedule. The launchd job passes it.
  --list           List the digests written so far and what each cost. No request.
  --help           This text.

A week with fewer than ${MIN_DIGEST_BOOKMARKS} bookmarks gets no summary: the page shows them as they are.
`;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function options() {
  try {
    // `pnpm digest -- --dry-run` hands the separator on as well.
    const args = process.argv.slice(2).filter((arg) => arg !== "--");
    return parseArgs({
      args,
      options: {
        "dry-run": { type: "boolean", default: false },
        week: { type: "string" },
        again: { type: "boolean", default: false },
        "max-usd": { type: "string" },
        scheduled: { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : "The options could not be read."}\n${HELP}`,
    );
  }
}

/** The week a date falls in. The date is a day on this computer's calendar. */
function weekNamed(text: string): Week {
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? [];
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    year === undefined ||
    Number.isNaN(date.getTime()) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    fail(`--week takes a day as YYYY-MM-DD; got "${text}".`);
  }
  return weekOf(date);
}

const chosen = options();
if (chosen.help) {
  console.log(HELP);
  process.exit(0);
}
const week =
  chosen.week === undefined
    ? latestWeekEnded(new Date())
    : weekNamed(chosen.week);
let capUsd = DEFAULT_DIGEST_CAP_USD;
if (chosen["max-usd"] !== undefined) {
  capUsd = Number(chosen["max-usd"]);
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    fail(`--max-usd takes a number above zero; got "${chosen["max-usd"]}".`);
  }
}

const envFile = envFilePath();
// What only reads opens the library read-only, and so cannot change it.
const reading = chosen.list || chosen["dry-run"];
let store: ReturnType<typeof openStore>;
try {
  store = openStore(join(dataDirectory(), "bookmarks.db"), {
    readOnly: reading,
  });
} catch (error) {
  fail(
    error instanceof Error ? error.message : "The library could not be opened.",
  );
}
try {
  if (chosen.list) {
    console.log(describeDigestRuns(listDigestRuns(store, { limit: 100 })));
  } else if (chosen["dry-run"]) {
    console.log(describeDigestPlan(planDigest(store, { week, capUsd })));
  } else {
    const warning = standardKeyWarning(envFile);
    if (warning !== null) console.error(`\nNote: ${warning}`);
    const report = await writeDigest(store, {
      week,
      // Asked for only when a request is about to be made. A week that has
      // its digest, or too few bookmarks for one, needs no key: so the
      // schedule runs with none set, and says so only when there is
      // something to write.
      claude: () => {
        try {
          return createClaude({ apiKey: readApiKey(envFile) });
        } catch (error) {
          if (error instanceof ApiKeyUnavailable) {
            store.close();
            fail(error.message);
          }
          throw error;
        }
      },
      startedBy: chosen.scheduled ? "schedule" : "owner",
      capUsd,
      again: chosen.again,
    });
    console.log(describeDigestReport(report));
    if (
      report.status === "failed" ||
      report.status === "busy" ||
      report.status === "over-cap"
    ) {
      process.exitCode = 1;
    }
  }
} finally {
  store.close();
}
