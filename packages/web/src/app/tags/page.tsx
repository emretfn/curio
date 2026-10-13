import { Tags as TagsIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Column, Shell } from "@/components/library/shell";
import { Proposals } from "@/components/tags/proposals";
import { Vocabulary } from "@/components/tags/vocabulary";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Toaster } from "@/components/ui/toast";
import { counted, whole } from "@/lib/words";
import { backupStatus } from "@/server/backups";
import { sharedStore } from "@/server/data";
import { getLibraryStatus } from "@/server/library";
import { appTagging } from "@/server/tagging";
import { atLeastOf, DEFAULT_AT_LEAST, getTagsScreen } from "@/server/tags";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tags" };

const LINK =
  "rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const atLeast = atLeastOf((await searchParams).least);
  const store = sharedStore();
  const screen = getTagsScreen(store, atLeast);
  const tagging = await appTagging();
  const names = screen.tags.map(({ tag }) => tag).toSorted();
  const none = screen.proposalsTotal === 0 && screen.proposalsBelow === 0;
  return (
    <Toaster>
      <Shell
        current="tags"
        title="Tags"
        skipTo="the tags"
        status={getLibraryStatus(store, backupStatus())}
        wide
      >
        <Column wide className="flex flex-col gap-10 pt-6 pb-16">
          <h1 className="font-semibold text-2xl leading-tight tracking-[-0.015em]">
            Tags
          </h1>

          <section aria-labelledby="proposals" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <h2 id="proposals" className="font-semibold text-base">
                Proposed by the classifier
              </h2>
              <p className="max-w-prose text-[0.875rem] text-muted-foreground leading-normal">
                Tags the classifier suggested that the vocabulary does not hold.
                None is on a bookmark until you accept it. An accepted tag goes
                on the bookmarks it was proposed for at once.{" "}
                <span
                  data-testid="tags-app-tagging"
                  data-on={tagging.on ? "" : undefined}
                >
                  {tagging.on ? (
                    "The app’s own tagging is on, so its next pass also asks about bookmarks that mention the tag, for a few cents at most."
                  ) : (
                    <>
                      The app’s own tagging is off, so bookmarks that only
                      mention a new tag wait for{" "}
                      <code className="whitespace-nowrap font-mono text-foreground">
                        pnpm tag --new-tags
                      </code>
                      .
                    </>
                  )}
                </span>
              </p>
            </div>
            {none ? (
              <Empty className="py-10" data-testid="no-proposals">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <TagsIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle className="text-base">
                    Nothing to decide
                  </EmptyTitle>
                  <EmptyDescription>
                    The classifier proposes a tag when a post is about something
                    the vocabulary has no tag for. Proposals appear here as
                    bookmarks are classified.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <p
                  role="status"
                  data-testid="proposal-count"
                  className="text-[0.8125rem] text-muted-foreground"
                >
                  {atLeast > 1
                    ? `${whole(screen.proposalsTotal)} proposed for ${whole(atLeast)} bookmarks or more.`
                    : counted(
                        screen.proposalsTotal,
                        "{n} proposal.",
                        "{n} proposals.",
                      )}{" "}
                  {screen.proposalsBelow > 0 ? (
                    <Link
                      href="/tags?least=1"
                      prefetch={false}
                      className={LINK}
                    >
                      Show the {whole(screen.proposalsBelow)} proposed for fewer
                    </Link>
                  ) : atLeast !== DEFAULT_AT_LEAST ? (
                    <Link href="/tags" prefetch={false} className={LINK}>
                      Show only those proposed for {whole(DEFAULT_AT_LEAST)} or
                      more
                    </Link>
                  ) : null}
                  {screen.proposalsTotal > screen.proposals.length
                    ? ` The first ${whole(screen.proposals.length)} are listed.`
                    : ""}
                </p>
                <Proposals proposals={screen.proposals} tags={names} />
              </>
            )}
          </section>

          <section aria-labelledby="vocabulary" className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <h2 id="vocabulary" className="font-semibold text-base">
                Vocabulary
              </h2>
              <p className="max-w-prose text-[0.875rem] text-muted-foreground leading-normal">
                The tags a bookmark can have. The classifier chooses among these
                and no others, and a change here reaches the bookmarks at once,
                without asking it again.
              </p>
            </div>
            <Vocabulary tags={screen.tags} retired={screen.retired} />
          </section>
        </Column>
      </Shell>
    </Toaster>
  );
}
