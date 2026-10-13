/**
 * Pins the schedule the owner may install: what the launchd job runs, when,
 * and that it can spend no more than it says. The job is a template in the
 * repo. No test installs it, and nothing in the repo does.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestWeekEnded, WEEK_ENDS_SUNDAY_AT_HOUR } from "@curio/core";
import { expect, test } from "vitest";
import { DEFAULT_DIGEST_CAP_USD } from "./run.ts";

const directory = join(import.meta.dirname, "../../launchd");
const plist = readFileSync(join(directory, "dev.curio.digest.plist"), "utf8");
/** The file without its comment. */
const body = plist.replace(/<!--[\s\S]*?-->/g, "");

const strings = (key: string) => {
  const [, array = ""] =
    new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(body) ??
    [];
  return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(
    ([, value]) => value,
  );
};
const integer = (key: string) =>
  Number(
    new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(
      body,
    )?.[1],
  );

test("the job runs the digest's command, marked as the schedule's, under a cap no higher than the command's own", () => {
  const [node, script, ...flags] = strings("ProgramArguments");

  expect(node).toBe("__NODE__");
  expect(script).toBe("__REPO__/packages/tagger/src/digest/cli.ts");
  expect(flags).toEqual(["--scheduled", "--max-usd", "0.50"]);
  expect(Number(flags[2])).toBeLessThanOrEqual(DEFAULT_DIGEST_CAP_USD);
  // It names no week, so it writes the one that last ended, and it never
  // asks for a week to be written a second time.
  expect(flags).not.toContain("--week");
  expect(flags).not.toContain("--again");
});

test("it fires once a week, on Sunday evening, after the hour from which the week then ending is the one to write", () => {
  expect(integer("Weekday")).toBe(0);
  expect(integer("Hour")).toBeGreaterThanOrEqual(WEEK_ENDS_SUNDAY_AT_HOUR);
  expect(integer("Minute")).toBe(0);
  // 11 October 2026 is a Sunday: at the job's hour, the week to write is
  // the one that began on Monday the 5th.
  const fires = new Date(2026, 9, 11, integer("Hour"), integer("Minute"));
  expect(latestWeekEnded(fires).key).toBe("2026-10-05");
  // Nothing starts it at login, restarts it, or repeats it within the week.
  expect(body).not.toMatch(/RunAtLoad|KeepAlive|StartInterval|WatchPaths/);
  expect(body.match(/<key>StartCalendarInterval<\/key>/g)).toHaveLength(1);
});

test("it holds no key and no address, and writes its log where the owner's logs are", () => {
  expect(body).not.toMatch(/sk-ant|ANTHROPIC|EnvironmentVariables/);
  expect(body.replace(/<!DOCTYPE[^>]*>/, "")).not.toMatch(/https?:\/\//);
  expect(body).toMatch(
    /<key>StandardOutPath<\/key>\s*<string>__HOME__\/Library\/Logs\/curio-digest\.log<\/string>/,
  );
  expect(body.match(/__[A-Z]+__/g)?.toSorted()).toEqual([
    "__HOME__",
    "__HOME__",
    "__NODE__",
    "__REPO__",
    "__REPO__",
  ]);
});

test("the template is the only thing in the directory, and nothing in this package starts launchd", () => {
  expect(readdirSync(directory)).toEqual(["dev.curio.digest.plist"]);
  const sources = readdirSync(import.meta.dirname)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(join(import.meta.dirname, name), "utf8"));

  for (const source of sources) {
    expect(source).not.toMatch(/launchctl|LaunchAgents|child_process/);
  }
});
