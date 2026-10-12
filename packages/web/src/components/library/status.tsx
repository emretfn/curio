/**
 * How capture, parsing and the backups are doing, shown on the library
 * itself.
 *
 * This route fails silently: when X changes a response the extension still
 * delivers it, and the only sign is a count on a page nobody opens. A backup
 * that has stopped is as quiet. So the library carries the status with it.
 * While all is well it is one quiet line at the foot of the sidebar. When
 * something is wrong it is also a banner above the list, on every width,
 * that says what to do.
 */
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { counted, formatDateTime } from "@/lib/words";
import { backupFailure } from "@/server/backups";
import type { LibraryStatus } from "@/server/library";

const BACKUP_FAILED = "The last backup failed";

/** What is wrong with capture or parsing, in one phrase, or null when nothing is. */
function trouble(status: LibraryStatus): string | null {
  const { parsing } = status;
  if (parsing.captures.failed > 0) {
    return counted(
      parsing.captures.failed,
      "{n} capture was not understood",
      "{n} captures were not understood",
    );
  }
  if (parsing.failedEntries > 0) {
    return counted(
      parsing.failedEntries,
      "{n} bookmark could not be read",
      "{n} bookmarks could not be read",
    );
  }
  const waiting = parsing.captures.pending + parsing.captures.outdated;
  if (waiting > 0) {
    return counted(
      waiting,
      "{n} capture is waiting to be parsed again",
      "{n} captures are waiting to be parsed again",
    );
  }
  return null;
}

/** The line at the foot of the sidebar. It leads to the status page. */
export function StatusLine({ status }: { status: LibraryStatus }) {
  const { captures, level } = status;
  const problem =
    trouble(status) ??
    (backupFailure(status.backups) === null ? null : BACKUP_FAILED);
  const Icon =
    level === "problem"
      ? CircleAlert
      : level === "attention"
        ? TriangleAlert
        : captures.count === 0
          ? CircleDashed
          : CircleCheck;
  return (
    <Link
      href="/status"
      prefetch={false}
      data-testid="status-line"
      data-level={level}
      className="group/status -mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] leading-snug outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon
        aria-hidden="true"
        className={
          level === "problem"
            ? "mt-0.5 size-3.5 shrink-0 text-destructive"
            : "mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        }
      />
      <span className="flex min-w-0 flex-col">
        <span
          className={level === "ok" ? "text-muted-foreground" : "font-medium"}
        >
          {problem ??
            (captures.count === 0
              ? "No captures yet"
              : counted(
                  captures.count,
                  "{n} capture, read in full",
                  "{n} captures, all read",
                ))}
        </span>
        <span className="text-muted-foreground text-xs">
          {captures.lastReceivedAt === null
            ? "Pair the extension to start"
            : `Last capture ${formatDateTime(captures.lastReceivedAt)}`}
        </span>
      </span>
    </Link>
  );
}

/**
 * The banner above the list: one notice for capture and parsing, one for the
 * backups. Nothing is rendered while all is well.
 */
export function StatusBanner({ status }: { status: LibraryStatus }) {
  const problem = trouble(status);
  const { captures, failedEntries } = status.parsing;
  const broken = captures.failed > 0 || failedEntries > 0;
  const backup = backupFailure(status.backups);
  return (
    <>
      {problem !== null ? (
        <Alert
          variant={broken ? "destructive" : "default"}
          role={broken ? "alert" : "status"}
          data-testid="status-banner"
          className="mb-4"
        >
          {broken ? (
            <CircleAlert aria-hidden="true" />
          ) : (
            <TriangleAlert aria-hidden="true" />
          )}
          <AlertTitle>
            {broken ? `${problem}: X has probably changed a response` : problem}
          </AlertTitle>
          <AlertDescription>
            {broken
              ? "Some bookmarks are missing from this library until the parser is fixed. Nothing is lost: every capture is stored as it arrived. Run "
              : "The library may be showing what an older parser read. Run "}
            <code className="whitespace-nowrap font-mono text-foreground text-xs">
              pnpm reparse
            </code>
            {broken
              ? " to see what was not understood, then "
              : " to bring it up to date, or "}
            <Link href="/status" prefetch={false}>
              open the status page
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}
      {backup !== null ? (
        <Alert
          variant="destructive"
          role="alert"
          data-testid="backup-banner"
          className="mb-4"
        >
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {BACKUP_FAILED}: the library is not being backed up
          </AlertTitle>
          <AlertDescription>
            The captures cannot be collected again, and no new snapshot of them
            is being taken. The reason given:{" "}
            <span className="break-words text-foreground">{backup}</span>. The
            app tries again every hour and when it starts;{" "}
            <Link href="/status" prefetch={false}>
              the status page
            </Link>{" "}
            shows where the snapshots are kept.
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
