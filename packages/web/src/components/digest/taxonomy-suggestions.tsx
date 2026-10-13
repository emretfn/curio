/**
 * What the classifier's answers suggest about the taxonomy: bookmarks that
 * said enough and still fitted no category, which is how a missing category
 * shows, and the tags it proposed that the vocabulary does not hold.
 *
 * Both are read from the library as it stands; neither is asked of a model
 * here. Nothing in this section changes how a bookmark is filed: each
 * suggestion leads to the bookmarks it is about, in the library, where the
 * owner decides.
 */
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { counted, whole } from "@/lib/words";
import type { DigestPage } from "@/server/digest";
import { LIBRARY_LINKS } from "@/server/digest-params";
import { References, Section } from "./parts.tsx";

const NOTE = "max-w-prose text-[0.875rem] leading-normal";
const QUIET_NOTE = `${NOTE} text-muted-foreground`;
const LINK =
  "-mx-1 inline-flex items-center gap-1 self-start rounded-sm px-1 py-1 font-medium text-[0.8125rem] outline-none transition-colors duration-150 ease-out hover:underline focus-visible:ring-2 focus-visible:ring-ring";

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="font-semibold text-[0.875rem] leading-snug">{title}</h3>
      {children}
    </section>
  );
}

export function TaxonomySuggestions({
  suggestions,
  classifiedInLibrary,
  otherCategory,
}: {
  suggestions: DigestPage["suggestions"];
  /** How many bookmarks have been filed at all. */
  classifiedInLibrary: number;
  /** The id of the category "other". */
  otherCategory: string;
}) {
  const {
    unfitted,
    unfittedThisWeek,
    unfittedInLibrary,
    proposals,
    proposalsWaiting,
    proposedOnce,
  } = suggestions;
  return (
    <Section
      id="digest-suggestions"
      title="Suggestions for the taxonomy"
      data-testid="digest-suggestions"
    >
      {classifiedInLibrary === 0 ? (
        <p data-testid="digest-no-suggestions" className={QUIET_NOTE}>
          No bookmark has been filed yet, so there is nothing to suggest.
          Suggestions come from the classifier’s answers: the bookmarks that
          fitted no category, and the tags it wished it had.{" "}
          <code className="font-mono text-foreground">pnpm tag</code> files the
          library.
        </p>
      ) : (
        <div className="flex flex-col gap-7">
          <Part title="Fitted no category">
            <p data-testid="digest-unfitted" className={NOTE}>
              {unfittedThisWeek === 0
                ? "Nothing saved this week said enough and still fitted no category."
                : counted(
                    unfittedThisWeek,
                    "{n} bookmark saved this week said enough and still fitted no category.",
                    "{n} bookmarks saved this week said enough and still fitted no category.",
                  )}{" "}
              <span className="text-muted-foreground">
                When several such posts share a subject, a category is missing.
                A post with too little text to tell is not counted here.
              </span>
            </p>
            <References posts={unfitted} />
            {unfittedThisWeek > unfitted.length ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                {counted(
                  unfittedThisWeek - unfitted.length,
                  "And {n} more this week.",
                  "And {n} more this week.",
                )}
              </p>
            ) : null}
            {unfittedInLibrary > 0 ? (
              <Link
                href={LIBRARY_LINKS.fittedNoCategory(otherCategory)}
                prefetch={false}
                data-testid="digest-unfitted-link"
                className={LINK}
              >
                {counted(
                  unfittedInLibrary,
                  "See the {n} in the library",
                  "See all {n} in the library",
                )}
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            ) : null}
          </Part>

          <Part title="Proposed tags">
            <p data-testid="digest-proposals" className={NOTE}>
              {proposalsWaiting === 0
                ? "No tag has been proposed for two bookmarks or more."
                : counted(
                    proposalsWaiting,
                    "{n} subject has been proposed as a tag for two bookmarks or more.",
                    "{n} subjects have been proposed as tags for two bookmarks or more.",
                  )}{" "}
              <span className="text-muted-foreground">
                A proposal is on no bookmark until you accept it, on the{" "}
                <Link
                  href="/tags"
                  prefetch={false}
                  className="rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Tags page
                </Link>
                .
                {proposedOnce > 0
                  ? ` ${counted(proposedOnce, "{n} more was proposed for one bookmark only.", "{n} more were proposed for one bookmark only.")}`
                  : ""}
              </span>
            </p>
            {proposals.length > 0 ? (
              <ul className="flex flex-col">
                {proposals.map((proposal) => (
                  <li key={proposal.proposal} className="min-w-0">
                    <Link
                      href={LIBRARY_LINKS.proposedTag(proposal.proposal)}
                      prefetch={false}
                      data-proposal={proposal.proposal}
                      className="-mx-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 rounded-sm px-1.5 py-1.5 text-[0.8125rem] leading-snug outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="break-all font-medium font-mono">
                        {proposal.proposal}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {counted(
                          proposal.bookmarks,
                          "{n} bookmark",
                          "{n} bookmarks",
                        )}
                      </span>
                      {proposal.variants.length > 1 ? (
                        <span className="break-all text-muted-foreground">
                          also as{" "}
                          {proposal.variants
                            .slice(1)
                            .map((variant) => variant.proposal)
                            .join(", ")}
                        </span>
                      ) : null}
                      {proposal.similarTags.length > 0 ? (
                        <span className="break-all text-muted-foreground">
                          resembles the tag{" "}
                          {proposal.similarTags.slice(0, 3).join(", ")}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {proposalsWaiting > proposals.length ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                The {whole(proposals.length)} proposed most are shown.
              </p>
            ) : null}
          </Part>
        </div>
      )}
    </Section>
  );
}
