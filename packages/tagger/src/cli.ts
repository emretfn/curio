/**
 * `pnpm tag`: the classifier, as the owner runs it. See the README beside
 * this package for the order to run things in.
 *
 * What it prints is counts and money, never a bookmark. A failure ends with
 * a non-zero exit code and its reason.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  getVocabulary,
  listTagProposals,
  listTags,
  openStore,
  summariseTagging,
} from "@curio/core";
import { createClaude } from "./anthropic.ts";
import {
  APP_TAGGING_VARIABLE,
  ApiKeyUnavailable,
  appTagging,
  dataDirectory,
  envFilePath,
  KEY_VARIABLE,
  readApiKey,
  standardKeyWarning,
} from "./api-key.ts";
import { INSTRUCTIONS_VERSION } from "./instructions.ts";
import { usd } from "./pricing.ts";
import { describePlan, describeReport, describeStanding } from "./report.ts";
import {
  DEFAULT_BATCH_WAIT_MS,
  DEFAULT_CAP_USD,
  DEFAULT_SAMPLE,
  planTagging,
  type RunProgress,
  runTagging,
  type TaggingMode,
} from "./run.ts";

const HELP = `
pnpm tag [options]

Classifies bookmarks with Claude: one category, one format and a few tags each.
With no option it classifies every bookmark that has not been classified yet.

  --dry-run          Say what a run would send and cost. No request, no key, no change.
  --sample [n]       Classify a sample of n unclassified bookmarks (default ${DEFAULT_SAMPLE}),
                     drawn from across the library, one request at a time.
  --retag            Classify again the bookmarks made under an older taxonomy or
                     older instructions. Your own corrections are kept.
  --new-tags         Ask again about bookmarks classified before a tag was added to
                     the vocabulary and whose text mentions it. Only such tags are
                     added; category, format and other tags stay as they are.
  --every-bookmark   With --new-tags: ask every bookmark classified before a tag was
                     added, whether its text mentions the tag or not.
  --limit <n>        Take at most n bookmarks.
  --max-usd <x>      The most this run may spend, in US dollars (default ${DEFAULT_CAP_USD}).
  --direct, --batch  Send one request at a time, which is the usual way and the cheaper,
                     or as one batch, which has no rate limit.
  --wait <minutes>   How long to wait for a batch before leaving it to the next run (default ${DEFAULT_BATCH_WAIT_MS / 60_000}).
  --retry-failed     Also bookmarks the classifier has already failed on twice.
  --check            Check that the API key is in place in .env and the file is safe, and
                     say whether the app may tag by itself. No request.
  --status           Say how the tagging of the library stands, and whether the app
                     may tag by itself. No request.
  --proposals [n]    List the tags the classifier suggested beyond the vocabulary that
                     were suggested for n bookmarks or more (default 2), alike ones together.
  --tags             List the vocabulary: every tag, how many bookmarks have it, its other names.
  --help             This text.

Every run of this command is yours to start, and none needs the app. The app
classifies by itself only if .env holds the line ${APP_TAGGING_VARIABLE}=on,
which is yours to write: without it the app sends nothing and spends nothing.
`;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function positive(name: string, value: string, whole: boolean): number {
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number <= 0 ||
    (whole && !Number.isInteger(number))
  ) {
    fail(
      `--${name} takes a ${whole ? "whole " : ""}number above zero; got "${value}".`,
    );
  }
  return number;
}

function options() {
  try {
    // `pnpm tag -- --dry-run` hands the separator on as well.
    const args = process.argv.slice(2).filter((arg) => arg !== "--");
    // A bare --sample takes the default size, and a bare --proposals the default threshold.
    for (const [flag, value] of [
      ["--sample", String(DEFAULT_SAMPLE)],
      ["--proposals", "2"],
    ] as const) {
      const at = args.indexOf(flag);
      if (at !== -1 && !/^\d+$/.test(args[at + 1] ?? "")) {
        args.splice(at + 1, 0, value);
      }
    }
    return parseArgs({
      args,
      options: {
        "dry-run": { type: "boolean", default: false },
        sample: { type: "string" },
        retag: { type: "boolean", default: false },
        "new-tags": { type: "boolean", default: false },
        "every-bookmark": { type: "boolean", default: false },
        tags: { type: "boolean", default: false },
        limit: { type: "string" },
        "max-usd": { type: "string" },
        direct: { type: "boolean", default: false },
        batch: { type: "boolean", default: false },
        wait: { type: "string" },
        "retry-failed": { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        status: { type: "boolean", default: false },
        proposals: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : "The options could not be read."}\n${HELP}`,
    );
  }
}

const chosen = options();
if (chosen.help) {
  console.log(HELP);
  process.exit(0);
}
if (
  [chosen.sample !== undefined, chosen.retag, chosen["new-tags"]].filter(
    Boolean,
  ).length > 1
) {
  fail("--sample, --retag and --new-tags are different runs. Choose one.");
}
if (chosen["every-bookmark"] && !chosen["new-tags"]) {
  fail("--every-bookmark goes with --new-tags.");
}
if (chosen.direct && chosen.batch) {
  fail("--direct and --batch are two different routes. Choose one.");
}

const directory = dataDirectory();
const envFile = envFilePath();

/** The key from its file, after saying so if the standard variable is set somewhere: it is never used. */
function apiKeyOrRefusal(): string {
  const warning = standardKeyWarning(envFile);
  if (warning !== null) console.error(`\nNote: ${warning}`);
  try {
    return readApiKey(envFile);
  } catch (error) {
    if (error instanceof ApiKeyUnavailable) fail(error.message);
    throw error;
  }
}

if (chosen.check) {
  apiKeyOrRefusal();
  console.log(
    `\n${KEY_VARIABLE} is set in ${envFile}, and the file is readable by you alone.\nNo request was made, so this says nothing about whether the API accepts the key.\n\n${appTagging(envFile).message}\n`,
  );
  process.exit(0);
}

const mode: TaggingMode =
  chosen.sample !== undefined
    ? "sample"
    : chosen.retag
      ? "retag"
      : chosen["new-tags"]
        ? "new-tags"
        : "untagged";
const selection = {
  mode,
  everyBookmark: chosen["every-bookmark"],
  limit:
    chosen.limit !== undefined
      ? positive("limit", chosen.limit, true)
      : chosen.sample !== undefined
        ? positive("sample", chosen.sample, true)
        : undefined,
  retryFailed: chosen["retry-failed"],
  transport: chosen.direct
    ? ("direct" as const)
    : chosen.batch
      ? ("batch" as const)
      : undefined,
  capUsd:
    chosen["max-usd"] === undefined
      ? DEFAULT_CAP_USD
      : positive("max-usd", chosen["max-usd"], false),
};

// What only reads opens the library read-only, and so cannot change it.
const reading =
  chosen.status ||
  chosen.tags ||
  chosen.proposals !== undefined ||
  chosen["dry-run"];
let store: ReturnType<typeof openStore>;
try {
  store = openStore(join(directory, "bookmarks.db"), { readOnly: reading });
} catch (error) {
  fail(
    error instanceof Error ? error.message : "The library could not be opened.",
  );
}
try {
  if (chosen.status) {
    console.log(
      describeStanding(
        summariseTagging(store, { instructionsVersion: INSTRUCTIONS_VERSION }),
        getVocabulary(store),
      ),
    );
    console.log(`${appTagging(envFile).message}\n`);
  } else if (chosen.tags) {
    const tags = listTags(store, { includeRetired: true });
    console.log(
      [
        "",
        `The vocabulary, version ${getVocabulary(store).version}: each tag with how many bookmarks have it and its other names.`,
        "",
        ...tags.map(
          ({ tag, bookmarks, aliases, retiredAt }) =>
            `  ${String(bookmarks).padStart(5)}  ${tag}${retiredAt === null ? "" : "  (retired)"}${aliases.length === 0 ? "" : `  = ${aliases.join(", ")}`}`,
        ),
        "",
      ].join("\n"),
    );
  } else if (chosen.proposals !== undefined) {
    const minBookmarks = positive("proposals", chosen.proposals, true);
    const { total, belowThreshold, proposals } = listTagProposals(store, {
      limit: 100,
      minBookmarks,
    });
    console.log(
      [
        "",
        total === 0
          ? `No tag outside the vocabulary has been proposed for ${minBookmarks} bookmarks or more.`
          : `${total} subjects proposed for ${minBookmarks} bookmarks or more. None is on any bookmark. Names that look like the same subject are on one line; a tag in brackets is one of the vocabulary's that the names resemble:`,
        "",
        ...proposals.map(
          ({ bookmarks, variants, similarTags }) =>
            `  ${String(bookmarks).padStart(5)}  ${variants.map(({ proposal }) => proposal).join(", ")}${similarTags.length === 0 ? "" : `  [${similarTags.join(", ")}]`}`,
        ),
        ...(belowThreshold === 0
          ? []
          : ["", `${belowThreshold} more were proposed for fewer.`]),
        "",
      ].join("\n"),
    );
  } else if (chosen["dry-run"]) {
    console.log(describePlan(planTagging(store, selection)));
  } else {
    const apiKey = apiKeyOrRefusal();
    let shown = 0;
    const onProgress = (progress: RunProgress) => {
      // One line now and then, to standard error, so that the report on
      // standard output stays whole.
      const done = progress.classified + progress.failed;
      if (progress.batchProcessing !== undefined) {
        console.error(
          `  waiting for the batch: ${progress.batchProcessing} requests still processing`,
        );
      } else if (done === progress.selected || done - shown >= 25) {
        shown = done;
        console.error(
          `  ${done} of ${progress.selected} done, ${usd(progress.costUsd)} spent`,
        );
      }
    };
    const report = await runTagging(store, {
      ...selection,
      claude: createClaude({ apiKey }),
      startedBy: "owner",
      batchWaitMs:
        chosen.wait === undefined
          ? DEFAULT_BATCH_WAIT_MS
          : positive("wait", chosen.wait, false) * 60_000,
      onProgress,
    });
    console.log(describeReport(report));
    if (report.status === "failed" || report.status === "busy") {
      process.exitCode = 1;
    }
  }
} finally {
  store.close();
}
