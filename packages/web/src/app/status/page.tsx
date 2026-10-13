import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { BackupStatusCard } from "@/components/backup-status-card";
import { StatusBanner } from "@/components/library/status";
import { TaggingStatusCard } from "@/components/tagging-status-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime } from "@/lib/words";
import { backupStatus } from "@/server/backups";
import { summariseTagging } from "@/server/core";
import { sharedStore } from "@/server/data";
import { getLibraryStatus } from "@/server/library";
import { appTagging, taggingStatus } from "@/server/tagging";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Status" };

function Time({ at }: { at: Date | null }) {
  return at === null ? (
    "none yet"
  ) : (
    <time dateTime={at.toISOString()}>{formatDateTime(at)}</time>
  );
}

const ROWS =
  "grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 [&_dd]:text-end [&_dd]:tabular-nums [&_dt]:text-muted-foreground";

export default async function StatusPage() {
  const store = sharedStore();
  const status = getLibraryStatus(store, backupStatus());
  const { parsing } = status;
  const { captures } = parsing;
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-8 sm:px-6">
      <Link
        href="/"
        prefetch={false}
        className="-ms-1 inline-flex items-center gap-1 self-start rounded-sm px-1 font-medium text-muted-foreground text-sm outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Back to the library
      </Link>
      <h1 className="font-semibold text-xl tracking-[-0.01em]">Status</h1>
      <StatusBanner status={status} />
      <Card>
        <CardHeader>
          <CardTitle>Captures from the extension</CardTitle>
          <CardDescription>
            Raw responses, stored as they arrived.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className={ROWS}>
            <dt>Stored</dt>
            <dd data-testid="capture-count">{status.captures.count}</dd>
            <dt>Latest capture</dt>
            <dd data-testid="last-capture">
              <Time at={status.captures.lastReceivedAt} />
            </dd>
          </dl>
        </CardContent>
        <CardFooter>
          <Link href="/pair" className="underline underline-offset-3">
            Pair the extension
          </Link>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bookmarks parsed from them</CardTitle>
          <CardDescription>
            A capture or an entry that failed was not understood: X has probably
            changed a response. Nothing is lost; fix the parser, then run{" "}
            <code>pnpm reparse</code>, which also lists what failed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className={ROWS}>
            <dt>Bookmarks</dt>
            <dd data-testid="bookmark-count">{parsing.bookmarks}</dd>
            <dt>Captures parsed</dt>
            <dd data-testid="captures-parsed">{captures.parsed}</dd>
            <dt>Captures failed</dt>
            <dd data-testid="captures-failed">{captures.failed}</dd>
            <dt>Entries failed</dt>
            <dd data-testid="entries-failed">{parsing.failedEntries}</dd>
            <dt>Parts left empty</dt>
            <dd data-testid="parse-warnings">{parsing.warnings}</dd>
            <dt>Posts X withholds</dt>
            <dd data-testid="entries-unavailable">
              {parsing.unavailableEntries}
            </dd>
            <dt>Captures with no parser yet</dt>
            <dd data-testid="captures-no-parser">{captures.noParser}</dd>
            <dt>Captures waiting for a re-parse</dt>
            <dd data-testid="captures-waiting">
              {captures.pending + captures.outdated}
            </dd>
            <dt>Last parsed</dt>
            <dd data-testid="last-parsed">
              <Time at={parsing.lastParsedAt} />
            </dd>
          </dl>
        </CardContent>
      </Card>
      <TaggingStatusCard
        summary={summariseTagging(store)}
        passes={taggingStatus()}
        appTagging={await appTagging()}
      />
      <BackupStatusCard backups={status.backups} />
      <Card>
        <CardHeader>
          <CardTitle>What this app asks X for</CardTitle>
          <CardDescription>
            Nothing, unless you ask it to show a post’s media.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex list-disc flex-col gap-1.5 ps-5 text-muted-foreground">
            <li>
              Photos, videos and link images stay on X’s servers. Until you
              choose Show media on a post, your browser asks X for none of them.
            </li>
            <li>
              Show media loads that one post’s media from X’s media servers,
              without cookies and without saying which page asked. A video loads
              when you press play.
            </li>
            <li>
              With “Load media on screen” on, the same happens by itself for the
              posts in view, and for no others.
            </li>
            <li>
              Profile pictures are never loaded, and this app’s server never
              asks X for anything.
            </li>
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
