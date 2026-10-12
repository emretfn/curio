"use client";

/**
 * The two choices the owner makes about this browser: light or dark, and
 * whether media loads by itself. Both are kept in the browser's own storage
 * and neither is known to the server.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { useId, useSyncExternalStore } from "react";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { setAutoMedia, useAutoMedia } from "./auto-media.ts";

const THEME_CHANGED = "x-bookmarks:theme-changed";

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark) return;
  // Every colour on the page changes at once. Without this each element's
  // own colour transition would run, and the switch would smear.
  const still = document.createElement("style");
  still.append("*,*::before,*::after{transition:none !important}");
  document.head.append(still);
  root.classList.toggle("dark", dark);
  void document.body.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => still.remove()));
}

function subscribeTheme(onChange: () => void): () => void {
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const changed = () => {
    applyTheme(readTheme());
    onChange();
  };
  window.addEventListener("storage", changed);
  window.addEventListener(THEME_CHANGED, changed);
  system.addEventListener("change", changed);
  return () => {
    window.removeEventListener("storage", changed);
    window.removeEventListener(THEME_CHANGED, changed);
    system.removeEventListener("change", changed);
  };
}

function setTheme(theme: Theme): void {
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage refused: the choice lasts until the page is closed.
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_CHANGED));
}

const THEMES = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

export function ThemeSetting({ compact }: { compact?: boolean }) {
  const theme = useSyncExternalStore<Theme>(
    subscribeTheme,
    readTheme,
    () => "system",
  );
  const labelId = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        id={labelId}
        className={compact ? "sr-only" : "font-medium text-[0.8125rem]"}
      >
        Theme
      </span>
      <ToggleGroup
        aria-labelledby={labelId}
        size="sm"
        variant="outline"
        spacing={0}
        value={[theme]}
        onValueChange={(chosen) => {
          const next = THEMES.find((option) => option.value === chosen[0]);
          if (next !== undefined) setTheme(next.value);
        }}
      >
        {THEMES.map(({ value, label, icon: Icon }) => (
          <ToggleGroupItem
            key={value}
            value={value}
            aria-label={label}
            title={label}
          >
            <Icon aria-hidden="true" />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function AutoMediaSetting() {
  const on = useAutoMedia();
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label
          id={`${id}-label`}
          htmlFor={id}
          className="font-medium text-[0.8125rem]"
        >
          Load media on screen
        </label>
        <p
          id={`${id}-about`}
          className="text-muted-foreground text-xs leading-normal"
        >
          {on
            ? "Photos and video posters load from X as posts come into view."
            : "Nothing loads from X until you choose Show media on a post."}
        </p>
      </div>
      <Switch
        id={id}
        size="sm"
        className="mt-0.5"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-about`}
        checked={on}
        onCheckedChange={setAutoMedia}
      />
    </div>
  );
}
