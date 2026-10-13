/**
 * What a request costs. The prices are the published ones for the model in
 * `instructions.ts`, in US dollars per million tokens, read from Anthropic's
 * pricing page on 2026-10-13. They are the one place a price is written;
 * when the model or its price changes, change them here.
 *
 * Everything worked out from them is this program's own arithmetic on the
 * token counts the API reports. The invoice is the authority.
 */
import type { TokenUsage } from "@x-bookmarks/core";
import { MAX_OUTPUT_TOKENS, MODEL } from "./instructions.ts";
import type { Transport } from "./transport.ts";

interface Prices {
  /** Input tokens, for a prompt of up to `longPromptTokens`. */
  input: number;
  output: number;
  /** A prompt longer than this is charged on a higher card. Nothing here comes near it. */
  longPromptTokens: number;
  /** Multipliers on the input price. */
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** The Message Batches API charges this share of every price. */
  batch: number;
}

const PRICES: Record<string, Prices> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    longPromptTokens: 100_000,
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    batch: 0.5,
  },
};

function pricesOf(model: string): Prices {
  const prices = PRICES[model];
  if (prices === undefined) {
    throw new Error(
      `There is no price for the model ${model}. Add it to pricing.ts before running it: the spend cap is worked out from the price.`,
    );
  }
  return prices;
}

const MILLION = 1_000_000;

/** Tokens as the API reports them for one request, with the two kinds of cache write apart. */
export interface RequestUsage {
  inputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** What one request cost, in US dollars. */
export function costOf(
  usage: RequestUsage,
  transport: Transport,
  model: string = MODEL,
): number {
  const prices = pricesOf(model);
  const inputEquivalent =
    usage.inputTokens +
    usage.cacheWrite5mTokens * prices.cacheWrite5m +
    usage.cacheWrite1hTokens * prices.cacheWrite1h +
    usage.cacheReadTokens * prices.cacheRead;
  return (
    ((inputEquivalent * prices.input + usage.outputTokens * prices.output) /
      MILLION) *
    (transport === "batch" ? prices.batch : 1)
  );
}

/** The usage as core's run record holds it: one figure for cache writes. */
export function totalsOf(usage: RequestUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    cacheWriteTokens: usage.cacheWrite5mTokens + usage.cacheWrite1hTokens,
    cacheReadTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
  };
}

/** How many bytes a text is in UTF-8. */
export const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Tokens the API adds around what is sent: the framing of the messages, and
 * the instruction it writes for itself from the output schema. Generous.
 */
const OVERHEAD_TOKENS = 1000;

/** The sizes of one request, in bytes of UTF-8. */
export interface RequestSize {
  /** The system prompt. With the direct transport it is written to the cache. */
  systemBytes: number;
  /** The message, and the output schema. */
  restBytes: number;
}

/**
 * The most one request can cost, whatever the model does. A token is at
 * least one byte of text, so a request has no more input tokens than it has
 * bytes, plus the overhead above; every input token is taken at the dearest
 * rate it can be charged at, which is a cache write where the system prompt
 * is cached; and the output is taken as the whole of `MAX_OUTPUT_TOKENS`.
 * The true cost is several times lower. The spend cap is kept with this
 * figure, which is what makes it a cap and not a hope.
 */
export function mostOf(
  size: RequestSize,
  transport: Transport,
  model: string = MODEL,
): number {
  const prices = pricesOf(model);
  const cached = transport === "direct";
  const inputEquivalent =
    size.systemBytes * (cached ? prices.cacheWrite5m : 1) +
    size.restBytes +
    OVERHEAD_TOKENS;
  if (inputEquivalent > prices.longPromptTokens) {
    throw new Error(
      "A request is large enough to be charged on the long-prompt price card, which pricing.ts does not hold. Shorten the instructions or the text limits.",
    );
  }
  return (
    ((inputEquivalent * prices.input + MAX_OUTPUT_TOKENS * prices.output) /
      MILLION) *
    (transport === "batch" ? prices.batch : 1)
  );
}

/**
 * Characters per token, for an estimate made before anything is sent. This
 * model's tokenizer gives about a third more tokens than the rule of thumb
 * of four characters a token; Turkish and JSON give more still. The range
 * between the two is the estimate's honesty, and the first real run
 * replaces it with what the API counted.
 */
const CHARACTERS_PER_TOKEN = { few: 3.6, many: 2.4 };
/** What the answer and the thinking before it come to, per post, at low effort. */
const OUTPUT_TOKENS = { few: 60, many: 320 };
/** How much of the system prompt is read from the cache in a direct run, once it is warm. */
const CACHED_SHARE = { few: 0.98, many: 0 };

export interface Estimate {
  inputTokens: { few: number; many: number };
  outputTokens: { few: number; many: number };
  costUsd: { few: number; many: number };
}

/**
 * What a run of these requests is likely to use and cost, as a range.
 * `characters` are of the text sent, not bytes: the system prompt once per
 * request, and each message.
 */
export function estimate(
  requests: readonly { systemCharacters: number; restCharacters: number }[],
  transport: Transport,
  model: string = MODEL,
): Estimate {
  const prices = pricesOf(model);
  const side = (which: "few" | "many") => {
    let inputTokens = 0;
    let inputEquivalent = 0;
    for (const { systemCharacters, restCharacters } of requests) {
      const system = systemCharacters / CHARACTERS_PER_TOKEN[which];
      const rest = restCharacters / CHARACTERS_PER_TOKEN[which] + 150;
      const cachedShare = transport === "direct" ? CACHED_SHARE[which] : 0;
      inputTokens += system + rest;
      inputEquivalent +=
        system * (cachedShare * prices.cacheRead + (1 - cachedShare)) + rest;
    }
    const outputTokens = requests.length * OUTPUT_TOKENS[which];
    return {
      inputTokens: Math.round(inputTokens),
      outputTokens,
      costUsd:
        ((inputEquivalent * prices.input + outputTokens * prices.output) /
          MILLION) *
        (transport === "batch" ? prices.batch : 1),
    };
  };
  const few = side("few");
  const many = side("many");
  return {
    inputTokens: { few: few.inputTokens, many: many.inputTokens },
    outputTokens: { few: few.outputTokens, many: many.outputTokens },
    costUsd: { few: few.costUsd, many: many.costUsd },
  };
}

/** A sum of money for a report: enough digits to show a fraction of a cent, and a hundredth of one for what a single bookmark costs. */
export function usd(amount: number): string {
  if (amount > 0 && amount < 0.001) return `$${amount.toFixed(5)}`;
  return `$${amount < 0.1 ? amount.toFixed(4) : amount.toFixed(2)}`;
}
