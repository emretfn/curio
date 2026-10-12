"use client";

/**
 * The "load media for posts on screen" setting, kept in this browser. It is
 * off unless the owner turned it on here: the server never sees it, so no
 * page arrives with media already in it.
 */
import { useSyncExternalStore } from "react";
import { AUTO_MEDIA_STORAGE_KEY } from "@/lib/x-media-policy";

const CHANGED = "x-bookmarks:auto-media-changed";

function read(): boolean {
  try {
    return window.localStorage.getItem(AUTO_MEDIA_STORAGE_KEY) === "on";
  } catch {
    // Storage refused: the setting stays off.
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/** Whether media loads by itself for posts on screen. False on the server and until read. */
export function useAutoMedia(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

export function setAutoMedia(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(AUTO_MEDIA_STORAGE_KEY, "on");
    else window.localStorage.removeItem(AUTO_MEDIA_STORAGE_KEY);
  } catch {
    // Storage refused: nothing to remember, and the setting stays off.
  }
  window.dispatchEvent(new Event(CHANGED));
}
