/**
 * The app's keys, in one place, so that two parts of the screen never
 * answer to the same one at the same time.
 *
 * The list and the search field own their keys wherever focus is. The video
 * player answers to the usual video keys while focus is inside it, and to
 * none of the list's but one: `J` and `K` still move between posts from
 * inside a player, and so do the rest. The one is `M`. On a post it shows
 * the post's media; inside a player the media is already shown, and `M`
 * mutes and unmutes, as it does in every other player.
 */

/**
 * Next and previous post, open or close a long post, show media, open on X;
 * and what the post is filed under: its category, its format, its tags.
 */
export const LIST_KEYS: readonly string[] = [
  "j",
  "k",
  "e",
  "m",
  "o",
  "c",
  "r",
  "t",
];
/** The list's key that a player takes for itself while focus is inside it. */
export const MUTE_KEY = "m";
/** Reaches the search field from anywhere. */
export const SEARCH_KEY = "/";

/** How far the arrow keys move a video, in seconds. */
export const SEEK_SECONDS = 5;
/** How far the arrow keys move the volume, of 1. */
export const VOLUME_STEP = 0.1;

export type PlayerAction =
  | { kind: "toggle" }
  | { kind: "seek-by"; seconds: number }
  /** To this part of the whole, 0 to 1. */
  | { kind: "seek-to"; fraction: number }
  | { kind: "volume-by"; amount: number }
  | { kind: "volume-to"; level: number }
  | { kind: "mute" }
  | { kind: "speed"; step: 1 | -1 }
  | { kind: "fullscreen" };

export interface PlayerKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * What a key pressed inside a player does, or null when it is not the
 * player's: then the browser, or the list, does what it would have done.
 *
 * `on` is what has focus: a button, which Space and Enter press as they
 * press any button; the volume slider, where every arrow is volume; or
 * anything else in the player.
 */
export function playerAction(
  { key, ctrlKey, metaKey, altKey }: PlayerKey,
  on: "button" | "volume" | "player",
): PlayerAction | null {
  if (ctrlKey || metaKey || altKey) return null;
  const lower = key.toLowerCase();
  if (lower === MUTE_KEY) return { kind: "mute" };
  if (LIST_KEYS.includes(lower) || key === SEARCH_KEY) return null;
  if (on === "volume") {
    if (key === "ArrowLeft" || key === "ArrowDown") {
      return { kind: "volume-by", amount: -VOLUME_STEP };
    }
    if (key === "ArrowRight" || key === "ArrowUp") {
      return { kind: "volume-by", amount: VOLUME_STEP };
    }
    if (key === "Home") return { kind: "volume-to", level: 0 };
    if (key === "End") return { kind: "volume-to", level: 1 };
  }
  switch (key) {
    case " ":
      return on === "button" ? null : { kind: "toggle" };
    case "ArrowLeft":
      return { kind: "seek-by", seconds: -SEEK_SECONDS };
    case "ArrowRight":
      return { kind: "seek-by", seconds: SEEK_SECONDS };
    case "ArrowUp":
      return { kind: "volume-by", amount: VOLUME_STEP };
    case "ArrowDown":
      return { kind: "volume-by", amount: -VOLUME_STEP };
    case "Home":
      return { kind: "seek-to", fraction: 0 };
    case "End":
      return { kind: "seek-to", fraction: 1 };
    case "<":
      return { kind: "speed", step: -1 };
    case ">":
      return { kind: "speed", step: 1 };
    default:
      break;
  }
  if (lower === "f") return { kind: "fullscreen" };
  if (/^[0-9]$/.test(key))
    return { kind: "seek-to", fraction: Number(key) / 10 };
  return null;
}
