/**
 * The words `pnpm digest` prints. Everything here is a week, counts, tokens
 * and money: a plan or a report never quotes a post, an author, an address
 * or the digest itself (PRIV-5, AI-9), so its output can be pasted
 * anywhere, and is safe in the log the schedule writes to.
 */
import { type DigestRun, lastDayOf, type Week } from "@curio/core";
import { usd } from "../pricing.ts";
import { MAX_DIGEST_BOOKMARKS, MIN_DIGEST_BOOKMARKS } from "./input.ts";
import { DIGEST_INSTRUCTIONS_VERSION, DIGEST_MODEL } from "./instructions.ts";
import type { DigestPlan, DigestReport } from "./run.ts";

const number = (value: number) => value.toLocaleString("en-US");
const range = (low: string, high: string) =>
  low === high ? low : `${low} to ${high}`;

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** `Monday 5 October 2026 to Sunday 11 October 2026 (2026-10-05)`. */
export function describeWeek(week: Week): string {
  return `${dayFormat.format(week.start)} to ${dayFormat.format(lastDayOf(week))} (${week.key})`;
}

/** Label and value in two columns. */
function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
}

const command = (week: Week, flags = "") =>
  `pnpm digest --week ${week.key}${flags}`;

/** Why some of a week's bookmarks would be, or were, left out. */
function leftOutNote(
  leftOut: number,
  capUsd: number,
  mostForAllUsd: number | null,
): string {
  if (leftOut === 0) return "";
  return mostForAllUsd !== null &&
    Number.isFinite(mostForAllUsd) &&
    mostForAllUsd > capUsd
    ? `  (the oldest of the week: they do not fit under the cap of ${usd(capUsd)}. --max-usd ${Math.ceil(mostForAllUsd * 100) / 100} sends them too)`
    : `  (the oldest of the week: a digest is written from ${MAX_DIGEST_BOOKMARKS} bookmarks at most)`;
}

/** What a dry run prints. */
export function describeDigestPlan(plan: DigestPlan): string {
  const lines = [
    "",
    "Dry run. Nothing was sent, nothing was written, and no key was read.",
    "",
    `The week of ${describeWeek(plan.week)}.`,
    `Digest instructions version ${DIGEST_INSTRUCTIONS_VERSION}, model ${DIGEST_MODEL}.`,
    "",
    ...table([
      ["Bookmarks made that week", number(plan.bookmarksInWeek)],
      [
        "Too little text to send",
        `${number(plan.tooLittleToSend)}  (nothing in them for a model to read)`,
      ],
      ["Would be sent, in one request", number(plan.toSend)],
      [
        "Left out",
        `${number(plan.leftOut)}${leftOutNote(plan.leftOut, plan.capUsd, plan.mostForAllUsd)}`,
      ],
      [
        "Sent, cut to the text limit",
        `${number(plan.cut)}  (the opening of a long post is sent, not the whole)`,
      ],
    ]),
  ];
  if (!plan.enough) {
    lines.push(
      "",
      plan.toSend + plan.leftOut >= MIN_DIGEST_BOOKMARKS
        ? `Not even ${MIN_DIGEST_BOOKMARKS} bookmarks fit under the cap of ${usd(plan.capUsd)}, so no request would be made. Raise it with --max-usd.`
        : `A digest is written from ${MIN_DIGEST_BOOKMARKS} bookmarks or more, so no request would be made for this week. The page shows what was saved all the same.`,
      "",
    );
    return lines.join("\n");
  }
  if (plan.estimate !== null) {
    const { inputTokens, outputTokens, costUsd } = plan.estimate;
    lines.push(
      "",
      ...table([
        [
          "Input tokens",
          range(number(inputTokens.few), number(inputTokens.many)),
        ],
        [
          "Output tokens",
          `${range(number(outputTokens.few), number(outputTokens.many))}  (the digest, and the thinking before it)`,
        ],
        [
          "Cost",
          `${range(usd(costUsd.few), usd(costUsd.many))}  (an estimate from the length of the text)`,
        ],
        [
          "At most",
          `${usd(plan.mostUsd)}  (every byte a token and the answer at full length), under a cap of ${usd(plan.capUsd)}`,
        ],
      ]),
    );
  }
  if (plan.measured !== null) {
    lines.push(
      "",
      `The latest digest written, for the week of ${plan.measured.week} from ${number(plan.measured.bookmarks)} bookmarks, cost ${usd(plan.measured.costUsd)} by the API's own count.`,
    );
  }
  lines.push(
    "",
    plan.existing === null
      ? `To write it: ${command(plan.week)}`
      : `This week already has a digest, written ${timeFormat.format(plan.existing.writtenAt)} from ${number(plan.existing.bookmarks)} bookmarks for ${usd(plan.existing.costUsd)}. ${command(plan.week)} would send nothing; ${command(plan.week, " --again")} writes it again.`,
    "",
  );
  return lines.join("\n");
}

function spent(report: DigestReport): string[] {
  const { usage } = report;
  return [
    "",
    ...table([
      ["Bookmarks made that week", number(report.bookmarksInWeek)],
      ["Sent", number(report.sent)],
      [
        "Left out",
        `${number(report.leftOut)}${leftOutNote(report.leftOut, report.capUsd, null)}`,
      ],
      ["Input tokens", number(usage.inputTokens)],
      [
        "Output tokens",
        `${number(usage.outputTokens)}  (the digest, and the thinking before it)`,
      ],
      [
        "Cost",
        `${usd(report.costUsd)}  of a cap of ${usd(report.capUsd)}, by the API's own count. The invoice is the authority.`,
      ],
    ]),
    ...(report.unanswered === 0
      ? []
      : [
          "",
          `${number(report.unanswered)} attempt${report.unanswered === 1 ? "" : "s"} went out and brought no answer back. The API may have charged for ${report.unanswered === 1 ? "it" : "each"}, up to ${usd(report.mostUsd)}, and that is not in the cost above: the Console's usage page says.`,
        ]),
  ];
}

/** What a run prints when it ends. */
export function describeDigestReport(report: DigestReport): string {
  const week = `the week of ${describeWeek(report.week)}`;
  switch (report.status) {
    case "written":
      return [
        "",
        `The digest for ${week} is written, and is on the app's digest page.`,
        ...spent(report),
        "",
      ].join("\n");
    case "already-written":
      return [
        "",
        `The digest for ${week} is already written${report.run?.finishedAt == null ? "" : `, ${timeFormat.format(report.run.finishedAt)}`}. Nothing was sent.`,
        `To write it again: ${command(report.week, " --again")}`,
        "",
      ].join("\n");
    case "too-few":
      return [
        "",
        `The week of ${describeWeek(report.week)} holds ${number(report.bookmarksInWeek)} bookmark${report.bookmarksInWeek === 1 ? "" : "s"}, and a digest is written from ${MIN_DIGEST_BOOKMARKS} or more with text enough to read. Nothing was sent.`,
        "",
      ].join("\n");
    case "over-cap":
      return [
        "",
        `Not even ${MIN_DIGEST_BOOKMARKS} bookmarks of ${week} fit under the cap of ${usd(report.capUsd)}. Nothing was sent. Raise it with --max-usd.`,
        "",
      ].join("\n");
    case "busy":
      return [
        "",
        `Another digest is being written${report.run === null ? "" : ` (run ${report.run.id}, for the week of ${report.run.week})`}. Nothing was sent. Run this again when it has ended.`,
        "",
      ].join("\n");
    case "failed":
      return [
        "",
        `No digest was written for ${week}.`,
        report.failure?.message ?? "The run failed.",
        ...spent(report),
        "",
      ].join("\n");
  }
}

/** What `--list` prints: the runs so far, newest first. */
export function describeDigestRuns(runs: readonly DigestRun[]): string {
  if (runs.length === 0) {
    return "\nNo digest has been written yet, and none was attempted.\n";
  }
  const total = runs.reduce((sum, run) => sum + run.costUsd, 0);
  return [
    "",
    "Digest runs, newest first: the week, what came of it, the bookmarks sent, the tokens in and out, the cost.",
    "",
    ...runs.map(
      (run) =>
        `  ${run.week}  ${(run.outcome ?? "open").padEnd(9)}  ${run.failure === null ? "" : `(${run.failure})  `}${number(run.postIds.length)} sent  ${number(run.inputTokens)} in  ${number(run.outputTokens)} out  ${usd(run.costUsd)}  ${run.startedBy}  ${run.model}`,
    ),
    "",
    `${usd(total)} in all for the ${number(runs.length)} listed.`,
    "",
  ].join("\n");
}
