"use client";

/**
 * The tag vocabulary, for the owner to keep: add a tag, rename one, name
 * another way of writing it, merge one into another, retire one and bring
 * it back. Each is one function of core's `vocabulary.ts`, and each carries
 * the bookmarks with it (LAB-7).
 *
 * Retiring can be undone, by restoring. Merging cannot, so it asks first.
 */
import { X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useId, useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { counted } from "@/lib/words";
import type { TagView } from "@/server/tags";
import { TagCombobox } from "./tag-combobox.tsx";
import { useOwnerChange } from "./use-owner-change.ts";

const taggedWith = (tag: string) => `/?tag=${encodeURIComponent(tag)}`;

const COUNT_LINK =
  "shrink-0 rounded-sm text-[0.8125rem] text-muted-foreground tabular-nums underline decoration-foreground/25 underline-offset-2 outline-none transition-colors duration-150 ease-out hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** A name typed into a field of a form, and the field emptied once it is used. */
function typedInto(event: FormEvent<HTMLFormElement>, field: string) {
  event.preventDefault();
  const input = event.currentTarget.elements.namedItem(field);
  const value = input instanceof HTMLInputElement ? input.value.trim() : "";
  return {
    value,
    clear: () => {
      if (input instanceof HTMLInputElement) input.value = "";
    },
  };
}

function AddTag() {
  const { change, busy } = useOwnerChange();
  const id = useId();
  return (
    <form
      onSubmit={async (event) => {
        const typed = typedInto(event, "name");
        if (typed.value === "") return;
        if (await change("add-tag", { name: typed.value })) typed.clear();
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>Add a tag</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={id}
            name="name"
            maxLength={64}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="words-joined-by-hyphens"
            aria-describedby={`${id}-about`}
          />
          <Button type="submit" disabled={busy}>
            Add tag
          </Button>
        </div>
        <FieldDescription id={`${id}-about`}>
          Lowercase letters and digits, in words joined by hyphens. Bookmarks
          the classifier proposed it for get it at once.
        </FieldDescription>
      </Field>
    </form>
  );
}

function TagEditor({
  tag,
  others,
  panelId,
  onGone,
}: {
  tag: TagView;
  /** The other tags of the vocabulary, to merge this one into. */
  others: readonly string[];
  panelId: string;
  /** Called when the tag has left the list under this name. */
  onGone: () => void;
}) {
  const { change, busy } = useOwnerChange();
  const id = useId();
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  return (
    <div
      id={panelId}
      className="mb-3 rounded-xl bg-muted/60 p-4"
      data-tag-editor={tag.tag}
    >
      <FieldGroup>
        <form
          onSubmit={async (event) => {
            const typed = typedInto(event, "to");
            if (typed.value === "" || typed.value === tag.tag) return;
            if (await change("rename-tag", { tag: tag.tag, to: typed.value })) {
              onGone();
            }
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <div className="flex gap-2">
              <Input
                id={`${id}-name`}
                name="to"
                defaultValue={tag.tag}
                maxLength={64}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="bg-background"
                aria-describedby={`${id}-name-about`}
              />
              <Button type="submit" variant="outline" disabled={busy}>
                Rename
              </Button>
            </div>
            <FieldDescription id={`${id}-name-about`}>
              Every bookmark that has it keeps it under the new name, and the
              old name still finds them.
            </FieldDescription>
          </Field>
        </form>

        <Field>
          <FieldTitle id={`${id}-aliases`}>Other ways of writing it</FieldTitle>
          {tag.aliases.length > 0 ? (
            <ul
              aria-labelledby={`${id}-aliases`}
              className="flex flex-wrap gap-1.5"
            >
              {tag.aliases.map((alias) => (
                <li
                  key={alias}
                  className="flex h-7 items-center gap-0.5 rounded-md bg-background ps-2 pe-0.5 text-[0.8125rem] ring-1 ring-foreground/10"
                >
                  {alias}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={`Remove ${alias} as another way of writing ${tag.tag}`}
                    onClick={() => void change("remove-alias", { alias })}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="flex gap-2"
            onSubmit={async (event) => {
              const typed = typedInto(event, "alias");
              if (typed.value === "") return;
              if (
                await change("add-alias", { alias: typed.value, tag: tag.tag })
              ) {
                typed.clear();
              }
            }}
          >
            <Input
              name="alias"
              maxLength={64}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="bg-background"
              aria-label={`Another way of writing ${tag.tag}`}
              aria-describedby={`${id}-alias-about`}
            />
            <Button type="submit" variant="outline" disabled={busy}>
              Add
            </Button>
          </form>
          <FieldDescription id={`${id}-alias-about`}>
            A filter reads each of these as this tag, and so does the
            classifier: a name in another language, an abbreviation, a spelling
            with a dot in it.
          </FieldDescription>
        </Field>

        {others.length > 0 ? (
          <Field>
            <FieldTitle>Merge into another tag</FieldTitle>
            <div>
              <TagCombobox
                label="Choose the tag to keep"
                tags={others}
                disabled={busy}
                onPick={setMergeInto}
              />
            </div>
            <FieldDescription>
              For two tags that turned out to be one subject. This one becomes
              another way of writing the other.
            </FieldDescription>
          </Field>
        ) : null}

        <Field>
          <div>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (await change("retire-tag", { tag: tag.tag })) onGone();
              }}
            >
              Retire this tag
            </Button>
          </div>
          <FieldDescription>
            It leaves every bookmark and every filter, and the classifier stops
            using it. Nothing is deleted: a retired tag can be restored, with
            the bookmarks it had.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <AlertDialog
        open={mergeInto !== null}
        onOpenChange={(open) => {
          if (!open) setMergeInto(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge “{tag.tag}” into “{mergeInto}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {counted(
                tag.bookmarks,
                "The {n} bookmark that has",
                "The {n} bookmarks that have",
              )}{" "}
              “{tag.tag}” will have “{mergeInto}” instead, and “{tag.tag}” stays
              as another way of writing it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep both</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async () => {
                const into = mergeInto;
                setMergeInto(null);
                if (
                  into !== null &&
                  (await change("merge-tags", { from: tag.tag, into }))
                ) {
                  onGone();
                }
              }}
            >
              Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Retired({ tags }: { tags: TagView[] }) {
  const { change, busy } = useOwnerChange();
  return (
    <details className="group/retired">
      <summary className="-mx-2 flex cursor-default list-none items-center gap-2 rounded-md px-2 py-2 font-medium text-[0.875rem] outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {counted(tags.length, "{n} retired tag", "{n} retired tags")}
        <span className="font-normal text-muted-foreground group-open/retired:hidden">
          Show
        </span>
        <span className="hidden font-normal text-muted-foreground group-open/retired:inline">
          Hide
        </span>
      </summary>
      <ul className="flex flex-col">
        {tags.map((tag) => (
          <li
            key={tag.tag}
            data-retired-tag={tag.tag}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2.5"
          >
            <span className="min-w-0 flex-1 break-words text-muted-foreground line-through decoration-foreground/30">
              {tag.tag}
            </span>
            <span className="text-[0.8125rem] text-muted-foreground tabular-nums">
              {counted(
                tag.bookmarks,
                "{n} bookmark would have it back",
                "{n} bookmarks would have it back",
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void change("restore-tag", { tag: tag.tag })}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** How many tags there must be before a field to find one among them is worth its room. */
const FIND_ABOVE = 12;

export function Vocabulary({
  tags,
  retired,
}: {
  tags: TagView[];
  retired: TagView[];
}) {
  const id = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const names = useMemo(() => tags.map(({ tag }) => tag), [tags]);
  const wanted = find.trim().toLowerCase().replace(/^#/, "");
  const shown =
    wanted === ""
      ? tags
      : tags.filter(
          ({ tag, aliases }) =>
            tag.includes(wanted) ||
            aliases.some((alias) => alias.includes(wanted)),
        );
  return (
    <div className="flex flex-col gap-6">
      <AddTag />

      <div className="flex flex-col gap-2">
        {tags.length > FIND_ABOVE ? (
          <Input
            type="search"
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder="Find a tag"
            aria-label="Find a tag in the vocabulary"
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        <p role="status" className="text-[0.8125rem] text-muted-foreground">
          {wanted === ""
            ? counted(tags.length, "{n} tag", "{n} tags")
            : counted(
                shown.length,
                `{n} of ${tags.length} tags`,
                `{n} of ${tags.length} tags`,
              )}
        </p>
        <ul className="flex flex-col">
          {shown.map((tag, index) => {
            const isOpen = open === tag.tag;
            const panelId = `${id}-${index}`;
            return (
              <li key={tag.tag} data-tag={tag.tag} className="border-b">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="min-w-0 break-words font-medium text-[0.9375rem]">
                    {tag.tag}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-muted-foreground">
                    {tag.aliases.length > 0
                      ? `also ${tag.aliases.join(", ")}`
                      : ""}
                  </span>
                  {tag.bookmarks > 0 ? (
                    <Link
                      href={taggedWith(tag.tag)}
                      prefetch={false}
                      className={COUNT_LINK}
                    >
                      {counted(tag.bookmarks, "{n} bookmark", "{n} bookmarks")}
                    </Link>
                  ) : (
                    <span className="shrink-0 text-[0.8125rem] text-muted-foreground">
                      On no bookmark
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? panelId : undefined}
                    onClick={() => setOpen(isOpen ? null : tag.tag)}
                  >
                    {isOpen ? "Done" : "Edit"}
                    <span className="sr-only"> {tag.tag}</span>
                  </Button>
                </div>
                {isOpen ? (
                  <TagEditor
                    // A renamed tag is another row: its editor starts over.
                    key={tag.tag}
                    tag={tag}
                    others={names.filter((name) => name !== tag.tag)}
                    panelId={panelId}
                    onGone={() => setOpen(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {retired.length > 0 ? <Retired tags={retired} /> : null}
    </div>
  );
}
