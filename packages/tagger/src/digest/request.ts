/**
 * The one request that writes a week's digest, and the reading of its
 * answer.
 */
import { DIGEST_LIMITS, type DigestText } from "@curio/core";
import type { ClaudeMessage, ClaudeRequest } from "../anthropic.ts";
import { bytesOf, type RequestSize } from "../pricing.ts";
import { type DigestInput, digestMessageOf } from "./input.ts";
import {
  DIGEST_EFFORT,
  DIGEST_MAX_OUTPUT_TOKENS,
  DIGEST_MODEL,
  digestOutputSchema,
  digestSystemPrompt,
} from "./instructions.ts";

/**
 * The request for a week.
 *
 * The instructions go in the system prompt and the posts, as JSON, in the
 * one user message: the two never share a string. There are no tools, so
 * the model can do nothing but answer, and the answer is held to the output
 * schema, in which a post can only be one of this request's numbers. The
 * model always thinks; how much is its effort. Nothing is cached: there is
 * one request a week.
 */
export function digestRequestFor(input: DigestInput): ClaudeRequest {
  return {
    model: DIGEST_MODEL,
    max_tokens: DIGEST_MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: digestSystemPrompt() }],
    messages: [{ role: "user", content: digestMessageOf(input) }],
    output_config: {
      effort: DIGEST_EFFORT,
      format: {
        type: "json_schema",
        schema: digestOutputSchema(input.posts.length),
      },
    },
  };
}

/** How large the request for a week is, in bytes for the most it can cost and in characters for an estimate. */
export function digestSizeOf(
  input: DigestInput,
): RequestSize & { characters: number } {
  const system = digestSystemPrompt();
  const message = digestMessageOf(input);
  const schema = JSON.stringify(digestOutputSchema(input.posts.length));
  return {
    systemBytes: bytesOf(system),
    restBytes: bytesOf(message) + bytesOf(schema),
    characters: system.length + message.length + schema.length,
  };
}

export type DigestFailure = "refused" | "cut-short" | "invalid-output";

export type DigestReading =
  | { ok: true; text: DigestText }
  | { ok: false; reason: DigestFailure };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const said = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Reads a message as a digest. `postIds` are the bookmarks that were sent,
 * in the order the request numbered them: a number in the answer becomes a
 * post id through that list and through nothing else, and a number that is
 * not one of the request's is dropped. So whatever the posts said, the
 * digest can only point at bookmarks of this week that were sent.
 *
 * The schema already holds the model to this shape; it is checked all the
 * same, and it is what stands between the library and a message that was
 * refused or cut short, which need not match the schema at all. A theme or
 * a reason with nothing said in it is left out; a digest with no overview
 * is no digest. What the strings may hold is settled where they are stored:
 * `finishDigestRun` in core.
 */
export function readDigest(
  message: ClaudeMessage,
  postIds: readonly string[],
): DigestReading {
  if (message.stop_reason === "refusal") {
    return { ok: false, reason: "refused" };
  }
  if (message.stop_reason === "max_tokens") {
    return { ok: false, reason: "cut-short" };
  }
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid-output" };
  }
  if (
    !isRecord(value) ||
    !said(value.overview) ||
    !Array.isArray(value.themes) ||
    !Array.isArray(value.worth_revisiting)
  ) {
    return { ok: false, reason: "invalid-output" };
  }
  const postOf = (number: unknown): string | undefined =>
    typeof number === "number" && Number.isInteger(number)
      ? postIds[number - 1]
      : undefined;
  const themes: DigestText["themes"] = [];
  for (const theme of value.themes as unknown[]) {
    if (!isRecord(theme) || !Array.isArray(theme.posts)) {
      return { ok: false, reason: "invalid-output" };
    }
    if (!said(theme.title) || !said(theme.summary)) continue;
    themes.push({
      title: theme.title,
      summary: theme.summary,
      postIds: (theme.posts as unknown[]).flatMap((number) => {
        const postId = postOf(number);
        return postId === undefined ? [] : [postId];
      }),
    });
  }
  const worthRevisiting: DigestText["worthRevisiting"] = [];
  for (const entry of value.worth_revisiting as unknown[]) {
    if (!isRecord(entry)) return { ok: false, reason: "invalid-output" };
    const postId = postOf(entry.post);
    if (postId === undefined || !said(entry.why)) continue;
    worthRevisiting.push({ postId, why: entry.why });
  }
  return {
    ok: true,
    text: {
      overview: value.overview,
      themes: themes.slice(0, DIGEST_LIMITS.themes),
      worthRevisiting: worthRevisiting.slice(0, DIGEST_LIMITS.worthRevisiting),
    },
  };
}
