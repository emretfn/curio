import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  APP_TAGGING_VARIABLE,
  ApiKeyUnavailable,
  appTagging,
  dataDirectory,
  ENV_FILE,
  envFilePath,
  KEY_VARIABLE,
  readApiKey,
  standardKeyWarning,
} from "./api-key.ts";
import { FAKE_KEY } from "./testing/fake-api.ts";
import { writeKey } from "./testing/library.ts";

const STANDARD = "ANTHROPIC_API_KEY";
/** What the key's variable and the app's switch were called before the project was named Curio. */
const FORMER_KEY = "X_BOOKMARKS_ANTHROPIC_API_KEY";
const FORMER_SWITCH = "X_BOOKMARKS_APP_TAGGING";
const OTHER_KEY = "sk-ant-api03-UNDER0THE0STANDARD0NAME000000000000";

function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "curio-key-"));
  onTestFinished(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

/** A `.env` file with this content, readable by its owner alone. */
const envWith = (content: string, mode = 0o600) =>
  writeKey(directory(), { content, mode });

/** What `readApiKey` refuses with, for a file. */
function refusal(path: string): ApiKeyUnavailable {
  try {
    readApiKey(path);
  } catch (error) {
    if (error instanceof ApiKeyUnavailable) return error;
    throw error;
  }
  throw new Error("The key was read.");
}

test("the key is read from its line of the .env file", () => {
  expect(readApiKey(writeKey(directory()))).toBe(FAKE_KEY);
  expect(KEY_VARIABLE).toBe("CURIO_ANTHROPIC_API_KEY");
});

test.each([
  ["plain", `${KEY_VARIABLE}=${FAKE_KEY}`],
  ["with spaces around the sign", `${KEY_VARIABLE} = ${FAKE_KEY}  `],
  ["in double quotes", `${KEY_VARIABLE}="${FAKE_KEY}"`],
  ["in single quotes", `${KEY_VARIABLE}='${FAKE_KEY}'`],
  ["exported, as a shell would write it", `export ${KEY_VARIABLE}=${FAKE_KEY}`],
  ["with a comment after it", `${KEY_VARIABLE}=${FAKE_KEY} # the tagging key`],
  [
    "with a comment after its quotes",
    `${KEY_VARIABLE}="${FAKE_KEY}" # tagging`,
  ],
  ["with Windows line ends", `OTHER=1\r\n${KEY_VARIABLE}=${FAKE_KEY}\r\n`],
  [
    "among other lines",
    `# settings\nSOMETHING_ELSE=1\n\n${KEY_VARIABLE}=${FAKE_KEY}\nLAST=2\n`,
  ],
  [
    "given twice, where the later line wins as it would in a shell",
    `${KEY_VARIABLE}=sk-ant-api03-AN0OLDER0KEY00000000000000000000\n${KEY_VARIABLE}=${FAKE_KEY}\n`,
  ],
])("a key written %s is read", (_, content) => {
  expect(readApiKey(envWith(content))).toBe(FAKE_KEY);
});

test("the key under the standard name is not read, and the refusal says to rename it", () => {
  const refused = refusal(envWith(`${STANDARD}=${OTHER_KEY}\n`));

  expect(refused.reason).toBe("not-set");
  expect(refused.message).toContain(`Rename the line to ${KEY_VARIABLE}=`);
  expect(refused.message).not.toContain(OTHER_KEY);
});

test("with the key under both names, this project's is the one read", () => {
  const path = envWith(
    `${STANDARD}=${OTHER_KEY}\n${KEY_VARIABLE}=${FAKE_KEY}\n`,
  );

  expect(readApiKey(path)).toBe(FAKE_KEY);
});

test("a key still under the variable's former name is not read, and the refusal names the line to rename", () => {
  // A file as the example was before the rename, filled in by its owner.
  const path = envWith(
    `# settings\n\n${FORMER_KEY}=${FAKE_KEY}\n${FORMER_SWITCH}=\n`,
  );
  const refused = refusal(path);

  expect(refused.reason).toBe("former-name");
  expect(refused.message).toBe(
    `Line 3 of ${path} gives the key under ${FORMER_KEY}, the variable's name before the project was called Curio. It is no longer read. In an editor, change that line's name to ${KEY_VARIABLE} and leave the value as it is.`,
  );
  expect(refused.message).not.toContain(FAKE_KEY);
});

test("the former name with no value is no key under any name, and is refused as an empty file is", () => {
  const refused = refusal(envWith(`${FORMER_KEY}=\n`));

  expect(refused.reason).toBe("not-set");
  expect(refused.message).not.toContain(FORMER_KEY);
});

test("once the line is renamed the key is read, and a line left under the former name changes nothing", () => {
  const renamed = envWith(`# settings\n\n${KEY_VARIABLE}=${FAKE_KEY}\n`);
  const both = envWith(
    `${FORMER_KEY}=${OTHER_KEY}\n${KEY_VARIABLE}=${FAKE_KEY}\n`,
  );

  expect(readApiKey(renamed)).toBe(FAKE_KEY);
  expect(readApiKey(both)).toBe(FAKE_KEY);
});

test("a switch still under its former name leaves the app's tagging off, and the message names the line to rename", () => {
  const path = envWith(`${KEY_VARIABLE}=${FAKE_KEY}\n${FORMER_SWITCH}=on\n`);
  const tagging = appTagging(path);

  expect(tagging.on).toBe(false);
  expect(tagging.message).toContain(
    `Line 2 of ${path} sets ${FORMER_SWITCH}, the setting's name before the project was called Curio, which is no longer read: to keep what it says, change that line's name to ${APP_TAGGING_VARIABLE} in an editor.`,
  );
  expect(tagging.message).not.toContain(FAKE_KEY);
});

test("the switch under its former name is mentioned only where it says something, and never turns anything on", () => {
  const empty = appTagging(envWith(`${FORMER_SWITCH}=\n`));
  const renamed = appTagging(
    envWith(`${APP_TAGGING_VARIABLE}=on\n${FORMER_SWITCH}=off\n`),
  );
  const onlyFormer = appTagging(
    envWith(`${APP_TAGGING_VARIABLE}=\n${FORMER_SWITCH}=on\n`),
  );

  expect(empty.on).toBe(false);
  expect(empty.message).not.toContain(FORMER_SWITCH);
  // The line under the setting's own name is the one that counts.
  expect(renamed.on).toBe(true);
  expect(renamed.message).not.toContain(FORMER_SWITCH);
  expect(onlyFormer.on).toBe(false);
});

test("the environment is never where the key comes from, under either name", () => {
  const path = join(directory(), ENV_FILE);
  const before = { ...process.env };
  process.env[KEY_VARIABLE] = FAKE_KEY;
  process.env[STANDARD] = FAKE_KEY;
  onTestFinished(() => {
    delete process.env[KEY_VARIABLE];
    delete process.env[STANDARD];
    expect(process.env).toEqual(before);
  });

  expect(refusal(path).reason).toBe("missing");
});

test("with no .env file it refuses, and says how to make one", () => {
  const path = join(directory(), ENV_FILE);
  const refused = refusal(path);

  expect(refused.reason).toBe("missing");
  expect(refused.message).toContain(path);
  expect(refused.message).toContain("Copy .env.example");
  expect(refused.message).toContain("chmod 600");
  expect(refused.message).toContain(`${KEY_VARIABLE}=`);
});

test.each([
  ["no line for the key", "SOMETHING_ELSE=1\n"],
  ["the line as the example has it, with no value", `${KEY_VARIABLE}=\n`],
  ["empty quotes", `${KEY_VARIABLE}=""\n`],
  ["the line commented out", `# ${KEY_VARIABLE}=${FAKE_KEY}\n`],
  ["nothing at all", ""],
])("a file with %s is refused as holding no key", (_, content) => {
  const refused = refusal(envWith(content));

  expect(refused.reason).toBe("not-set");
  expect(refused.message).toContain(`${KEY_VARIABLE}=`);
  expect(refused.message).not.toContain(FAKE_KEY);
});

test.each([0o644, 0o640, 0o604, 0o660, 0o606, 0o666, 0o620])(
  "a file with mode %o, which another user can read or write, is refused with the command that fixes it",
  (mode) => {
    const path = writeKey(directory(), { mode });
    const refused = refusal(path);

    expect(refused.reason).toBe("loose-permissions");
    expect(refused.message).toContain(`chmod 600 "${path}"`);
    expect(refused.message).not.toContain(FAKE_KEY);
  },
);

test.each([0o600, 0o400])(
  "a file with mode %o is its owner's alone and is read",
  (mode) => {
    expect(readApiKey(writeKey(directory(), { mode }))).toBe(FAKE_KEY);
  },
);

test("a link to a file is judged by the file it leads to, and a directory is no file", () => {
  const loose = directory();
  symlinkSync(writeKey(directory(), { mode: 0o644 }), join(loose, ENV_FILE));
  const safe = directory();
  symlinkSync(writeKey(directory()), join(safe, ENV_FILE));
  const asDirectory = directory();
  mkdirSync(join(asDirectory, ENV_FILE));

  expect(refusal(join(loose, ENV_FILE)).reason).toBe("loose-permissions");
  expect(readApiKey(join(safe, ENV_FILE))).toBe(FAKE_KEY);
  expect(refusal(join(asDirectory, ENV_FILE)).reason).toBe("not-a-file");
});

test.each([
  ["something that is no key", "hunter2"],
  ["a key of another service", "sk-proj-abcdefghijklmnopqrstuvwxyz012345"],
  ["a placeholder", "your-key-here"],
  ["an Admin key", "sk-ant-admin01-abcdefghijklmnopqrstuvwxyz012345"],
])(
  "a value that is %s is refused, and the refusal does not repeat it",
  (_, value) => {
    const refused = refusal(envWith(`${KEY_VARIABLE}=${value}\n`));

    expect(refused.reason).toBe("not-a-key");
    expect(refused.message).not.toContain(value);
  },
);

test("the key's file is the repo's .env, and a moved data directory has its own", () => {
  const repoRoot = join(import.meta.dirname, "../../..");

  expect(envFilePath({})).toBe(join(repoRoot, ".env"));
  expect(envFilePath({ CURIO_DATA_DIR: "" })).toBe(join(repoRoot, ".env"));
  // A test or a tool that works on another library never finds the owner's key.
  expect(envFilePath({ CURIO_DATA_DIR: "/somewhere/else" })).toBe(
    "/somewhere/else/.env",
  );
  expect(dataDirectory({ CURIO_DATA_DIR: "/somewhere/else" })).toBe(
    "/somewhere/else",
  );
  expect(dataDirectory({})).toBe(join(repoRoot, "data"));
});

test("the standard variable is warned about wherever it is set, and its value is never repeated", () => {
  const clean = writeKey(directory());
  const inFile = envWith(
    `${STANDARD}=${OTHER_KEY}\n${KEY_VARIABLE}=${FAKE_KEY}\n`,
  );

  expect(standardKeyWarning(clean, {})).toBeNull();
  expect(standardKeyWarning(clean, { [STANDARD]: "" })).toBeNull();
  expect(standardKeyWarning(join(directory(), ENV_FILE), {})).toBeNull();
  // This project's own variable in the environment is not what the warning is about.
  expect(standardKeyWarning(clean, { [KEY_VARIABLE]: FAKE_KEY })).toBeNull();

  const fromEnvironment = standardKeyWarning(clean, { [STANDARD]: OTHER_KEY });
  const fromFile = standardKeyWarning(inFile, {});
  const fromBoth = standardKeyWarning(inFile, { [STANDARD]: OTHER_KEY });

  expect(fromEnvironment).toMatch(
    /is set in this environment\. It was not used/,
  );
  expect(fromFile).toContain(`is set in ${inFile}. It was not used`);
  expect(fromBoth).toContain(`in this environment and in ${inFile}`);
  for (const warning of [fromEnvironment, fromFile, fromBoth]) {
    expect(warning).toMatch(/Claude Code does read ANTHROPIC_API_KEY/);
    expect(warning).not.toContain(OTHER_KEY);
    expect(warning).not.toContain(FAKE_KEY);
  }
});
