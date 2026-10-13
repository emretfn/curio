/**
 * The API key, and where it lives: one line of the `.env` file at the root
 * of the repo, which git ignores, under a name of this project's own. The
 * same file holds the one setting that lets the app spend by itself
 * (`appTagging`, at the end): this module is the only reader of the file.
 *
 * The name matters. The variable Anthropic's tools read by default,
 * `ANTHROPIC_API_KEY`, takes precedence over a Claude Code subscription
 * login: once it is in the environment of Claude Code, of `claude -p` or of
 * an Agent SDK process, the owner's other work is billed to the API without
 * a word. So the key is kept under `KEY_VARIABLE`, which no other tool
 * reads, and it is read from the file by this package alone: it is not
 * taken from the environment, is never put there under any name, is handed
 * to the one client in `anthropic.ts` as an argument, and appears in no
 * message, log or error. A key found under the standard name, in the
 * environment or in the file, is not used, and the owner is told.
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The file that holds the key, in the repo's root. */
export const ENV_FILE = ".env";
/** The variable the key is written under in that file. This project's own name, on purpose. */
export const KEY_VARIABLE = "X_BOOKMARKS_ANTHROPIC_API_KEY";
/**
 * The variable that lets the app tag by itself, in the same file. Only the
 * value `on` does; without the line the app sends nothing.
 */
export const APP_TAGGING_VARIABLE = "X_BOOKMARKS_APP_TAGGING";
/** The variable Anthropic's own tools read. Never used here, and warned about wherever it is found. */
const STANDARD_VARIABLE = "ANTHROPIC_API_KEY";

/**
 * The data directory: `X_BOOKMARKS_DATA_DIR` when set, as for the app, and
 * otherwise `data/` at the root of this repo, which git ignores. Found from
 * this file and not from the working directory.
 */
export function dataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.X_BOOKMARKS_DATA_DIR;
  return configured === undefined || configured === ""
    ? join(import.meta.dirname, "../../../data")
    : resolve(configured);
}

/**
 * Where the key's file is: `.env` at the root of this repo. A test or a
 * tool that has moved the data directory with `X_BOOKMARKS_DATA_DIR` gets
 * `.env` inside that directory instead, as it gets its backups there: a
 * run against a library that is not the owner's must never find the
 * owner's key.
 */
export function envFilePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const moved = environment.X_BOOKMARKS_DATA_DIR;
  return moved === undefined || moved === ""
    ? join(import.meta.dirname, "../../..", ENV_FILE)
    : join(resolve(moved), ENV_FILE);
}

/** Why there is no usable key. `message` is fit to show: it names the file and what to do, and holds nothing of the key. */
export class ApiKeyUnavailable extends Error {
  readonly reason:
    | "missing"
    | "not-a-file"
    | "loose-permissions"
    | "not-set"
    | "not-a-key";
  constructor(reason: ApiKeyUnavailable["reason"], message: string) {
    super(message);
    this.name = "ApiKeyUnavailable";
    this.reason = reason;
  }
}

/** An API key of the Claude Console: its prefix, then the characters such keys are made of. */
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/**
 * The values a `.env` file gives a variable, in the order of its lines.
 * It reads `NAME=value` with an optional `export`, with or without quotes
 * around the value, and a `#` comment after an unquoted one.
 */
function valuesOf(text: string, variable: string): string[] {
  const line = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=(.*)$`);
  return text.split(/\r?\n/).flatMap((candidate) => {
    const rest = line.exec(candidate)?.[1];
    if (rest === undefined) return [];
    const value = rest.trim();
    const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(value);
    return [quoted?.[2] ?? value.replace(/\s+#.*$/, "").trim()];
  });
}

const SETUP = (path: string) =>
  `Copy .env.example to ${path}, make it yours alone (chmod 600 "${path}"), and put the key after ${KEY_VARIABLE}= in an editor.`;

/**
 * Reads the key from the `.env` file at `path`. Refuses, saying why and
 * what to do, unless the file is a plain file that belongs to this user,
 * that no one else can read or write, and that gives `KEY_VARIABLE` one
 * value shaped like an API key. An Admin key is refused: it manages an
 * organization, and this needs none of that.
 *
 * Other users being able to read the file is a refusal and not a warning.
 * The app classifies new bookmarks by itself, where no one is looking at a
 * terminal to see a warning, and the fix is one command.
 */
export function readApiKey(path: string): string {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new ApiKeyUnavailable(
      "missing",
      `There is no API key yet: ${path} does not exist. Create a key in the Claude Console, in a workspace with a spend limit. ${SETUP(path)}`,
    );
  }
  if (!stat.isFile()) {
    throw new ApiKeyUnavailable(
      "not-a-file",
      `${path} is not a file. The API key is kept in a file of that name.`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ApiKeyUnavailable(
      "loose-permissions",
      `${path} belongs to another user. The file that holds the API key must be yours.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ApiKeyUnavailable(
      "loose-permissions",
      `${path} can be read or written by other users of this computer (mode ${(stat.mode & 0o777).toString(8)}), and it holds a key that spends money. Make it yours alone:  chmod 600 "${path}"`,
    );
  }
  const text = readFileSync(path, "utf8");
  const key = valuesOf(text, KEY_VARIABLE).at(-1) ?? "";
  if (key === "") {
    throw new ApiKeyUnavailable(
      "not-set",
      valuesOf(text, STANDARD_VARIABLE).length > 0
        ? `${path} gives ${STANDARD_VARIABLE} and not ${KEY_VARIABLE}. The first is not read, on purpose: under that name a key takes over Claude Code's billing wherever the file is loaded. Rename the line to ${KEY_VARIABLE}=`
        : `${path} gives ${KEY_VARIABLE} no value. Put the key after ${KEY_VARIABLE}= in an editor.`,
    );
  }
  if (!KEY_SHAPE.test(key) || key.startsWith("sk-ant-admin")) {
    throw new ApiKeyUnavailable(
      "not-a-key",
      `The value of ${KEY_VARIABLE} in ${path} is not an API key of the Claude Console. It should start with sk-ant- and not be an Admin key.`,
    );
  }
  return key;
}

/**
 * Where the standard variable is set, if anywhere: in this process's
 * environment, in the key's file, or both. This package uses neither. The
 * owner is told, because Claude Code reads the first, and anything that
 * loads a `.env` file into an environment turns the second into the first.
 */
export function standardKeyWarning(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const inEnvironment = (environment[STANDARD_VARIABLE] ?? "") !== "";
  let inFile = false;
  try {
    inFile = valuesOf(readFileSync(path, "utf8"), STANDARD_VARIABLE).some(
      (value) => value !== "",
    );
  } catch {
    // No file, or one that cannot be read: `readApiKey` says so.
  }
  if (!inEnvironment && !inFile) return null;
  const where =
    inEnvironment && inFile
      ? `in this environment and in ${path}`
      : inEnvironment
        ? "in this environment"
        : `in ${path}`;
  return `${STANDARD_VARIABLE} is set ${where}. It was not used: the classifier reads ${KEY_VARIABLE} from ${path} and nothing else. Claude Code does read ${STANDARD_VARIABLE}, and bills the API instead of your subscription wherever it is set: remove it.`;
}

/** Whether the app may tag by itself, and what to tell the owner about it. */
export interface AppTagging {
  on: boolean;
  /** Fit to show: whether it is on, how to change that, and what does the same by hand. */
  message: string;
}

/**
 * Whether the owner has let the app tag by itself. The app's own passes
 * spend the owner's money with no one watching, so they are off unless the
 * owner turned them on, in the one place the owner puts things that matter:
 * a line of the `.env` file, written by hand. Nothing in this repo writes
 * that file, and no page, route or tool can change the answer. It is read
 * from the file each time it is asked, so the owner's edit takes effect at
 * the next pass, and never from an environment.
 *
 * Only `on` turns it on. A missing file, a missing line, an empty value,
 * any other value, or two lines that disagree is off: a setting that spends
 * money does not guess.
 */
export function appTagging(path: string = envFilePath()): AppTagging {
  let values: string[] = [];
  try {
    values = valuesOf(readFileSync(path, "utf8"), APP_TAGGING_VARIABLE);
  } catch {
    // No file, or one that cannot be read: off.
  }
  const set = values.some((value) => value !== "");
  const byHand =
    "By hand, pnpm tag classifies what is waiting and pnpm tag --new-tags asks about tags added since.";
  // Every line that sets it has to agree: two lines that differ are not a yes.
  if (set && values.every((value) => value.toLowerCase() === "on")) {
    return {
      on: true,
      message: `Tagging by the app is on: it classifies new bookmarks by itself, within the allowance of a pass and of a day. To turn it off, remove ${APP_TAGGING_VARIABLE}=on from ${path}. ${byHand}`,
    };
  }
  return {
    on: false,
    message: `Tagging by the app is off: by itself the app sends nothing to the API and spends nothing.${set ? ` ${APP_TAGGING_VARIABLE} is set in ${path}, but only the value "on" turns it on.` : ""} To turn it on, add the line ${APP_TAGGING_VARIABLE}=on to ${path}; it takes effect at the app's next pass, with no restart. ${byHand}`,
  };
}
