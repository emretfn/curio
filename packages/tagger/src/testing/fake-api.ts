/**
 * A fake of the Claude API at the HTTP boundary: a function with the shape
 * of `fetch` that answers the requests the Anthropic SDK makes, with no
 * network behind it. The classifier's own client is built over it in the
 * tests, so what they exercise is the real client, the real request and the
 * real reading of the answer; only the far side of the wire is invented.
 *
 * It is strict where the real API is: a request the API would reject gets
 * the same status here, so a test passes only if the request is one the
 * API accepts. What it knows of the API was read from Anthropic's
 * documentation on 2026-10-13; it is not the API, and the first real run
 * is the test this cannot be.
 */
import type { ClassifierInput } from "../input.ts";

export const FAKE_KEY = "sk-ant-api03-FAKE0not0a0real0key0000000000000000";

const ORIGIN = "https://api.anthropic.com";
const MODELS = new Set(["claude-haiku-5-5"]);
/** Every top-level field of a Messages request this fake has a rule for. Another is a 400, as an unknown field is. */
const REQUEST_FIELDS = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "output_config",
  "thinking",
  "stream",
  "metadata",
]);
/** JSON Schema keywords structured outputs accept. Any other is a 400. */
const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "anyOf",
  "minItems",
]);

/** What the model "says" about a post. */
export interface FakeAnswer {
  too_little_text: boolean;
  category: string;
  format: string;
  tags: string[];
  proposed_tags: string[];
}

/** How the fake answers one request: an answer, or one of the ways a request comes to nothing. */
export type FakeReply =
  | FakeAnswer
  | { refuse: true }
  | { cutShort: true }
  /** Text in place of the JSON, as only a refused or cut-short message could really hold. */
  | { text: string }
  /** An HTTP error for this request, with the API's name for it. */
  | { status: number; type: string };

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MessageBody {
  model: string;
  max_tokens: number;
  system?: { type: string; text: string; cache_control?: unknown }[] | string;
  messages: { role: string; content: unknown }[];
  output_config?: {
    effort?: string;
    format?: { type: string; schema: Record<string, unknown> };
  };
  [key: string]: unknown;
}

interface Batch {
  id: string;
  requests: { custom_id: string; params: MessageBody }[];
  polls: number;
  /** The results, once worked out: asking twice asks the model once. */
  lines?: string[];
}

export interface FakeApiOptions {
  /** What the model says of each post. Given the post as the classifier sent it, and how many it has seen. */
  reply?: (input: ClassifierInput, index: number) => FakeReply;
  /**
   * Throw as an unreachable network does, in place of answering: always, or
   * for the attempts it picks, counted from zero in the order they are made.
   */
  unreachable?: boolean | ((attempt: number) => boolean);
  /** How many times a batch says it is still in progress before it has ended. */
  batchPolls?: number;
  /** How a batch's requests end, by position, in place of being answered. */
  batchResult?: (
    index: number,
  ) => "expired" | "canceled" | "api-error" | undefined;
  /** Where a batch says its results are, in place of the true address. */
  resultsUrl?: (batchId: string) => string;
}

export const DEFAULT_ANSWER: FakeAnswer = {
  too_little_text: false,
  category: "web-dev",
  format: "guide",
  tags: ["react"],
  proposed_tags: [],
};

/** Tokens of a text, as this fake counts them: three characters each. */
const tokens = (text: string) => Math.ceil(text.length / 3);

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "request-id": "req_fake",
      ...headers,
    },
  });

const error = (status: number, type: string, message: string) =>
  json(
    status,
    { type: "error", error: { type, message }, request_id: "req_fake" },
    // Tried again at once, so that a test of the retries does not wait.
    status === 429 || status >= 500 ? { "retry-after-ms": "1" } : {},
  );

const invalid = (message: string) =>
  error(400, "invalid_request_error", message);

/** The first reason the API would reject this schema, or null. */
function schemaProblem(schema: unknown, path = "schema"): string | null {
  if (typeof schema !== "object" || schema === null)
    return `${path} is not an object`;
  const node = schema as Record<string, unknown>;
  for (const keyword of Object.keys(node)) {
    if (!SCHEMA_KEYWORDS.has(keyword))
      return `${path}.${keyword} is not supported`;
  }
  if (node.type === "object") {
    if (node.additionalProperties !== false) {
      return `${path}: additionalProperties must be false`;
    }
    for (const [name, child] of Object.entries(
      (node.properties ?? {}) as Record<string, unknown>,
    )) {
      const problem = schemaProblem(child, `${path}.properties.${name}`);
      if (problem !== null) return problem;
    }
  }
  if (node.type === "array") return schemaProblem(node.items, `${path}.items`);
  if (
    node.minItems !== undefined &&
    node.minItems !== 0 &&
    node.minItems !== 1
  ) {
    return `${path}.minItems may only be 0 or 1`;
  }
  return null;
}

/** The first reason the API would reject this request, as its answer, or null. */
function problemWith(body: MessageBody, inBatch: boolean): Response | null {
  for (const field of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(field))
      return invalid(`${field}: Extra inputs are not permitted`);
  }
  if (!MODELS.has(body.model))
    return error(404, "not_found_error", `model: ${body.model}`);
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    return invalid("max_tokens: must be at least 1");
  }
  if (inBatch && body.stream === true)
    return invalid("stream: not supported in a batch");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return invalid("messages: at least one message is required");
  }
  if (body.messages.at(-1)?.role !== "user") {
    return invalid("This model does not support assistant message prefill.");
  }
  if (body.thinking !== undefined) {
    const thinking = body.thinking as { type?: string; budget_tokens?: number };
    if (thinking.budget_tokens !== undefined || thinking.type === "enabled") {
      return invalid("thinking: budget_tokens is not supported for this model");
    }
  }
  const effort = body.output_config?.effort;
  if (
    effort !== undefined &&
    !["low", "medium", "high", "xhigh", "max"].includes(effort)
  ) {
    return invalid("output_config.effort: unknown level");
  }
  const format = body.output_config?.format;
  if (format !== undefined) {
    if (format.type !== "json_schema")
      return invalid("output_config.format.type");
    const problem = schemaProblem(format.schema);
    if (problem !== null) return invalid(problem);
  }
  return null;
}

/** Whether a value is one the schema allows: what constrained decoding guarantees of a real answer. */
function conforms(value: unknown, schema: Record<string, unknown>): boolean {
  if (schema.enum !== undefined)
    return (schema.enum as unknown[]).includes(value);
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "array":
      return (
        Array.isArray(value) &&
        value.every((item) =>
          conforms(item, schema.items as Record<string, unknown>),
        )
      );
    case "object": {
      if (typeof value !== "object" || value === null) return false;
      const properties = schema.properties as Record<
        string,
        Record<string, unknown>
      >;
      const keys = Object.keys(value);
      return (
        (schema.required as string[]).every((key) => keys.includes(key)) &&
        keys.every(
          (key) =>
            properties[key] !== undefined &&
            conforms((value as Record<string, unknown>)[key], properties[key]),
        )
      );
    }
    default:
      return false;
  }
}

export interface FakeApi {
  /** The function to build the client over. */
  send: typeof globalThis.fetch;
  /** Every request made, in order, with its headers and its body as parsed JSON. */
  sent: SentRequest[];
  /** The posts the model was asked about, as the classifier sent them, in order. */
  inputs: ClassifierInput[];
  /** The bodies of the Messages requests, direct and batched alike, in order. */
  messageRequests: MessageBody[];
  options: FakeApiOptions;
}

/** A fake of the Claude API that accepts `FAKE_KEY`. */
export function fakeApi(options: FakeApiOptions = {}): FakeApi {
  const api: FakeApi = {
    send: (input, init) => answer(input, init),
    sent: [],
    inputs: [],
    messageRequests: [],
    options,
  };
  const batches = new Map<string, Batch>();
  /** System prompts written to the cache so far. */
  const cached = new Set<string>();

  /** The model's message for one request, or the API's error for it. */
  function message(body: MessageBody, inBatch: boolean): Response {
    const problem = problemWith(body, inBatch);
    if (problem !== null) return problem;
    const content = body.messages[0]?.content;
    const input = JSON.parse(
      typeof content === "string" ? content : "{}",
    ) as ClassifierInput;
    const index = api.inputs.length;
    api.inputs.push(input);
    api.messageRequests.push(body);
    const reply = (api.options.reply ?? (() => DEFAULT_ANSWER))(input, index);
    if ("status" in reply)
      return error(reply.status, reply.type, "The request failed.");

    const system = Array.isArray(body.system) ? body.system : [];
    const systemText = system.map(({ text }) => text).join("");
    const caches = system.some((block) => block.cache_control !== undefined);
    const read = caches && cached.has(systemText);
    if (caches) cached.add(systemText);
    const systemTokens = tokens(systemText);
    const schema = body.output_config?.format?.schema;

    let text: string;
    let stopReason = "end_turn";
    if ("refuse" in reply) {
      text = "I can't help with that.";
      stopReason = "refusal";
    } else if ("cutShort" in reply) {
      text = '{"too_little_text": false, "category": "web';
      stopReason = "max_tokens";
    } else if ("text" in reply) {
      text = reply.text;
    } else {
      if (schema !== undefined && !conforms(reply, schema)) {
        throw new Error(
          "The fake API was told to give an answer the output schema does not allow, which the real API cannot give.",
        );
      }
      text = JSON.stringify(reply);
    }
    return json(200, {
      id: `msg_fake${index}`,
      type: "message",
      role: "assistant",
      model: body.model,
      // The model thinks first: the answer is not the first block.
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text },
      ],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens:
          tokens(typeof content === "string" ? content : "") +
          (caches ? 0 : systemTokens),
        cache_creation_input_tokens: caches && !read ? systemTokens : 0,
        cache_read_input_tokens: read ? systemTokens : 0,
        cache_creation: {
          ephemeral_5m_input_tokens: caches && !read ? systemTokens : 0,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: 40 + tokens(text),
        service_tier: inBatch ? "batch" : "standard",
      },
    });
  }

  function batchOf(batch: Batch, ended: boolean) {
    return {
      id: batch.id,
      type: "message_batch",
      processing_status: ended ? "ended" : "in_progress",
      request_counts: {
        processing: ended ? 0 : batch.requests.length,
        succeeded: ended ? batch.requests.length : 0,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
      created_at: "2026-10-13T00:00:00Z",
      expires_at: "2026-10-14T00:00:00Z",
      ended_at: ended ? "2026-10-13T00:30:00Z" : null,
      archived_at: null,
      cancel_initiated_at: null,
      results_url: ended
        ? (api.options.resultsUrl?.(batch.id) ??
          `${ORIGIN}/v1/messages/batches/${batch.id}/results`)
        : null,
    };
  }

  async function results(batch: Batch): Promise<Response> {
    batch.lines ??= await answersOf(batch);
    // Results come back in no particular order.
    return new Response(`${batch.lines.toReversed().join("\n")}\n`, {
      status: 200,
      headers: { "content-type": "application/x-jsonl" },
    });
  }

  async function answersOf(batch: Batch): Promise<string[]> {
    const lines: string[] = [];
    for (const [index, { custom_id, params }] of batch.requests.entries()) {
      const ending = api.options.batchResult?.(index);
      if (ending === "expired" || ending === "canceled") {
        lines.push(JSON.stringify({ custom_id, result: { type: ending } }));
        continue;
      }
      const response =
        ending === "api-error"
          ? error(500, "api_error", "Internal server error")
          : message(params, true);
      const body: unknown = await response.json();
      lines.push(
        JSON.stringify({
          custom_id,
          result: response.ok
            ? { type: "succeeded", message: body }
            : { type: "errored", error: body },
        }),
      );
    }
    return lines;
  }

  async function answer(
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const body: unknown = text === "" ? null : JSON.parse(text);
    api.sent.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body,
    });
    const { unreachable } = api.options;
    if (
      typeof unreachable === "function"
        ? unreachable(api.sent.length - 1)
        : unreachable === true
    ) {
      throw new TypeError("fetch failed");
    }
    if (url.origin !== ORIGIN) {
      throw new Error(`The fake API was asked for another host: ${url.host}`);
    }
    if (init?.redirect !== "error") {
      throw new Error("A request was made that would follow a redirect.");
    }
    if (request.headers.get("x-api-key") !== FAKE_KEY) {
      return error(401, "authentication_error", "invalid x-api-key");
    }
    if (request.headers.get("anthropic-version") === null) {
      return invalid("anthropic-version: header is required");
    }

    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /v1/messages")
      return message(body as MessageBody, false);
    if (route === "POST /v1/messages/batches") {
      const { requests } = body as { requests: Batch["requests"] };
      const ids = requests.map(({ custom_id }) => custom_id);
      if (
        new Set(ids).size !== ids.length ||
        !ids.every((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id))
      ) {
        return invalid(
          "requests: custom_id must be unique and match ^[a-zA-Z0-9_-]{1,64}$",
        );
      }
      const batch = {
        id: `msgbatch_fake${batches.size + 1}`,
        requests,
        polls: 0,
      };
      batches.set(batch.id, batch);
      return json(200, batchOf(batch, false));
    }
    const [, id, tail] =
      /^\/v1\/messages\/batches\/([^/]+)(\/results)?$/.exec(url.pathname) ?? [];
    const batch = id === undefined ? undefined : batches.get(id);
    if (request.method === "GET" && batch !== undefined) {
      if (tail !== undefined) return results(batch);
      batch.polls += 1;
      return json(
        200,
        batchOf(batch, batch.polls > (api.options.batchPolls ?? 0)),
      );
    }
    return error(404, "not_found_error", "Not found");
  }

  return api;
}
