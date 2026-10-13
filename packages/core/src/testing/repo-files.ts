/**
 * The repo's own files, for the checks that read source to hold a rule:
 * which files name a host X owns, which one file calls Claude, which one
 * reads the key.
 *
 * Such a check is only as good as its answer to "which files are the
 * repo's". A checkout holds a great deal that is not: dependencies, build
 * output, the owner's library, a tool's settings for this computer, another
 * checkout placed inside this one. Git already holds that answer, in the
 * `.gitignore` at the repo's root, so it is read from there and written
 * nowhere else: a file is the repo's when git would take it. That is every
 * tracked file and every new one not yet added, which a check has to see
 * before it is committed and not after.
 *
 * It is read without running git. Core starts no process (X-5), and the
 * answer has to be the same on every computer: what one person's own git
 * settings ignore beyond the repo's file is not part of it. A file that is
 * local and must stay out of these checks therefore has a line in
 * `.gitignore`, where everyone gets it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The root of this checkout. */
export const repoRoot = join(import.meta.dirname, "../../../..");

interface IgnoreRule {
  /** A line that begins with `!`: what it matches is taken back in. */
  negated: boolean;
  /** A line that ends with `/`: it matches directories alone. */
  directoryOnly: boolean;
  /** A line with a `/` before its end: matched against the path from the root, not against a name at any depth. */
  anchored: boolean;
  pattern: RegExp;
}

/**
 * One line of a `.gitignore`, as git reads it. It has the cases this repo's
 * file uses: a name or a path, `*` and `?` within one name, a leading `/`,
 * a trailing `/`, and `!`. A line that needs more (`**`, a character class,
 * an escape) is refused, so that a pattern this cannot read is never taken
 * for one that matches nothing.
 */
function ruleOf(line: string): IgnoreRule | undefined {
  const written = line.trim();
  if (written === "" || written.startsWith("#")) return undefined;
  const negated = written.startsWith("!");
  const directoryOnly = written.endsWith("/");
  const body = written.slice(negated ? 1 : 0, directoryOnly ? -1 : undefined);
  const path = body.startsWith("/") ? body.slice(1) : body;
  if (path === "" || /\*\*|[[\]\\]/.test(path) || path.endsWith("/")) {
    throw new Error(
      `The .gitignore line "${written}" uses a form repo-files.ts has no case for. Add the case there, with a test, or write the line more plainly.`,
    );
  }
  const source = path
    .replace(/[.+^${}()|]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return {
    negated,
    directoryOnly,
    anchored: body.includes("/"),
    pattern: new RegExp(`^${source}$`),
  };
}

/** Whether git would ignore this entry: the last line that matches it decides. */
function ignored(
  rules: readonly IgnoreRule[],
  path: string,
  name: string,
  isDirectory: boolean,
): boolean {
  const last = rules.findLast(
    (rule) =>
      (isDirectory || !rule.directoryOnly) &&
      rule.pattern.test(rule.anchored ? path : name),
  );
  return last !== undefined && !last.negated;
}

/**
 * Every file under `root` that is the repo's, as a path from the root with
 * `/` between its parts, in order. Left out: what the root's `.gitignore`
 * ignores; git's own directory; and a directory that is a checkout of its
 * own, such as a linked worktree, whose own run of a check reads it.
 *
 * A `.gitignore` below the root is refused, because git would read it and
 * this does not.
 */
export function repoFiles(root: string = repoRoot): string[] {
  const rules = readFileSync(join(root, ".gitignore"), "utf8")
    .split(/\r?\n/)
    .flatMap((line) => ruleOf(line) ?? []);

  function under(directory: string, prefix: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = `${prefix}${entry.name}`;
      const onDisk = join(directory, entry.name);
      if (entry.name === ".git") return [];
      if (entry.isDirectory()) {
        return ignored(rules, path, entry.name, true) ||
          existsSync(join(onDisk, ".git"))
          ? []
          : under(onDisk, `${path}/`);
      }
      if (!entry.isFile() || ignored(rules, path, entry.name, false)) return [];
      if (entry.name === ".gitignore" && prefix !== "") {
        throw new Error(
          `${path} is a .gitignore below the root. repo-files.ts reads the root's alone: move its lines there, as paths from the root.`,
        );
      }
      return [path];
    });
  }
  return under(root, "").toSorted();
}

/**
 * Files of the repo that no check reads as source, each a path from the
 * root, and why. A directory ends with `/`.
 */
export const NOT_SOURCE: Readonly<Record<string, string>> = {
  "docs/":
    "Prose and the README's images. The research notes cite X's own pages, and nothing runs them.",
  "packages/core/src/parsers/fixtures/":
    "Redacted responses: data that names X's media hosts, with invented paths.",
  "pnpm-lock.yaml": "Written by pnpm. It lists what was installed.",
};

/**
 * The repo's source files whose path matches `pattern`: `repoFiles` without
 * what `NOT_SOURCE` names. Every check that reads the repo's source starts
 * here, so that no two of them disagree about which files those are.
 */
export function repoSourceFiles(
  pattern: RegExp,
  root: string = repoRoot,
): string[] {
  const left = Object.keys(NOT_SOURCE);
  return repoFiles(root).filter(
    (path) =>
      pattern.test(path) &&
      !left.some((not) =>
        not.endsWith("/") ? path.startsWith(not) : path === not,
      ),
  );
}
