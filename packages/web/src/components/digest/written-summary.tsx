/**
 * The written part of a digest: Claude's summary of the week, when the
 * owner has had one written, and otherwise how to get it.
 *
 * What the model wrote is shown as text and as nothing else. Every string
 * goes into the page as a text node, so markup in it is letters; no address
 * in it is made a link; and the bookmarks it points at arrive here as post
 * ids that core checked when the digest was stored, and are drawn as links
 * to posts already on this page.
 *
 * Nothing here asks for a digest to be written. Writing one costs money, so
 * it is the owner's to start, in a terminal.
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { counted, formatDateTime } from "@/lib/words";
import type { WrittenView } from "@/server/digest";
import { Command, References, Section } from "./parts.tsx";

/** Prose a model wrote: shown as text, with its line breaks, at the size of a post's text. */
const WRAPPED = "max-w-prose whitespace-pre-line text-pretty";
const PROSE = `${WRAPPED} text-[0.9375rem] leading-[1.6]`;
const NOTE = `${WRAPPED} text-[0.875rem] text-muted-foreground leading-normal`;

function Provenance({
  written,
  weekKey,
}: {
  written: WrittenView;
  weekKey: string;
}) {
  const partial = written.from < written.inWeekThen;
  return (
    <div className="flex flex-col gap-1.5 text-[0.8125rem] text-muted-foreground leading-normal">
      <p>
        Written by Claude ({written.model}) on{" "}
        <time dateTime={written.writtenAt.toISOString()}>
          {formatDateTime(written.writtenAt)}
        </time>
        ,{" "}
        {partial
          ? `from ${written.from} of the ${written.inWeekThen} bookmarks the week then held`
          : counted(
              written.from,
              "from the week’s {n} bookmark",
              "from the week’s {n} bookmarks",
            )}
        . It read each post’s text and saw no picture, video or linked page, so
        it can be wrong: the posts themselves are below.
      </p>
      {written.savedSince > 0 ? (
        <p data-testid="digest-saved-since">
          {counted(
            written.savedSince,
            "{n} bookmark has been saved in this week since, and is not in the summary.",
            "{n} bookmarks have been saved in this week since, and are not in the summary.",
          )}{" "}
          To write it again:{" "}
          <code className="font-mono text-foreground">
            pnpm digest --week {weekKey} --again
          </code>
        </p>
      ) : null}
    </div>
  );
}

function Written({
  written,
  weekKey,
}: {
  written: WrittenView;
  weekKey: string;
}) {
  return (
    <div data-testid="digest-written" className="flex flex-col gap-7">
      <p data-testid="digest-overview" className={PROSE}>
        {written.overview}
      </p>

      {written.themes.length > 0 ? (
        <div className="flex flex-col gap-6">
          {written.themes.map((theme, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: themes of one stored digest, in its order; two may share a title.
            <section key={index} className="flex flex-col gap-2">
              <h3 className="text-balance font-semibold text-[0.9375rem] leading-snug">
                {theme.title}
              </h3>
              <p className={PROSE}>{theme.summary}</p>
              <References posts={theme.posts} />
            </section>
          ))}
        </div>
      ) : null}

      {written.worthRevisiting.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-semibold text-[0.9375rem] leading-snug">
            Worth going back to
          </h3>
          <ul className="flex flex-col gap-3">
            {written.worthRevisiting.map(({ post, why }) => (
              <li key={post.id} className="flex min-w-0 flex-col">
                <References posts={[post]} />
                <p className={NOTE}>{why}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Provenance written={written} weekKey={weekKey} />
    </div>
  );
}

function HowToGetIt({ weekKey }: { weekKey: string }) {
  return (
    <Card size="sm" data-testid="digest-howto">
      <CardHeader>
        <CardTitle>No summary has been written for this week</CardTitle>
        <CardDescription>
          Claude can write one: the themes of what you saved, and which posts
          are worth going back to. It sends the text of this week’s posts to the
          Claude API and costs a few cents, so it is yours to start, from a
          terminal in the repo. Nothing in the app writes one by itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Command does="See what it would send and cost. This sends nothing and needs no key.">
          {`pnpm digest --week ${weekKey} --dry-run`}
        </Command>
        <Command does="Write it. It appears here when you reload.">
          {`pnpm digest --week ${weekKey}`}
        </Command>
      </CardContent>
    </Card>
  );
}

export function WrittenSummary({
  written,
  weekKey,
  enough,
  minimum,
}: {
  written: WrittenView | null;
  weekKey: string;
  /** Whether the week holds enough bookmarks for a summary. */
  enough: boolean;
  minimum: number;
}) {
  return (
    <Section id="digest-summary" title="Summary">
      {written !== null ? (
        <Written written={written} weekKey={weekKey} />
      ) : enough ? (
        <HowToGetIt weekKey={weekKey} />
      ) : (
        <p
          data-testid="digest-too-few"
          className="max-w-prose text-[0.875rem] text-muted-foreground leading-normal"
        >
          A summary is written for a week of {minimum} bookmarks or more. This
          week holds fewer, so there is nothing to find a theme in.
        </p>
      )}
    </Section>
  );
}
