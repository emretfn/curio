import { expect, test } from "vitest";
import { MAX_OUTPUT_TOKENS } from "./instructions.ts";
import { costOf, estimate, mostOf, totalsOf, usd } from "./pricing.ts";

const usage = {
  inputTokens: 1_000_000,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
};

test("a request costs its tokens at the published prices", () => {
  expect(costOf(usage, "direct")).toBeCloseTo(0.1, 10);
  expect(
    costOf({ ...usage, inputTokens: 0, outputTokens: 1_000_000 }, "direct"),
  ).toBeCloseTo(0.5, 10);
  expect(
    costOf({ ...usage, inputTokens: 0, cacheReadTokens: 1_000_000 }, "direct"),
  ).toBeCloseTo(0.01, 10);
  expect(
    costOf(
      { ...usage, inputTokens: 0, cacheWrite5mTokens: 1_000_000 },
      "direct",
    ),
  ).toBeCloseTo(0.125, 10);
  expect(
    costOf(
      { ...usage, inputTokens: 0, cacheWrite1hTokens: 1_000_000 },
      "direct",
    ),
  ).toBeCloseTo(0.2, 10);
});

test("a batch costs half, on every kind of token", () => {
  const mixed = {
    inputTokens: 300,
    cacheWrite5mTokens: 2000,
    cacheWrite1hTokens: 100,
    cacheReadTokens: 5000,
    outputTokens: 150,
  };

  expect(costOf(mixed, "batch")).toBeCloseTo(costOf(mixed, "direct") / 2, 12);
});

test("a model with no price is refused, not run for free", () => {
  expect(() => costOf(usage, "direct", "a-model-nobody-priced")).toThrow(
    /no price/,
  );
  expect(() =>
    mostOf({ systemBytes: 1, restBytes: 1 }, "direct", "a-model-nobody-priced"),
  ).toThrow(/no price/);
});

test("the most a request can cost is never less than what any answer to it costs", () => {
  const size = { systemBytes: 7400, restBytes: 1800 };
  // The worst the API could report for a request of this size: every byte a
  // token, the instructions written to the cache, the answer at full length.
  const worstDirect = {
    inputTokens: size.restBytes,
    cacheWrite5mTokens: size.systemBytes,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    outputTokens: MAX_OUTPUT_TOKENS,
  };
  const worstBatch = {
    ...worstDirect,
    inputTokens: size.restBytes + size.systemBytes,
    cacheWrite5mTokens: 0,
  };

  expect(mostOf(size, "direct")).toBeGreaterThan(costOf(worstDirect, "direct"));
  expect(mostOf(size, "batch")).toBeGreaterThan(costOf(worstBatch, "batch"));
  // And far more than a likely one: about a quarter as many tokens as bytes, read from the cache.
  expect(mostOf(size, "direct")).toBeGreaterThan(
    5 *
      costOf(
        {
          inputTokens: 450,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 1850,
          outputTokens: 120,
        },
        "direct",
      ),
  );
});

test("a request too large for the price card that is held is refused", () => {
  expect(() =>
    mostOf({ systemBytes: 7400, restBytes: 120_000 }, "batch"),
  ).toThrow(/long-prompt/);
});

test("an estimate is a range that grows with the requests, and a batch is the cheaper", () => {
  const request = { systemCharacters: 7300, restCharacters: 1300 };
  const one = estimate([request], "direct");
  const hundred = estimate(Array(100).fill(request), "direct");
  const batched = estimate(Array(100).fill(request), "batch");

  expect(one.inputTokens.few).toBeLessThan(one.inputTokens.many);
  expect(one.costUsd.few).toBeLessThan(one.costUsd.many);
  expect(hundred.inputTokens.many / one.inputTokens.many).toBeCloseTo(100, 1);
  expect(hundred.costUsd.many).toBeCloseTo(100 * one.costUsd.many, 10);
  expect(batched.costUsd.many).toBeCloseTo(hundred.costUsd.many / 2, 10);
  expect(estimate([], "direct").costUsd).toEqual({ few: 0, many: 0 });
});

test("an estimate's dear end stays under the most the requests could cost", () => {
  const sizes = [
    {
      systemBytes: 7400,
      restBytes: 1500,
      systemCharacters: 7300,
      restCharacters: 1450,
    },
    {
      systemBytes: 7400,
      restBytes: 9000,
      systemCharacters: 7300,
      restCharacters: 5600,
    },
  ];

  for (const transport of ["direct", "batch"] as const) {
    expect(estimate(sizes, transport).costUsd.many).toBeLessThan(
      sizes.reduce((sum, size) => sum + mostOf(size, transport), 0),
    );
  }
});

test("usage is totalled for the run's record, and money is written with a fraction of a cent", () => {
  expect(
    totalsOf({
      inputTokens: 1,
      cacheWrite5mTokens: 2,
      cacheWrite1hTokens: 3,
      cacheReadTokens: 4,
      outputTokens: 5,
    }),
  ).toEqual({
    inputTokens: 1,
    cacheWriteTokens: 5,
    cacheReadTokens: 4,
    outputTokens: 5,
  });
  expect(usd(0.00123)).toBe("$0.0012");
  expect(usd(0.000123)).toBe("$0.00012");
  expect(usd(1.5)).toBe("$1.50");
  expect(usd(0)).toBe("$0.0000");
});
