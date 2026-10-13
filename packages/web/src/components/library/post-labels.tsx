"use client";

/**
 * What a post is filed under, on one quiet line beneath it: its category,
 * its format and its tags. Each is also the way to change it. The category
 * and the format open a menu of the taxonomy's own; a tag leads to every
 * bookmark that has it, and the control after the tags adds and removes
 * them from the vocabulary's.
 *
 * A change is the owner's correction: it is sent to the app, stored apart
 * from the classifier's answer, and outlives every later run. The line shows
 * what the app answered, so what is on screen is what is stored. A part the
 * owner set can be handed back to the classifier from its menu.
 *
 * Keys, with a post in focus: C the category, R the format, T the tags, and
 * in an open menu a digit chooses by number. Nothing here animates: these
 * are pressed for post after post.
 */
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { offeredTags, tagChange } from "@/lib/label-edits";
import { failureMessage, ownerWrite } from "@/lib/owner-write";
import type { LabelsView } from "@/lib/post-view";
import { cn } from "@/lib/utils";
import {
  type LabelChoice,
  labelOf,
  useLabelChoices,
} from "./label-choices.tsx";
import { useRemembered } from "./row-memory.tsx";

/** A label that is also a control. The press area is taller than it looks. */
const CONTROL =
  "relative inline-flex h-6 max-w-full shrink-0 items-center gap-0.5 rounded-md px-1.5 outline-none transition-colors duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground";

/**
 * A control for a part that is not set yet. It keeps its place and stays
 * out of the way until the post is pointed at or holds the keyboard; where
 * there is no pointer to point with, it is simply there.
 */
const AT_HAND =
  "opacity-0 transition-[opacity,background-color,color] group-focus-within/post:opacity-100 group-hover/post:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100";

interface Change {
  category?: string | null;
  format?: string | null;
  addTags?: string[];
  removeTags?: string[];
  resetTags?: string[];
}

/** One of the taxonomy's two lists, as a menu that sets it. */
function PartMenu({
  part,
  name,
  choices,
  value,
  empty,
  corrected,
  classifiers,
  quiet,
  strong,
  onChoose,
}: {
  part: "category" | "format";
  /** `Category`. */
  name: string;
  choices: LabelChoice[];
  value: string | null;
  /** What the control reads while nothing is set. */
  empty: string;
  corrected: boolean;
  /** What the classifier said for this part, where it has said anything. */
  classifiers: string | null;
  quiet: boolean;
  strong?: boolean;
  onChoose: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (id: string | null) => {
    setOpen(false);
    if (id !== value) onChoose(id);
  };
  // A digit chooses by its place in the list, without the arrows.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const choice = /^[1-9]$/.test(event.key)
      ? choices[Number(event.key) - 1]
      : undefined;
    if (choice === undefined) return;
    event.preventDefault();
    choose(choice.id);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        data-edit={part}
        data-value={value ?? ""}
        data-corrected={corrected ? "" : undefined}
        className={cn(
          CONTROL,
          strong && value !== null && "font-medium text-foreground/80",
          quiet && AT_HAND,
        )}
      >
        <span className="sr-only">{name}: </span>
        <span className="truncate">
          {value === null ? empty : labelOf(choices, value)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3 shrink-0 opacity-60"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" onKeyDown={onKeyDown}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{name}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value ?? ""}
            onValueChange={(id: string) => choose(id)}
          >
            {choices.map((choice, index) => (
              <DropdownMenuRadioItem
                key={choice.id}
                value={choice.id}
                title={choice.definition}
                closeOnClick
              >
                <span
                  aria-hidden="true"
                  className="w-3.5 shrink-0 text-center text-muted-foreground text-xs tabular-nums"
                >
                  {index < 9 ? index + 1 : ""}
                </span>
                {choice.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {corrected ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>You set this yourself</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => choose(null)}>
                {classifiers === null
                  ? `Clear the ${part}`
                  : `Use the classifier’s: ${labelOf(choices, classifiers)}`}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The vocabulary's tags, to put on the post or take off it. */
function TagPicker({
  tags,
  quiet,
  onChange,
}: {
  tags: string[];
  quiet: boolean;
  onChange: (tags: string[]) => void;
}) {
  const { tags: vocabulary } = useLabelChoices();
  const [open, setOpen] = useState(false);
  // The post's own tags first, as they stood when the list was opened. The
  // order is worked out at that moment and kept until it is opened again:
  // the page is read again after every switch, and a list put in order
  // again then would move another tag under the pointer.
  const [items, setItems] = useState<string[]>([]);
  const openOrClose = (next: boolean) => {
    if (next) {
      setItems(
        offeredTags(
          vocabulary.map(({ tag }) => tag),
          tags,
        ),
      );
    }
    setOpen(next);
  };
  const aliases = useMemo(
    () => new Map(vocabulary.map(({ tag, aliases }) => [tag, aliases])),
    [vocabulary],
  );
  // A tag is found by its name or by another way of writing it.
  const filter = useCallback(
    (tag: string, query: string) => {
      const wanted = query.trim().toLowerCase().replace(/^#/, "");
      return (
        wanted === "" ||
        tag.includes(wanted) ||
        (aliases.get(tag) ?? []).some((alias) => alias.includes(wanted))
      );
    },
    [aliases],
  );
  return (
    <ComboboxPrimitive.Root
      items={items}
      multiple
      value={tags}
      onValueChange={(next: string[]) => onChange(next)}
      open={open}
      onOpenChange={openOrClose}
      filter={filter}
      autoHighlight
    >
      {/* The control is a combobox, which takes its name from a label and
          not from what is written in it. */}
      <ComboboxPrimitive.Trigger
        data-edit="tags"
        aria-label="Add or remove tags"
        className={cn(CONTROL, quiet && AT_HAND)}
      >
        <Plus aria-hidden="true" className="size-3 shrink-0 opacity-70" />
        Tag
      </ComboboxPrimitive.Trigger>
      <ComboboxContent className="w-60" aria-label="Tags of this post">
        <ComboboxInput
          showTrigger={false}
          placeholder="Find a tag"
          aria-label="Find a tag"
        />
        <ComboboxEmpty>No tag by that name.</ComboboxEmpty>
        <ComboboxList>
          {(tag: string) => (
            <ComboboxItem key={tag} value={tag}>
              {tag}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  );
}

export function PostLabels({
  postId,
  initial,
}: {
  postId: string;
  /** As the server sent them with the post. */
  initial: LabelsView;
}) {
  const choices = useLabelChoices();
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Kept by the row, which leaves the page when it is scrolled away: what
  // was corrected stays corrected when it comes back.
  const [labels, setLabels] = useRemembered("labels", initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * The tags as the owner last switched them, while the app has yet to
   * answer. The list of tags is ticked from these, and a second switch is
   * worked out from the first, not from an answer that is still on its way.
   * The line itself shows only what the app has answered.
   */
  const [askedTags, setAskedTags] = useState<string[] | null>(null);
  const onTheirWay = useRef(0);
  /**
   * The changes made to this post, one after another. Each is sent when the
   * one before has been answered, so the answers arrive in the order the
   * changes were made and the last one shown is the last one stored.
   */
  const inTurn = useRef<Promise<void>>(Promise.resolve());

  const save = (change: Change): void => {
    onTheirWay.current += 1;
    setSaving(true);
    setFailure(null);
    inTurn.current = inTurn.current.then(() => send(change));
  };
  const send = async (change: Change): Promise<void> => {
    try {
      const answer = await ownerWrite("correct", { postId, ...change });
      if (answer.labels !== undefined) setLabels(answer.labels);
      // The counts beside the filters are the server's; the list keeps its
      // place and this row.
      startTransition(() => router.refresh());
    } catch (error) {
      setFailure(failureMessage(error));
    } finally {
      onTheirWay.current -= 1;
      if (onTheirWay.current === 0) {
        setSaving(false);
        setAskedTags(null);
      }
    }
  };

  const tagsNow = askedTags ?? labels.tags;
  const setTags = (next: string[]) => {
    setAskedTags(next);
    save(tagChange(next, tagsNow, labels.classifier?.tags ?? []));
  };

  const filed = labels.category !== null;
  const bare = !filed && labels.format === null && labels.tags.length === 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        data-labels=""
        aria-busy={saving || undefined}
        className={cn(
          "-mx-1.5 flex scroll-mt-28 scroll-mb-6 flex-wrap items-center gap-y-1 text-[0.8125rem] text-muted-foreground transition-opacity duration-150 ease-out",
          // The wait keeps a quick answer from flickering.
          saving && "opacity-60 delay-150",
        )}
      >
        <PartMenu
          part="category"
          name="Category"
          choices={choices.categories}
          value={labels.category}
          empty="Not classified yet"
          corrected={labels.corrected.category}
          classifiers={labels.classifier?.category ?? null}
          quiet={false}
          strong
          onChoose={(category) => save({ category })}
        />
        {labels.tooLittleText ? (
          <span
            className="pe-1.5"
            title="The classifier found too little stored text to tell what this post is about."
          >
            too little text to tell
          </span>
        ) : null}
        <span aria-hidden="true" className={cn(bare && AT_HAND)}>
          ·
        </span>
        <PartMenu
          part="format"
          name="Format"
          choices={choices.formats}
          value={labels.format}
          empty="No format"
          corrected={labels.corrected.format}
          classifiers={labels.classifier?.format ?? null}
          quiet={bare}
          onChoose={(format) => save({ format })}
        />
        {labels.tags.length > 0 ? (
          <ul aria-label="Tags" className="contents">
            {labels.tags.map((tag) => (
              <li key={tag} className="contents">
                <Link
                  href={`/?tag=${encodeURIComponent(tag)}`}
                  prefetch={false}
                  title={`Show every bookmark tagged ${tag}`}
                  className="relative rounded-sm px-1.5 outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  #{tag}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <TagPicker tags={tagsNow} quiet onChange={setTags} />
      </div>
      {failure !== null ? (
        <p role="alert" className="text-[0.8125rem] text-destructive">
          Not saved. {failure}
        </p>
      ) : null}
    </div>
  );
}
