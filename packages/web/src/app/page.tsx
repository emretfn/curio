import { CAPTURE_SOURCE } from "@x-bookmarks/extension";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { summariseParsing, summariseRawCaptures } from "@/server/core";
import { sharedStore } from "@/server/data";

export const dynamic = "force-dynamic";

function Time({ at }: { at: Date | null }) {
  return at === null ? (
    "none yet"
  ) : (
    <time dateTime={at.toISOString()}>{at.toLocaleString()}</time>
  );
}

export default function StatusPage() {
  const store = sharedStore();
  const { count, lastReceivedAt } = summariseRawCaptures(store, CAPTURE_SOURCE);
  const parsing = summariseParsing(store);
  const { captures } = parsing;
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Captures from the extension</CardTitle>
          <CardDescription>
            Raw responses, stored as they arrived.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt>Stored</dt>
            <dd data-testid="capture-count">{count}</dd>
            <dt>Latest capture</dt>
            <dd data-testid="last-capture">
              <Time at={lastReceivedAt} />
            </dd>
          </dl>
        </CardContent>
        <CardFooter>
          <Link href="/pair" className="underline">
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
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
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
    </main>
  );
}
