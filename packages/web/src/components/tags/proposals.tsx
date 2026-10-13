"use client";

/**
 * The tags the classifier proposed beyond the vocabulary, for the owner to
 * decide on: a new tag, another way of writing one there is, or no tag at
 * all. None of them is on a bookmark until then.
 *
 * Core puts names that look like one subject in a group. That is a guess
 * about likeness and stays one here (LAB-8): a decision covers the name it
 * is made on, and the other names of its group only where the owner ticks
 * them.
 */
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { counted } from "@/lib/words";
import type { ProposalView } from "@/server/tags";
import { TagCombobox } from "./tag-combobox.tsx";
import { useOwnerChange } from "./use-owner-change.ts";

/** How many of the tags a proposal resembles get a button of their own. */
const SIMILAR_OFFERED = 2;

const proposedFor = (name: string) => `/?proposed=${encodeURIComponent(name)}`;

const LINK =
  "rounded-sm text-muted-foreground underline decoration-foreground/25 underline-offset-2 outline-none transition-colors duration-150 ease-out hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";

function Proposal({
  proposal,
  tags,
}: {
  proposal: ProposalView;
  tags: readonly string[];
}) {
  const { change, busy } = useOwnerChange();
  const id = useId();
  /** The other names of the group that the owner has said are the same subject. */
  const [also, setAlso] = useState<readonly string[]>([]);
  /**
   * Whether Dismiss has been pressed once. A dismissed proposal does not
   * come back and nothing here undoes it, so it takes a second press; a
   * dialog for each of a long list would be worse than the slip it prevents.
   */
  const [sure, setSure] = useState(false);
  const { name, variants, similarTags } = proposal;
  const accept = (as?: string) =>
    void change("accept-proposal", {
      proposal: name,
      variants: also,
      ...(as === undefined ? {} : { as }),
    });
  return (
    <li
      data-proposal={name}
      className="flex flex-col gap-3 border-b py-5 first:pt-1"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 break-words font-medium text-[0.9375rem]">
          {name}
        </h3>
        <Link
          href={proposedFor(name)}
          prefetch={false}
          className={cn(LINK, "shrink-0 text-[0.8125rem] tabular-nums")}
        >
          {counted(
            proposal.bookmarks,
            "Proposed for {n} bookmark",
            "Proposed for {n} bookmarks",
          )}
        </Link>
      </div>

      {variants.length > 0 ? (
        <FieldSet className="gap-2">
          <FieldLegend
            variant="label"
            className="mb-0 font-normal text-[0.8125rem] text-muted-foreground"
          >
            Also proposed, perhaps for the same thing. Tick one to decide on it
            together with this.
          </FieldLegend>
          <FieldGroup className="gap-2">
            {variants.map((variant, index) => (
              <Field key={variant.name} orientation="horizontal">
                <Checkbox
                  id={`${id}-${index}`}
                  checked={also.includes(variant.name)}
                  onCheckedChange={(checked) =>
                    setAlso(
                      checked
                        ? [...also, variant.name]
                        : also.filter((other) => other !== variant.name),
                    )
                  }
                />
                <FieldLabel
                  htmlFor={`${id}-${index}`}
                  className="flex-none font-normal"
                >
                  {variant.name}
                </FieldLabel>
                <Link
                  href={proposedFor(variant.name)}
                  prefetch={false}
                  className={cn(LINK, "text-[0.8125rem] tabular-nums")}
                >
                  {counted(variant.bookmarks, "{n} bookmark", "{n} bookmarks")}
                </Link>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => accept()}
        >
          Accept as a new tag
        </Button>
        {similarTags.slice(0, SIMILAR_OFFERED).map((tag) => (
          <Button
            key={tag}
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => accept(tag)}
          >
            Alias of {tag}
          </Button>
        ))}
        <TagCombobox
          label={
            similarTags.length > 0 ? "Alias of another tag" : "Alias of a tag"
          }
          tags={tags}
          first={similarTags}
          disabled={busy}
          onPick={accept}
        />
        <Button
          variant={sure ? "destructive" : "ghost"}
          size="sm"
          className={cn("ms-auto", !sure && "text-muted-foreground")}
          disabled={busy}
          onBlur={() => setSure(false)}
          onClick={() => {
            if (!sure) return setSure(true);
            setSure(false);
            void change("dismiss-proposals", { proposals: [name, ...also] });
          }}
        >
          {sure ? "Dismiss for good?" : "Dismiss"}
        </Button>
        {sure ? (
          <span role="status" className="sr-only">
            Press again to dismiss {name} for good. It will not be proposed
            again.
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function Proposals({
  proposals,
  tags,
}: {
  proposals: ProposalView[];
  /** The vocabulary's tags, for making a proposal another way of writing one. */
  tags: readonly string[];
}) {
  return (
    <ul className="flex flex-col">
      {proposals.map((proposal) => (
        <Proposal key={proposal.name} proposal={proposal} tags={tags} />
      ))}
    </ul>
  );
}
