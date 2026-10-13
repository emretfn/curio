/**
 * The request for one bookmark, and the reading of its answer. One request
 * shape serves both ways of sending it, a message of its own or a line of a
 * batch, so that what the model is asked does not depend on the route.
 */
import { isCategoryId, isFormatId, OTHER_CATEGORY } from "@curio/core";
import type { ClaudeMessage, ClaudeRequest } from "./anthropic.ts";
import { type ClassifierInput, messageOf } from "./input.ts";
import {
  type Asking,
  EFFORT,
  MAX_OUTPUT_TOKENS,
  MODEL,
  outputSchema,
  systemPrompt,
} from "./instructions.ts";
import { bytesOf, type RequestSize, type RequestUsage } from "./pricing.ts";
import type { Transport } from "./transport.ts";

/**
 * The request that classifies one input.
 *
 * The instructions go in the system prompt and the post, as JSON, in the
 * one user message: the two never share a string. There are no tools, so
 * the model can do nothing but answer, and the answer is held to the output
 * schema. Thinking is left to the model, at low effort.
 *
 * A direct request marks the system prompt for the prompt cache, which the
 * requests after the first then read at a tenth of the price. A batch's
 * requests are processed side by side, where a cache write is paid far more
 * often than it is read, so a batch does without.
 */
export function requestFor(
  input: ClassifierInput,
  transport: Transport,
  asking: Asking,
): ClaudeRequest {
  return {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [
      {
        type: "text",
        text: systemPrompt(asking),
        ...(transport === "direct"
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      },
    ],
    messages: [{ role: "user", content: messageOf(input) }],
    output_config: {
      effort: EFFORT,
      format: {
        type: "json_schema",
        schema: outputSchema(asking.vocabulary),
      },
    },
  };
}

/** How large the request for an input is, for the most it can cost and for an estimate of what it will. */
export function sizeOf(
  input: ClassifierInput,
  asking: Asking,
): RequestSize & {
  systemCharacters: number;
  restCharacters: number;
} {
  const system = systemPrompt(asking);
  const message = messageOf(input);
  const schema = JSON.stringify(outputSchema(asking.vocabulary));
  return {
    systemBytes: bytesOf(system),
    restBytes: bytesOf(message) + bytesOf(schema),
    systemCharacters: system.length,
    restCharacters: message.length + schema.length,
  };
}

/** What the model answered for one bookmark, its category and format checked against the taxonomy. */
export interface Answer {
  category: string;
  format: string;
  /**
   * The tags it gave, as it gave them. They are tags of the vocabulary the
   * request was made with; the run reads them against the vocabulary as it
   * stands when the answer arrives, which for a batch can be later.
   */
  tags: string[];
  proposedTags: string[];
  tooLittleText: boolean;
}

export type AnswerFailure = "refused" | "cut-short" | "invalid-output";

export type Reading =
  | { ok: true; answer: Answer }
  | { ok: false; reason: AnswerFailure };

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Reads a message as an answer. The schema already holds the model to the
 * taxonomy; this checks the category and the format all the same, so that
 * nothing reaches the library on the strength of a promise alone, and it is
 * what stands between the library and a message that was refused or cut
 * short, which need not match the schema at all. The tags are checked where
 * they are stored, against the vocabulary: `tagsOf` in `run.ts` keeps those
 * it holds and drops the rest.
 *
 * The content is read by the type of each block: a message can open with
 * thinking. A post with too little text is filed under "other" with no
 * tags, whatever else the answer says.
 */
export function readAnswer(message: ClaudeMessage): Reading {
  if (message.stop_reason === "refusal")
    return { ok: false, reason: "refused" };
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
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "invalid-output" };
  }
  const { too_little_text, category, format, tags, proposed_tags } =
    value as Record<string, unknown>;
  if (
    typeof too_little_text !== "boolean" ||
    typeof category !== "string" ||
    !isCategoryId(category) ||
    typeof format !== "string" ||
    !isFormatId(format) ||
    !isStrings(tags) ||
    !isStrings(proposed_tags)
  ) {
    return { ok: false, reason: "invalid-output" };
  }
  return {
    ok: true,
    answer: {
      category: too_little_text ? OTHER_CATEGORY : category,
      format,
      tags: too_little_text ? [] : [...new Set(tags)],
      // Sanitised and capped where they are stored: `recordClassification`.
      proposedTags: too_little_text ? [] : proposed_tags,
      tooLittleText: too_little_text,
    },
  };
}

/** The tokens a message reports having used. */
export function usageOf(message: ClaudeMessage): RequestUsage {
  const { usage } = message;
  const written = usage.cache_creation_input_tokens ?? 0;
  const written1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens,
    cacheWrite5mTokens: Math.max(0, written - written1h),
    cacheWrite1hTokens: written1h,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}
