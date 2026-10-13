"use client";

/**
 * One tag of the vocabulary, chosen from a list that can be searched: a
 * button that opens it, with the tags that resemble what is being decided
 * first when there are any.
 */
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

export function TagCombobox({
  label,
  tags,
  first = [],
  disabled,
  onPick,
}: {
  /** What the button says, such as `Alias of another tag`. */
  label: string;
  /** The tags to choose from. */
  tags: readonly string[];
  /** Tags to list before the rest. */
  first?: readonly string[];
  disabled?: boolean;
  onPick: (tag: string) => void;
}) {
  const items = useMemo(() => {
    const leading = first.filter((tag) => tags.includes(tag));
    return [...leading, ...tags.filter((tag) => !leading.includes(tag))];
  }, [tags, first]);
  return (
    <ComboboxPrimitive.Root
      items={items}
      value={null}
      onValueChange={(tag: string | null) => {
        if (tag !== null) onPick(tag);
      }}
      autoHighlight
    >
      {/* A combobox takes its name from a label, not from what is written
          in it. */}
      <ComboboxPrimitive.Trigger
        disabled={disabled}
        aria-label={label}
        render={<Button variant="outline" size="sm" />}
      >
        {label}
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent className="w-60" aria-label={label}>
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
