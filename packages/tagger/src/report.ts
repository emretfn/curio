/**
 * The words the command prints. Everything here is counts, ids of the
 * taxonomy, tokens and money: a plan or a report never quotes a post, an
 * author or an address (PRIV-5), so its output can be pasted anywhere.
 */
import {
  OTHER_CATEGORY,
  TAXONOMY,
  type TaggingSummary,
  UNCLEAR_FORMAT,
} from "@x-bookmarks/core";
import { INSTRUCTIONS_VERSION, MODEL } from "./instructions.ts";
import { usd } from "./pricing.ts";
import type { TaggingPlan, TaggingReport } from "./run.ts";

const number = (value: number) => value.toLocaleString("en-US");
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const range = (low: string, high: string) =>
  low === high ? low : `${low} to ${high}`;

const MODES = {
  sample:
    "a sample of the unclassified bookmarks, drawn from across the library",
  untagged: "every bookmark that has not been classified",
  retag:
    "every bookmark classified under an older taxonomy or older instructions",
  "new-tags":
    "bookmarks classified before a tag joined the vocabulary, to add that tag where it fits and change nothing else",
};

const ROUTES = {
  direct:
    "one request at a time, the instructions read from the prompt cache after the first",
  batch:
    "as one batch: half the listed price on every token, no prompt cache, no rate limit, answered within the hour as a rule",
};

/** Label and value in two columns. */
function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
}

function counts(title: string, values: Record<string, number>): string[] {
  const rows = Object.entries(values).toSorted(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  );
  if (rows.length === 0) return [];
  return [
    "",
    `${title}:`,
    ...table(rows.map(([id, value]) => [id, number(value)])),
  ];
}

/** What a dry run prints. */
export function describePlan(plan: TaggingPlan): string {
  const { estimate } = plan;
  const lines = [
    "",
    "Dry run. Nothing was sent, nothing was written, and no key was read.",
    "",
    `Mode: ${MODES[plan.mode]}.`,
    `Taxonomy version ${TAXONOMY.version}, instructions version ${INSTRUCTIONS_VERSION}, vocabulary version ${plan.vocabulary.version} (${number(plan.vocabulary.tags)} tags), model ${MODEL}.`,
    "",
    ...table([
      ["Bookmarks this mode covers", number(plan.candidates)],
      ["Taken by this run", number(plan.selected)],
      ["Would be sent to the API", number(plan.toSend)],
      [
        "Too little text to send",
        `${number(plan.tooLittleToSend)}  (filed as "${OTHER_CATEGORY}", too little text, without a request)`,
      ],
      [
        "Sent, but thin",
        `${number(plan.thin)}  (under 60 letters of words; the classifier may well say "too little text")`,
      ],
      [
        "Sent, cut to the text limit",
        `${number(plan.cut)}  (the opening of a long post is sent, not the whole)`,
      ],
    ]),
  ];
  if (plan.toSend === 0) {
    lines.push("", "There is nothing to send.");
    return [...lines, ""].join("\n");
  }
  lines.push(
    "",
    `Route: ${ROUTES[plan.transport]}.`,
    "",
    "Estimate, as a range, from the length of the text. The first real run replaces it with what the API counts:",
    ...table([
      [
        "Input tokens",
        range(
          number(estimate.inputTokens.few),
          number(estimate.inputTokens.many),
        ),
      ],
      [
        "Output tokens",
        range(
          number(estimate.outputTokens.few),
          number(estimate.outputTokens.many),
        ),
      ],
      ["Cost", range(usd(estimate.costUsd.few), usd(estimate.costUsd.many))],
    ]),
    ...(plan.measured === null
      ? []
      : [
          "",
          `Measured, not estimated: your last run by this route cost ${usd(plan.measured.usdPerBookmark)} a bookmark by the API's own count. At that rate these would cost about ${usd(plan.measured.costUsd)}.`,
        ]),
    "",
    ...table([
      ["Spend cap for the run", usd(plan.capUsd)],
      [
        "The most these requests could cost",
        `${usd(plan.mostUsd)}  (every token at its dearest, every answer at its longest)`,
      ],
    ]),
  );
  if (plan.transport === "batch" && plan.fitsCap < plan.toSend) {
    lines.push(
      "",
      `A batch cannot be stopped once it is sent, so only requests that fit under the cap at the most they could cost go into it: ${number(plan.fitsCap)} of ${number(plan.toSend)}. The rest wait for the next run, or for a higher --max-usd.`,
    );
  }
  return [...lines, ""].join("\n");
}

const STATUS = {
  completed: "The run completed.",
  "stopped-at-cap": "The run stopped at its spend cap.",
  failed: "The run failed.",
  "waiting-for-batch":
    "The batch is still being processed. Its results are paid for and kept by the API for 29 days: run pnpm tag again to collect them.",
  "nothing-to-do": "There is nothing to classify.",
  busy: "Another tagging run is open, so this one did not start.",
};

function standing(summary: TaggingSummary): string[] {
  const { other } = summary;
  return [
    "",
    "The library now:",
    ...table([
      ["Bookmarks", number(summary.bookmarks)],
      ["Classified", number(summary.classified)],
      ["Not classified yet", number(summary.unclassified)],
      ["  of which the classifier failed on", number(summary.failed)],
      ["Classified under older versions", number(summary.outdated)],
      [
        "Classified before a tag was added",
        `${number(summary.behindVocabulary)}  (never asked about that tag)`,
      ],
      [
        "  of which mention such a tag",
        `${number(summary.mentioningNewTags)}  (pnpm tag --new-tags asks these, and the app does by itself)`,
      ],
      ["Corrected by you", number(summary.corrected)],
      [
        `Filed under "${OTHER_CATEGORY}"`,
        `${number(other.bookmarks)}  (${percent(other.share)} of the filed)`,
      ],
      ["  too little text", number(other.tooLittleText)],
      [
        "  none of the categories fits",
        `${number(other.noneOfTheAbove)}  (${percent(other.noneOfTheAboveShare)}; when this grows, the taxonomy is missing a category)`,
      ],
      [`Format "${UNCLEAR_FORMAT}"`, number(summary.unclearFormat)],
      ["Tags proposed outside the vocabulary", number(summary.proposals)],
      ["Spent on tagging so far", usd(summary.spentUsd)],
    ]),
  ];
}

/** What a run prints when it ends. */
export function describeReport(report: TaggingReport): string {
  const lines = ["", STATUS[report.status]];
  if (report.failure !== null) lines.push(report.failure.message);
  if (report.status === "busy" && report.run !== null) {
    lines.push(
      `Run ${report.run.id}, started ${report.run.startedAt.toISOString()}, has not finished. If its process is gone it is set aside ten minutes after it last made progress.`,
    );
  }
  if (report.resumed) {
    lines.push(
      "This run took up the batch an earlier run had sent. Run again for anything that remains.",
    );
  }
  if (report.run !== null && report.status !== "busy") {
    const sent = report.classified - report.filedWithoutRequest + report.failed;
    const { usage } = report;
    lines.push(
      "",
      ...table([
        ["Bookmarks taken", number(report.selected)],
        ["Classified", number(report.classified)],
        [
          "  without a request, too little text",
          number(report.filedWithoutRequest),
        ],
        ["Failed", number(report.failed)],
        ...Object.entries(report.failures).map(
          ([reason, value]) => [`  ${reason}`, number(value)] as const,
        ),
        ["Left for the next run", number(report.left)],
      ]),
      "",
      `Used, as the API reported it${report.transport === null ? "" : ` (${report.transport})`}:`,
      ...table([
        ["Input tokens", number(usage.inputTokens)],
        ["  written to the prompt cache", number(usage.cacheWriteTokens)],
        ["  read from the prompt cache", number(usage.cacheReadTokens)],
        ["Output tokens", number(usage.outputTokens)],
        ["Cost", `${usd(report.costUsd)}  of a cap of ${usd(report.capUsd)}`],
        ...(sent > 0
          ? [["Cost per bookmark sent", usd(report.costUsd / sent)] as const]
          : []),
      ]),
    );
    if (report.unanswered > 0) {
      lines.push(
        "",
        `${number(report.unanswered)} attempts went out and brought no answer back (a timeout or a dropped connection). The API may have charged for them all the same; that is in no count above. Each was held against the cap at the most a request can cost.`,
      );
    }
    if (sent > 0 && report.summary.unclassified > 0) {
      lines.push(
        "",
        `At this rate the ${number(report.summary.unclassified)} bookmarks still unclassified would cost about ${usd((report.costUsd / sent) * report.summary.unclassified)}.`,
      );
    }
    lines.push(
      ...counts("Categories given by this run", report.categories),
      ...counts("Formats given by this run", report.formats),
      ...counts("Tags given by this run", report.tags),
    );
    if (report.classified > 0) {
      lines.push(
        "",
        ...table([
          ['Answers that said "too little text"', number(report.tooLittleText)],
          ["Answers that proposed a new tag", number(report.withProposals)],
        ]),
      );
    }
  }
  lines.push(...standing(report.summary));
  return [...lines, ""].join("\n");
}

/** What `--status` prints. */
export function describeStanding(
  summary: TaggingSummary,
  vocabulary: { version: number; tags: readonly string[] },
): string {
  return [
    "",
    `Taxonomy version ${TAXONOMY.version}, instructions version ${INSTRUCTIONS_VERSION}, vocabulary version ${vocabulary.version} (${number(vocabulary.tags.length)} tags), model ${MODEL}.`,
    ...standing(summary),
    "",
  ].join("\n");
}
