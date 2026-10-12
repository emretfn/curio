import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = "ingest-token";

/**
 * Reads the pairing token from the data directory, creating it on first use.
 * The file is readable by its owner only. Deleting it and restarting the app
 * makes a new token, which unpairs the extension.
 */
export function loadOrCreateToken(directory: string): string {
  const path = join(directory, TOKEN_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    // "wx" fails when the file exists, so two processes starting together
    // cannot each write a token.
    writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) {
    throw new Error(
      `The pairing token in ${path} is too short to be one this app made. Delete the file and restart to create a new one.`,
    );
  }
  return token;
}
