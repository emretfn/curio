import { expect, test } from "vitest";
import type { ClaudeMessage } from "./anthropic.ts";
import {
  MAX_OUTPUT_TOKENS,
  MODEL,
  outputSchema,
  systemPrompt,
} from "./instructions.ts";
import { readAnswer, requestFor, sizeOf, usageOf } from "./request.ts";
import { SAMPLE_ASKING } from "./testing/asking.ts";

test("a request is the instructions, one message holding the post, and the schema, with nothing else switched on", () => {
  expect(
    requestFor({ text: "a post", language: "en" }, "direct", SAMPLE_ASKING),
  ).toEqual({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [
      {
        type: "text",
        text: systemPrompt(SAMPLE_ASKING),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: '{"text":"a post","language":"en"}' }],
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: outputSchema(SAMPLE_ASKING.vocabulary),
      },
    },
  });
});

test("a batched request asks the same of the model, without the cache mark", () => {
  const direct = requestFor({ text: "a post" }, "direct", SAMPLE_ASKING);
  const batched = requestFor({ text: "a post" }, "batch", SAMPLE_ASKING);

  expect(batched.system).toEqual([
    { type: "text", text: systemPrompt(SAMPLE_ASKING) },
  ]);
  expect({ ...batched, system: null }).toEqual({ ...direct, system: null });
});

test("a request has no tools, no sampling settings and no way to stream", () => {
  expect(
    Object.keys(requestFor({ text: "" }, "direct", SAMPLE_ASKING)).toSorted(),
  ).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
});

/** A message as the API returns one, holding `text` after a thinking block. */
function message(
  text: string,
  parts: Partial<ClaudeMessage> = {},
): ClaudeMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text, citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 80,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2000,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
    ...parts,
  } as ClaudeMessage;
}

const answer = (parts: Record<string, unknown> = {}) =>
  JSON.stringify({
    too_little_text: false,
    category: "web-dev",
    format: "guide",
    tags: ["react", "nextjs"],
    proposed_tags: ["server-actions"],
    ...parts,
  });

test("an answer is read from the text block, wherever it sits among the blocks", () => {
  expect(readAnswer(message(answer()))).toEqual({
    ok: true,
    answer: {
      category: "web-dev",
      format: "guide",
      tags: ["react", "nextjs"],
      proposedTags: ["server-actions"],
      tooLittleText: false,
    },
  });
});

test("too little text is other with no tags, whatever else the answer says", () => {
  expect(
    readAnswer(message(answer({ too_little_text: true, format: "showcase" }))),
  ).toEqual({
    ok: true,
    answer: {
      category: "other",
      format: "showcase",
      tags: [],
      proposedTags: [],
      tooLittleText: true,
    },
  });
});

test("tags given twice count once, and are passed on as given, to be read against the vocabulary where they are stored", () => {
  const reading = readAnswer(
    message(answer({ tags: ["react", "react", "a-tag-since-renamed"] })),
  );

  expect(reading.ok && reading.answer.tags).toEqual([
    "react",
    "a-tag-since-renamed",
  ]);
});

test("a refused message and one cut short are failures, read before their content", () => {
  expect(
    readAnswer(message("I can't help with that.", { stop_reason: "refusal" })),
  ).toEqual({ ok: false, reason: "refused" });
  expect(
    readAnswer(
      message('{"too_little_text": fal', { stop_reason: "max_tokens" }),
    ),
  ).toEqual({ ok: false, reason: "cut-short" });
  // Even one whose content happens to be a whole answer.
  expect(readAnswer(message(answer(), { stop_reason: "refusal" }))).toEqual({
    ok: false,
    reason: "refused",
  });
});

test.each([
  ["no JSON at all", "Here is my answer: web-dev"],
  ["JSON that is no object", "[]"],
  ["a category outside the taxonomy", answer({ category: "cooking" })],
  ["a format outside the taxonomy", answer({ format: "thread" })],
  ["tags that are no list", answer({ tags: "react" })],
  ["a tag that is no text", answer({ tags: [1] })],
  ["a missing judgement of the text", answer({ too_little_text: undefined })],
  ["proposals that are no list of text", answer({ proposed_tags: [{}] })],
  ["an empty message", ""],
])("an answer with %s is invalid, and nothing of it is used", (_, text) => {
  expect(readAnswer(message(text))).toEqual({
    ok: false,
    reason: "invalid-output",
  });
});

test("usage is read with the two kinds of cache write apart", () => {
  expect(usageOf(message("{}"))).toEqual({
    inputTokens: 120,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 2000,
    outputTokens: 80,
  });
  expect(
    usageOf(
      message("{}", {
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: null,
          cache_creation: {
            ephemeral_5m_input_tokens: 300,
            ephemeral_1h_input_tokens: 200,
          },
        },
      } as Partial<ClaudeMessage>),
    ),
  ).toEqual({
    inputTokens: 10,
    cacheWrite5mTokens: 300,
    cacheWrite1hTokens: 200,
    cacheReadTokens: 0,
    outputTokens: 20,
  });
});

test("a request's size counts the instructions once, and the post and the schema beside them", () => {
  const small = sizeOf({ text: "a" }, SAMPLE_ASKING);
  const large = sizeOf({ text: "ışık ".repeat(100) }, SAMPLE_ASKING);

  expect(small.systemBytes).toBe(
    Buffer.byteLength(systemPrompt(SAMPLE_ASKING)),
  );
  expect(large.systemBytes).toBe(small.systemBytes);
  // Bytes, not characters: three of the five characters repeated are two bytes each.
  expect(large.restBytes - small.restBytes).toBe(799);
  expect(large.restCharacters - small.restCharacters).toBe(499);
});
