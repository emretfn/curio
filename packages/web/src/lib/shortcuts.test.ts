import { expect, test } from "vitest";
import {
  LIST_KEYS,
  playerAction,
  SEARCH_KEY,
  SEEK_SECONDS,
  VOLUME_STEP,
} from "./shortcuts.ts";

const press = (
  key: string,
  modifiers: Partial<Record<string, boolean>> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

test("the player answers to none of the list's keys, whatever has focus in it", () => {
  for (const key of [...LIST_KEYS, SEARCH_KEY]) {
    for (const on of ["player", "button", "volume"] as const) {
      expect(playerAction(press(key), on), key).toBeNull();
      expect(playerAction(press(key.toUpperCase()), on), key).toBeNull();
    }
  }
  expect(LIST_KEYS).toEqual(["j", "k", "e", "m", "o"]);
  expect(SEARCH_KEY).toBe("/");
});

test("the usual video keys play, seek, change the volume and the speed, and fill the screen", () => {
  const on = "player";

  expect(playerAction(press(" "), on)).toEqual({ kind: "toggle" });
  expect(playerAction(press("ArrowLeft"), on)).toEqual({
    kind: "seek-by",
    seconds: -SEEK_SECONDS,
  });
  expect(playerAction(press("ArrowRight"), on)).toEqual({
    kind: "seek-by",
    seconds: SEEK_SECONDS,
  });
  expect(playerAction(press("ArrowUp"), on)).toEqual({
    kind: "volume-by",
    amount: VOLUME_STEP,
  });
  expect(playerAction(press("ArrowDown"), on)).toEqual({
    kind: "volume-by",
    amount: -VOLUME_STEP,
  });
  expect(playerAction(press("Home"), on)).toEqual({
    kind: "seek-to",
    fraction: 0,
  });
  expect(playerAction(press("End"), on)).toEqual({
    kind: "seek-to",
    fraction: 1,
  });
  expect(playerAction(press("3"), on)).toEqual({
    kind: "seek-to",
    fraction: 0.3,
  });
  expect(playerAction(press("<"), on)).toEqual({ kind: "speed", step: -1 });
  expect(playerAction(press(">"), on)).toEqual({ kind: "speed", step: 1 });
  expect(playerAction(press("f"), on)).toEqual({ kind: "fullscreen" });
  expect(playerAction(press("F"), on)).toEqual({ kind: "fullscreen" });
});

test("Space presses the button that has focus, and plays or pauses from anywhere else", () => {
  expect(playerAction(press(" "), "button")).toBeNull();
  expect(playerAction(press("Enter"), "button")).toBeNull();
  expect(playerAction(press("Enter"), "player")).toBeNull();
  expect(playerAction(press(" "), "volume")).toEqual({ kind: "toggle" });
  // The other keys work with a button in focus as well.
  expect(playerAction(press("ArrowRight"), "button")).toEqual({
    kind: "seek-by",
    seconds: SEEK_SECONDS,
  });
});

test("on the volume slider every arrow is volume, and Home and End are its ends", () => {
  const on = "volume";

  expect(playerAction(press("ArrowLeft"), on)).toEqual({
    kind: "volume-by",
    amount: -VOLUME_STEP,
  });
  expect(playerAction(press("ArrowRight"), on)).toEqual({
    kind: "volume-by",
    amount: VOLUME_STEP,
  });
  expect(playerAction(press("Home"), on)).toEqual({
    kind: "volume-to",
    level: 0,
  });
  expect(playerAction(press("End"), on)).toEqual({
    kind: "volume-to",
    level: 1,
  });
});

test("a key held with Control, Command or Alt is the browser's, and an unknown key is nobody's", () => {
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    expect(
      playerAction(press("ArrowLeft", { [modifier]: true }), "player"),
    ).toBeNull();
    expect(playerAction(press("f", { [modifier]: true }), "player")).toBeNull();
  }
  for (const key of ["a", "Tab", "Escape", "Shift", "l", ","]) {
    expect(playerAction(press(key), "player"), key).toBeNull();
  }
});
