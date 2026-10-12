"use client";

/**
 * The search field. It searches as the owner types, a moment after the last
 * key, and keeps the search in the address bar. `/` puts the cursor in it
 * from anywhere, and Escape clears it, then leaves it.
 */
import { SearchIcon, XIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { SEARCH_KEY } from "@/lib/shortcuts";
import { useLibraryFrame } from "./library-frame.tsx";

const WAIT_MS = 200;
const MAX_LENGTH = 200;

/** A search as the server will read it back, so the two can be compared. */
const normalise = (value: string) => value.trim().slice(0, MAX_LENGTH);

export function SearchBox({ query }: { query: string }) {
  const { go } = useLibraryFrame();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(query);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // The last search this field asked for. The address catching up with it
  // must not overwrite what has been typed since.
  const asked = useRef(query);

  useEffect(() => {
    if (query !== asked.current) {
      asked.current = query;
      setValue(query);
    }
  }, [query]);

  const search = useCallback(
    (next: string) => {
      window.clearTimeout(timer.current);
      const wanted = normalise(next);
      if (wanted === asked.current) return;
      asked.current = wanted;
      const params = new URLSearchParams(searchParams.toString());
      if (wanted === "") params.delete("q");
      else params.set("q", wanted);
      const rest = params.toString();
      go(rest === "" ? "/" : `/?${rest}`);
    },
    [go, searchParams],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (
        event.key !== SEARCH_KEY ||
        typing ||
        event.metaKey ||
        event.ctrlKey
      ) {
        return;
      }
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <search className="min-w-0 flex-1">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          search(value);
        }}
      >
        <label htmlFor="library-search" className="sr-only">
          Search bookmarks
        </label>
        <InputGroup className="h-9">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            id="library-search"
            name="q"
            type="search"
            value={value}
            maxLength={MAX_LENGTH}
            placeholder="Search bookmarks"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            className="[&::-webkit-search-cancel-button]:appearance-none"
            onChange={(event) => {
              const next = event.target.value;
              setValue(next);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => search(next), WAIT_MS);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (value === "") {
                event.currentTarget.blur();
              } else {
                setValue("");
                search("");
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            {value === "" ? (
              <Kbd aria-hidden="true">/</Kbd>
            ) : (
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => {
                  setValue("");
                  search("");
                  input.current?.focus();
                }}
              >
                <XIcon aria-hidden="true" />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </search>
  );
}
