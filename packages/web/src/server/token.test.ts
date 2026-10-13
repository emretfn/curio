import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { loadOrCreateToken } from "./token.ts";

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "curio-token-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a token is created once, kept private, and read back afterwards", () => {
  const directory = join(tempDirectory(), "data");

  const created = loadOrCreateToken(directory);
  const again = loadOrCreateToken(directory);

  expect(created).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(again).toBe(created);
  expect(readFileSync(join(directory, "ingest-token"), "utf8").trim()).toBe(
    created,
  );
  expect(statSync(join(directory, "ingest-token")).mode & 0o777).toBe(0o600);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});

test("two data directories get different tokens", () => {
  expect(loadOrCreateToken(tempDirectory())).not.toBe(
    loadOrCreateToken(tempDirectory()),
  );
});

test("a token file too short to be one of ours is refused, not used", () => {
  const directory = tempDirectory();
  writeFileSync(join(directory, "ingest-token"), "password\n");

  expect(() => loadOrCreateToken(directory)).toThrow(/too short/);
});
