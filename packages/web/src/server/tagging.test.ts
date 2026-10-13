import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openTempStore, tempDatabasePath } from "@x-bookmarks/core/testing";
import type { AutomaticPass } from "@x-bookmarks/tagger";
import { afterEach, expect, test, vi } from "vitest";
import {
  AFTER_CAPTURE_MS,
  type Pass,
  scheduleTagging,
  startTagging,
  taggingStatus,
  tagNow,
} from "./tagging.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  const shared = globalThis as {
    __xBookmarksTagging?: { timer?: NodeJS.Timeout; pending?: NodeJS.Timeout };
    __xBookmarks?: { store?: { close(): void } };
  };
  clearInterval(shared.__xBookmarksTagging?.timer);
  clearTimeout(shared.__xBookmarksTagging?.pending);
  delete shared.__xBookmarksTagging;
  shared.__xBookmarks?.store?.close();
  delete shared.__xBookmarks;
});

/** A temporary data directory that the app's settings point at. */
function setUp() {
  const path = tempDatabasePath();
  vi.stubEnv("X_BOOKMARKS_DATA_DIR", dirname(path));
  return { store: openTempStore(path), data: dirname(path) };
}

const ran = (parts: Partial<AutomaticPass> = {}): AutomaticPass => ({
  status: "nothing-to-do",
  message: "Every bookmark has been classified.",
  waiting: 0,
  reports: [],
  warning: null,
  ...parts,
});

const at = new Date("2026-10-13T09:00:00.000Z");

test("a pass is handed the app's store and its data directory, and what it came to is remembered", async () => {
  const { store } = setUp();
  const pass = vi.fn<Pass>(async () =>
    ran({ status: "no-key", message: "There is no API key.", waiting: 3 }),
  );

  const attempt = await tagNow(
    pass,
    () => store,
    () => at,
  );

  expect(pass).toHaveBeenCalledExactlyOnceWith(store);
  expect(attempt).toEqual({
    at,
    status: "no-key",
    message: "There is no API key.",
    warning: null,
    waiting: 3,
    classified: 0,
    failed: 0,
    costUsd: 0,
    problem: false,
  });
  expect(taggingStatus()).toEqual({
    lastAttempt: attempt,
    running: false,
    scheduled: false,
  });
});

test("a pass that throws is recorded and logged by the error's name alone, and nothing is thrown", async () => {
  const { store } = setUp();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  const attempt = await tagNow(
    async () => {
      throw new RangeError("a detail that quotes a bookmark");
    },
    () => store,
    () => at,
  );

  expect(attempt).toMatchObject({ status: "error", problem: true });
  expect(attempt.message).toContain("RangeError");
  expect(JSON.stringify([attempt, logged.mock.calls])).not.toContain(
    "quotes a bookmark",
  );
  expect(taggingStatus().lastAttempt).toEqual(attempt);
});

test("a library that cannot be opened is a recorded problem too, not a crash", async () => {
  setUp();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const pass = vi.fn<Pass>(async () => ran());

  const attempt = await tagNow(pass, () => {
    throw new Error("the database is locked");
  });

  expect(attempt).toMatchObject({ status: "error", problem: true });
  expect(pass).not.toHaveBeenCalled();
});

test("a run the API ended is a problem that is logged; a run that went well is not", async () => {
  const { store } = setUp();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const report = (status: "completed" | "failed") =>
    ({
      status,
      classified: 2,
      failed: 1,
      costUsd: 0.004,
    }) as AutomaticPass["reports"][number];

  const well = await tagNow(
    async () =>
      ran({ status: "ran", waiting: 3, reports: [report("completed")] }),
    () => store,
  );
  const badly = await tagNow(
    async () =>
      ran({
        status: "ran",
        message: "The Claude API could not be reached.",
        waiting: 3,
        reports: [report("failed")],
      }),
    () => store,
  );

  expect(well).toMatchObject({
    classified: 2,
    failed: 1,
    costUsd: 0.004,
    problem: false,
  });
  expect(badly.problem).toBe(true);
  expect(logged).toHaveBeenCalledExactlyOnceWith(
    "Tagging of new bookmarks: The Claude API could not be reached.",
  );
});

test("a warning about the standard key variable is remembered and logged, though the pass went well", async () => {
  const { store } = setUp();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const warning =
    "ANTHROPIC_API_KEY is set in this environment. It was not used.";

  const attempt = await tagNow(
    async () => ran({ warning }),
    () => store,
  );

  expect(attempt).toMatchObject({ warning, problem: false });
  expect(logged).toHaveBeenCalledExactlyOnceWith(
    `Tagging of new bookmarks: ${warning}`,
  );
});

test("the key is in no variable of the app's environment: not before a pass, and not after one that read it", async () => {
  const { store, data } = setUp();
  const key = "sk-ant-api03-FAKE0not0a0real0key0000000000000000";
  writeFileSync(join(data, ".env"), `X_BOOKMARKS_ANTHROPIC_API_KEY=${key}\n`, {
    mode: 0o600,
  });
  const before = { ...process.env };

  // The real tagger, which finds the key's file beside the moved data
  // directory, reads it, and has an empty library to do nothing with.
  const attempt = await tagNow(undefined, () => store);

  expect(attempt.status).toBe("nothing-to-do");
  expect(process.env).toEqual(before);
  expect(JSON.stringify(process.env)).not.toContain(key);
  expect(
    Object.keys(process.env).filter((name) => /ANTHROPIC/.test(name)),
  ).toEqual(Object.keys(before).filter((name) => /ANTHROPIC/.test(name)));
});

test("a pass asked for while one runs does not run beside it: it follows it", async () => {
  const { store } = setUp();
  let release: (value: AutomaticPass) => void = () => {};
  const pass = vi.fn<Pass>(
    () => new Promise<AutomaticPass>((resolve) => (release = resolve)),
  );

  const first = tagNow(pass, () => store);
  const second = tagNow(pass, () => store);

  expect(pass).toHaveBeenCalledOnce();
  expect(taggingStatus().running).toBe(true);
  expect(second).toBe(first);

  release(ran());
  await first;
  await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2));
  release(ran());
  await vi.waitFor(() => expect(taggingStatus().running).toBe(false));
  expect(pass).toHaveBeenCalledTimes(2);
});

test("a pass is asked for a minute after the last capture of a burst, once", async () => {
  setUp();
  vi.useFakeTimers();
  const pass = vi.fn<Pass>(async () => ran());

  scheduleTagging(AFTER_CAPTURE_MS, pass);
  await vi.advanceTimersByTimeAsync(AFTER_CAPTURE_MS - 1000);
  scheduleTagging(AFTER_CAPTURE_MS, pass);
  await vi.advanceTimersByTimeAsync(AFTER_CAPTURE_MS - 1000);

  expect(pass).not.toHaveBeenCalled();
  expect(taggingStatus().scheduled).toBe(true);

  await vi.advanceTimersByTimeAsync(1000);

  expect(pass).toHaveBeenCalledOnce();
  expect(taggingStatus().scheduled).toBe(false);
});

test("asking for a pass returns at once and never throws, whatever the pass will do", () => {
  setUp();
  vi.useFakeTimers();
  const pass = vi.fn<Pass>(async () => {
    throw new Error("later");
  });

  expect(scheduleTagging(AFTER_CAPTURE_MS, pass)).toBeUndefined();
  expect(pass).not.toHaveBeenCalled();
});

test("as the app starts a first pass follows shortly, and then one an hour; starting twice changes nothing", async () => {
  setUp();
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const pass = vi.fn<Pass>(async () => ran());

  startTagging(pass);
  startTagging(pass);
  expect(pass).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(15_000);
  expect(pass).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(pass).toHaveBeenCalledTimes(2);
});

test("with no key in place, the real pass leaves a library alone and reaches for nothing", async () => {
  const { store } = setUp();
  const requested = vi.spyOn(globalThis, "fetch");

  // The tagger itself, loaded as the app loads it.
  const attempt = await tagNow(
    undefined,
    () => store,
    () => at,
  );

  expect(attempt).toMatchObject({
    status: "nothing-to-do",
    waiting: 0,
    problem: false,
  });
  expect(requested).not.toHaveBeenCalled();
});
