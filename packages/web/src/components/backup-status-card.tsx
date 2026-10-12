import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime } from "@/lib/words";
import {
  type BackupAttempt,
  type BackupStatus,
  backupFailure,
} from "@/server/backups";

function Time({ at }: { at: Date | null }) {
  return at === null ? (
    "none yet"
  ) : (
    <time dateTime={at.toISOString()}>{formatDateTime(at)}</time>
  );
}

const BACKUP_OUTCOMES: Record<BackupAttempt["outcome"], string> = {
  written: "a snapshot was taken and verified",
  unchanged: "nothing has changed since the latest snapshot",
  recent: "the latest snapshot is less than a day old",
  empty: "there are no captures to back up yet",
  failed: "it failed",
};

/**
 * The status page's account of the backups: how many, the latest, and
 * loudly, a failure. The same failure is the library's status line and its
 * banner, on every screen, until a backup succeeds.
 */
export function BackupStatusCard({ backups }: { backups: BackupStatus }) {
  const { directory, snapshots, latest, lastAttempt } = backups;
  const failure = backupFailure(backups);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Backups</CardTitle>
        <CardDescription>
          A verified snapshot of the whole library, at most once a day while the
          app runs, and whenever you run <code>pnpm backup</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {failure !== null && (
          <p
            role="alert"
            data-testid="backup-failure"
            className="font-medium text-destructive"
          >
            The last backup failed, so the library is not being backed up:{" "}
            {failure}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 [&_dd]:text-end [&_dd]:tabular-nums [&_dt]:text-muted-foreground">
          <dt>Snapshots kept</dt>
          <dd data-testid="backup-count">{snapshots}</dd>
          <dt>Latest snapshot</dt>
          <dd data-testid="backup-latest">
            <Time at={latest?.takenAt ?? null} />
          </dd>
          <dt>Last check</dt>
          <dd data-testid="backup-last-check">
            {lastAttempt === null ? (
              "not yet"
            ) : (
              <>
                <Time at={lastAttempt.at} />:{" "}
                {BACKUP_OUTCOMES[lastAttempt.outcome]}
              </>
            )}
          </dd>
          <dt>Kept in</dt>
          <dd data-testid="backup-directory" className="break-all">
            {directory}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
