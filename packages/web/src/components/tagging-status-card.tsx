import type { TaggingRun, TaggingSummary } from "@x-bookmarks/core";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { counted, formatDateTime, whole } from "@/lib/words";
import { OTHER_CATEGORY, TAXONOMY, UNCLEAR_FORMAT } from "@/server/core";
import type { TaggingStatus } from "@/server/tagging";

const dollars = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const cents = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** An amount spent. Under a cent it keeps the digits that say how much under. */
const money = (usd: number) =>
  usd > 0 && usd < 0.01 ? cents.format(usd) : dollars.format(usd);

function Time({ at }: { at: Date }) {
  return <time dateTime={at.toISOString()}>{formatDateTime(at)}</time>;
}

const RUN_OUTCOMES: Record<NonNullable<TaggingRun["outcome"]>, string> = {
  completed: "finished",
  "stopped-at-cap": "stopped at its spending cap",
  failed: "failed",
  abandoned: "was abandoned",
};

function LastRun({ run }: { run: TaggingRun | null }) {
  if (run === null) return "none yet";
  return (
    <>
      <Time at={run.startedAt} />
      {": "}
      {run.startedBy === "owner" ? "started by you" : "the app’s own pass"},{" "}
      {run.outcome === null
        ? run.batchId === null
          ? "running now"
          : "waiting for a batch"
        : RUN_OUTCOMES[run.outcome]}
      . {counted(run.classified, "{n} classified", "{n} classified")},{" "}
      {whole(run.failed)} failed, {money(run.costUsd)}.
    </>
  );
}

/** The taxonomy's own names for the two places worth watching. */
const OTHER =
  TAXONOMY.categories.find(({ id }) => id === OTHER_CATEGORY)?.label ??
  OTHER_CATEGORY;
const UNCLEAR =
  TAXONOMY.formats.find(({ id }) => id === UNCLEAR_FORMAT)?.label ??
  UNCLEAR_FORMAT;

const ROWS =
  "grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 [&_dd]:text-end [&_dd]:tabular-nums [&_dt]:text-muted-foreground";

/**
 * How the tagging stands: counts, the last run and the app's last pass,
 * what has been spent, and the command that classifies. It reads and shows.
 * It holds no control, because a run spends the owner's money and is the
 * owner's to start, in a terminal.
 */
export function TaggingStatusCard({
  summary,
  passes,
  appTagging,
}: {
  summary: TaggingSummary;
  /** The app's own passes, as this process remembers them. */
  passes: TaggingStatus;
  /** Whether the owner has let the app tag by itself, with how that is changed. A line of a file: no control here changes it. */
  appTagging: { on: boolean; message: string };
}) {
  const { other, lastRun } = summary;
  const { lastAttempt } = passes;
  return (
    <Card id="tagging" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>Tagging</CardTitle>
        <CardDescription>
          A classifier files each bookmark under a category, a format and tags
          by asking the Claude API. A run costs money, so nothing on any screen
          starts one: it is yours to start, in a terminal.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className={ROWS}>
          <dt>Classified</dt>
          <dd data-testid="tagging-classified">
            {whole(summary.classified)} of {whole(summary.bookmarks)}
          </dd>
          <dt>Not classified yet</dt>
          <dd data-testid="tagging-unclassified">
            {whole(summary.unclassified)}
          </dd>
          <dt className="ps-3">of which tried, with no usable answer</dt>
          <dd data-testid="tagging-failed">{whole(summary.failed)}</dd>
          <dt>Classified under an older taxonomy or older instructions</dt>
          <dd data-testid="tagging-outdated">{whole(summary.outdated)}</dd>
          <dt>Classified before a tag was added, and mention it</dt>
          <dd data-testid="tagging-new-tags">
            {whole(summary.mentioningNewTags)}
          </dd>
          <dt>Corrected by you</dt>
          <dd data-testid="tagging-corrected">{whole(summary.corrected)}</dd>
          <dt>Under {OTHER}: too little text</dt>
          <dd data-testid="tagging-little-text">
            {whole(other.tooLittleText)}
          </dd>
          <dt>Under {OTHER}: no category fits</dt>
          <dd data-testid="tagging-no-fit">
            {whole(other.noneOfTheAbove)}
            {other.noneOfTheAbove > 0
              ? ` (${percent.format(other.noneOfTheAboveShare)} of the filed)`
              : ""}
          </dd>
          <dt>{UNCLEAR} format</dt>
          <dd data-testid="tagging-unclear">{whole(summary.unclearFormat)}</dd>
          <dt>Proposed tags to decide on</dt>
          <dd data-testid="tagging-proposals">{whole(summary.proposals)}</dd>
          <dt>Spent, as worked out from the tokens</dt>
          <dd data-testid="tagging-spent">{money(summary.spentUsd)}</dd>
          <dt className="ps-3">of which in the last 24 hours</dt>
          <dd data-testid="tagging-spent-day">
            {money(summary.spentLastDayUsd)}
          </dd>
        </dl>

        <dl className="flex flex-col gap-3 [&_dd]:mt-0.5 [&_dt]:text-muted-foreground">
          <div>
            <dt>Tagging by the app itself</dt>
            <dd
              data-testid="tagging-app"
              data-on={appTagging.on ? "" : undefined}
              className="break-words"
            >
              <span className="font-medium">
                {appTagging.on ? "On." : "Off."}
              </span>{" "}
              {appTagging.message}
            </dd>
          </div>
          <div>
            <dt>Last run</dt>
            <dd data-testid="tagging-last-run">
              <LastRun run={lastRun} />
            </dd>
          </div>
          <div>
            <dt>The app’s own last pass</dt>
            <dd data-testid="tagging-last-pass">
              {lastAttempt === null ? (
                "None since the app started."
              ) : (
                <>
                  <Time at={lastAttempt.at} />
                  {": "}
                  {/* Off, its message is the one above, word for word. */}
                  {lastAttempt.status === "off"
                    ? "it sent nothing, because tagging by the app is off."
                    : lastAttempt.message}
                </>
              )}
              {passes.running
                ? " One is running now."
                : passes.scheduled
                  ? " The next is due shortly."
                  : ""}
            </dd>
            {lastAttempt !== null && lastAttempt.warning !== null ? (
              <dd className="font-medium">{lastAttempt.warning}</dd>
            ) : null}
          </div>
        </dl>

        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">
            To classify, in a terminal in the x-bookmarks folder:
          </p>
          <dl
            data-testid="tagging-command"
            className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2.5 [&_dd]:text-muted-foreground [&_dt]:font-mono [&_dt]:text-[0.8125rem]"
          >
            <div>
              <dt>pnpm tag --dry-run</dt>
              <dd>
                Says what a run would send and what it would cost. It asks
                nothing and spends nothing.
              </dd>
            </div>
            <div>
              <dt>pnpm tag</dt>
              <dd>Classifies what is not classified yet.</dd>
            </div>
            <div>
              <dt>pnpm tag --new-tags</dt>
              <dd>
                Asks about bookmarks that mention a tag added since they were
                classified. It can add that tag and change nothing else.
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground">
            What comes back is yours to correct, on any post or in the{" "}
            <Link
              href="/review"
              prefetch={false}
              className="rounded-sm text-foreground underline underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              review queue
            </Link>
            ; the tags the classifier proposes are decided on the{" "}
            <Link
              href="/tags"
              prefetch={false}
              className="rounded-sm text-foreground underline underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Tags page
            </Link>
            .
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
