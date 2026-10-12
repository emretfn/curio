/**
 * Reading an untrusted response by its shape. Every read names the path it
 * took, so that a response X has changed fails at the exact field, with what
 * was expected and what was there instead.
 *
 * A `ShapeIssue` describes structure only: paths, field names and type names.
 * It never carries a value from the response, so issues can be stored, shown
 * and pasted into a bug report without exposing a bookmark.
 */

/** Why a response, or one part of it, was not understood. */
export interface ShapeIssue {
  /** What kind of mismatch this is. One of `ISSUE_CODES`. */
  code: IssueCode;
  /** Where in the payload understanding stopped, as a JSON path from `$`. */
  path: string;
  /** What was expected there and what was found, by type and field name. */
  detail: string;
}

export const ISSUE_CODES = [
  /** The payload is not JSON at all. */
  "not-json",
  /** A field the parser needs is absent. */
  "missing-field",
  /** A field holds another type than expected. */
  "wrong-type",
  /** A type name or enumerated value the parser has no case for. */
  "unknown-variant",
  /** A value of the right type that cannot be what it should be. */
  "invalid-value",
  /** A known shape whose content no parser handles yet. */
  "unsupported-content",
  /** The parser threw something other than a shape mismatch: a bug in it. */
  "parser-crashed",
  /** A parsed bookmark that the database refused. */
  "not-storable",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

/** Thrown by the readers below. Caught by the parser at the entry or capture it belongs to. */
export class ShapeError extends Error {
  readonly issue: ShapeIssue;

  constructor(issue: ShapeIssue) {
    super(`${issue.code} at ${issue.path}: ${issue.detail}`);
    this.name = "ShapeError";
    this.issue = issue;
  }
}

/** A value inside a payload, with the path that leads to it. */
export interface Node {
  readonly value: unknown;
  readonly path: string;
}

export function rootNode(value: unknown): Node {
  return { value, path: "$" };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The field names of an object, for a diagnosis: when X renames a field, the
 * new name is usually sitting beside where the old one was. Names that could
 * be data (long digit runs, odd characters) are left out.
 */
function fieldNames(value: Record<string, unknown>): string {
  const names = Object.keys(value).filter(
    (name) => /^[A-Za-z_][A-Za-z0-9_]{0,48}$/.test(name) && !/\d{5}/.test(name),
  );
  return names.length === 0
    ? "no fields"
    : `fields: ${names.slice(0, 30).join(", ")}`;
}

function mismatch(node: Node, expected: string): ShapeError {
  return new ShapeError({
    code: node.value === undefined ? "missing-field" : "wrong-type",
    path: node.path,
    detail: `expected ${expected}, found ${typeOf(node.value)}`,
  });
}

/** The node as an object, or a shape error. */
export function record(node: Node): Record<string, unknown> {
  if (!isRecord(node.value)) throw mismatch(node, "object");
  return node.value;
}

/** A field of an object node. The field may be absent: the reader applied to it decides. */
export function field(node: Node, name: string): Node {
  return { value: record(node)[name], path: `${node.path}.${name}` };
}

/** A field that must be present, whatever it holds. Names the sibling fields when it is not. */
export function required(node: Node, name: string): Node {
  const parent = record(node);
  if (parent[name] === undefined) {
    throw new ShapeError({
      code: "missing-field",
      path: `${node.path}.${name}`,
      detail: `the field is absent; its parent has ${fieldNames(parent)}`,
    });
  }
  return { value: parent[name], path: `${node.path}.${name}` };
}

/** Follows several required fields in a row. */
export function descend(node: Node, ...names: string[]): Node {
  return names.reduce(required, node);
}

export function isAbsent(node: Node): boolean {
  return node.value === undefined || node.value === null;
}

export function text(node: Node): string {
  if (typeof node.value !== "string") throw mismatch(node, "string");
  return node.value;
}

export function boolean(node: Node): boolean {
  if (typeof node.value !== "boolean") throw mismatch(node, "boolean");
  return node.value;
}

/** A whole number that JavaScript holds exactly, zero or above. */
export function count(node: Node): number {
  if (typeof node.value !== "number") throw mismatch(node, "number");
  if (!Number.isSafeInteger(node.value) || node.value < 0) {
    throw invalid(node, "a whole number, zero or above");
  }
  return node.value;
}

/** The items of an array node, each with its own path. */
export function items(node: Node): Node[] {
  if (!Array.isArray(node.value)) throw mismatch(node, "array");
  return node.value.map((value, index) => ({
    value,
    path: `${node.path}[${index}]`,
  }));
}

/** An X id: decimal digits in a string. Never read from a JSON number, which loses digits. */
export function id(node: Node): string {
  const value = text(node);
  if (!/^[0-9]+$/.test(value)) throw invalid(node, "a string of digits");
  return value;
}

/** A value of the right type that is not a legal one. Says what was wanted, not what was there. */
export function invalid(node: Node, expected: string): ShapeError {
  return new ShapeError({
    code: "invalid-value",
    path: node.path,
    detail: `expected ${expected}`,
  });
}

/**
 * A type name or other enumerated value the parser has no case for. The value
 * is named when it looks like one of X's identifiers, which are schema and
 * not content.
 */
export function unknownVariant(node: Node, known: readonly string[]): never {
  const found =
    typeof node.value === "string" && /^[A-Za-z0-9_:]{1,64}$/.test(node.value)
      ? `"${node.value.replace(/\d{5,}/g, "#")}"`
      : typeOf(node.value);
  throw new ShapeError({
    code: node.value === undefined ? "missing-field" : "unknown-variant",
    path: node.path,
    detail: `expected one of ${known.join(", ")}; found ${found}`,
  });
}

/**
 * Runs a reader and returns the issue instead of throwing when the shape does
 * not match. Anything else that is thrown is a bug and keeps propagating.
 */
export function attempt<T>(
  read: () => T,
): { ok: true; value: T } | { ok: false; issue: ShapeIssue } {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof ShapeError) return { ok: false, issue: error.issue };
    throw error;
  }
}
