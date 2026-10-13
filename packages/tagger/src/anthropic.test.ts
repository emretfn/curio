import { afterEach, expect, test, vi } from "vitest";
import {
  CLAUDE_API_ORIGIN,
  ClaudeFailure,
  createClaude,
  ForeignHostError,
  onlyToClaude,
  type Send,
} from "./anthropic.ts";
import { requestFor } from "./request.ts";
import { SAMPLE_ASKING } from "./testing/asking.ts";
import { FAKE_KEY, type FakeApiOptions, fakeApi } from "./testing/fake-api.ts";

afterEach(() => vi.unstubAllEnvs());

const request = () =>
  requestFor({ text: "a post to classify" }, "direct", SAMPLE_ASKING);

const client = (options: FakeApiOptions = {}, apiKey = FAKE_KEY) => {
  const api = fakeApi(options);
  return { api, claude: createClaude({ apiKey, send: api.send, retries: 1 }) };
};

/** What a call fails with. */
async function failure(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("The call did not fail.");
}

test("a request goes to the Claude API, signed with the key it was given", async () => {
  const { api, claude } = client();

  const message = await claude.classify(request());

  expect(message.stop_reason).toBe("end_turn");
  expect(api.sent).toHaveLength(1);
  expect(api.sent[0]).toMatchObject({
    method: "POST",
    url: `${CLAUDE_API_ORIGIN}/v1/messages`,
    body: request(),
  });
  expect(api.sent[0]?.headers["x-api-key"]).toBe(FAKE_KEY);
});

test("nothing in the environment changes where a request goes, what signs it or what it carries", async () => {
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.example");
  vi.stubEnv(
    "ANTHROPIC_API_KEY",
    "sk-ant-api03-FROM0THE0ENVIRONMENT0000000000",
  );
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "a-token-from-the-environment");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-added-by-environment: yes");
  vi.stubEnv("ANTHROPIC_LOG", "debug");
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});
  const debugged = vi.spyOn(console, "debug").mockImplementation(() => {});
  const { api, claude } = client();

  await claude.classify(request());

  const [sent] = api.sent;
  expect(sent?.url).toBe(`${CLAUDE_API_ORIGIN}/v1/messages`);
  expect(sent?.headers["x-api-key"]).toBe(FAKE_KEY);
  expect(sent?.headers.authorization).toBeUndefined();
  expect(Object.keys(sent?.headers ?? {}).toSorted()).toEqual([
    "accept",
    "anthropic-version",
    "content-type",
    "user-agent",
    "x-api-key",
    "x-stainless-arch",
    "x-stainless-lang",
    "x-stainless-os",
    "x-stainless-package-version",
    "x-stainless-retry-count",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
    "x-stainless-timeout",
  ]);
  // The SDK was told to log nothing, whatever the environment asks for.
  expect(logged).not.toHaveBeenCalled();
  expect(debugged).not.toHaveBeenCalled();
});

test("this process's environment is left as it was: the key is never put there", async () => {
  const before = { ...process.env };
  const { claude } = client();

  await claude.classify(request());

  expect(process.env).toEqual(before);
  expect(JSON.stringify(process.env)).not.toContain(FAKE_KEY);
});

test("under a test runner no client is built for the real API, whatever key is at hand", () => {
  const platform = vi.spyOn(globalThis, "fetch");

  expect(() => createClaude({ apiKey: FAKE_KEY })).toThrow(
    /A test was about to build a client for the real Claude API/,
  );
  expect(platform).not.toHaveBeenCalled();
  platform.mockRestore();
});

test.each([
  "https://elsewhere.example/v1/messages",
  "https://api.anthropic.com.elsewhere.example/v1/messages",
  "http://api.anthropic.com/v1/messages",
  "https://api.anthropic.com:8443/v1/messages",
  "https://api.x.com/2/tweets",
  "not an address",
])("a request to %s is refused before it is made", (url) => {
  const send = vi.fn<Send>();

  expect(() => onlyToClaude(send)(url)).toThrow();
  expect(send).not.toHaveBeenCalled();
});

test("a request to the Claude API is passed on with redirects switched off", async () => {
  const send = vi.fn<Send>(async () => new Response("{}"));

  await onlyToClaude(send)(`${CLAUDE_API_ORIGIN}/v1/messages`, {
    method: "POST",
    redirect: "follow",
    headers: { "x-api-key": "k", "x-something-else": "dropped" },
  });

  expect(send).toHaveBeenCalledOnce();
  const init = send.mock.calls[0]?.[1];
  expect(init?.redirect).toBe("error");
  expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
    "x-api-key": "k",
  });
});

test("an address the API hands back is held to the same host: a batch's results elsewhere are not asked for", async () => {
  const { api, claude } = client({
    resultsUrl: (id) => `https://elsewhere.example/results/${id}`,
  });
  const id = await claude.submitBatch([
    { customId: "r1-0", request: request() },
  ]);

  expect(await failure(claude.batchResults(id))).toBeInstanceOf(
    ForeignHostError,
  );
  expect(
    api.sent.every(({ url }) => url.startsWith(`${CLAUDE_API_ORIGIN}/`)),
  ).toBe(true);
});

test("a batch is submitted, asked after, and read back by the ids its requests were given", async () => {
  const { api, claude } = client({ batchPolls: 1 });

  const id = await claude.submitBatch([
    {
      customId: "r7-0",
      request: requestFor({ text: "first" }, "batch", SAMPLE_ASKING),
    },
    {
      customId: "r7-1",
      request: requestFor({ text: "second" }, "batch", SAMPLE_ASKING),
    },
  ]);
  const first = await claude.batchStatus(id);
  const second = await claude.batchStatus(id);
  const results: string[] = [];
  for await (const { customId, result } of await claude.batchResults(id)) {
    results.push(`${customId} ${result.type}`);
  }

  expect(first).toEqual({ ended: false, processing: 2 });
  expect(second).toEqual({ ended: true, processing: 0 });
  expect(results.toSorted()).toEqual(["r7-0 succeeded", "r7-1 succeeded"]);
  expect(api.inputs).toEqual([{ text: "first" }, { text: "second" }]);
});

test.each([
  [401, "authentication_error", "unauthorised"],
  [403, "permission_error", "forbidden"],
  [404, "not_found_error", "not-found"],
  [400, "invalid_request_error", "rejected"],
  [429, "rate_limit_error", "rate-limited"],
  [500, "api_error", "unavailable"],
  [529, "overloaded_error", "unavailable"],
  [402, "billing_error", "failed"],
] as const)(
  "a %i from the API is a failure of kind %s… %s",
  async (status, type, kind) => {
    const { claude } = client({ reply: () => ({ status, type }) });

    const failed = await failure(claude.classify(request()));

    expect(failed).toBeInstanceOf(ClaudeFailure);
    expect((failed as ClaudeFailure).kind).toBe(kind);
  },
);

test("a failure that may pass is tried again, and one that will not is not", async () => {
  const passing = client({
    reply: (_, index) =>
      index === 0
        ? { status: 529, type: "overloaded_error" }
        : {
            too_little_text: false,
            category: "tools",
            format: "tip",
            tags: [],
            proposed_tags: [],
          },
  });
  const lasting = client({
    reply: () => ({ status: 400, type: "invalid_request_error" }),
  });

  await expect(passing.claude.classify(request())).resolves.toMatchObject({
    stop_reason: "end_turn",
  });
  await failure(lasting.claude.classify(request()));

  expect(passing.api.sent).toHaveLength(2);
  expect(lasting.api.sent).toHaveLength(1);
});

test("an API that cannot be reached is a failure that says nothing was lost", async () => {
  const api = fakeApi({ unreachable: true });
  const claude = createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 0 });

  const failed = await failure(claude.classify(request()));

  expect(failed).toBeInstanceOf(ClaudeFailure);
  expect((failed as ClaudeFailure).kind).toBe("unreachable");
  expect((failed as ClaudeFailure).message).toMatch(/Nothing was lost/);
});

test("attempts that brought no answer are counted, and an error the API answered with is not one", async () => {
  // The second and third attempts on the wire are lost; the fourth gets through.
  const flaky = fakeApi({
    unreachable: (attempt) => attempt === 1 || attempt === 2,
  });
  const claude = createClaude({
    apiKey: FAKE_KEY,
    send: flaky.send,
    retries: 2,
  });
  const refusing = client({
    reply: () => ({ status: 429, type: "rate_limit_error" }),
  });

  await claude.classify(request());
  expect(claude.lostRequests()).toBe(0);
  await claude.classify(request());
  await failure(refusing.claude.classify(request()));

  expect(flaky.sent).toHaveLength(4);
  expect(claude.lostRequests()).toBe(2);
  // Answered, with an error, twice: charged for nothing.
  expect(refusing.api.sent).toHaveLength(2);
  expect(refusing.claude.lostRequests()).toBe(0);
});

test("a batch is submitted once, however the first try ends", async () => {
  const api = fakeApi({ unreachable: true });
  const claude = createClaude({ apiKey: FAKE_KEY, send: api.send, retries: 3 });

  const failed = await failure(
    claude.submitBatch([{ customId: "r1-0", request: request() }]),
  );

  expect((failed as ClaudeFailure).kind).toBe("unreachable");
  expect(api.sent).toHaveLength(1);
  // And it is no lost message: nothing of a batch is charged until it runs.
  expect(claude.lostRequests()).toBe(0);
});

test("a key the API does not accept is a failure that does not repeat the key", async () => {
  const wrong = "sk-ant-api03-WRONG0KEY0000000000000000000000000";
  const { claude } = client({}, wrong);

  const failed = (await failure(claude.classify(request()))) as ClaudeFailure;

  expect(failed.kind).toBe("unauthorised");
  expect(
    `${failed.message} ${failed.stack} ${JSON.stringify(failed)}`,
  ).not.toContain(wrong);
});

test("no failure repeats the post it was about", async () => {
  const text = "a post with words nobody else should read";
  for (const status of [400, 401, 429, 500]) {
    const { claude } = client({
      reply: () => ({ status, type: "some_error" }),
    });
    const failed = (await failure(
      claude.classify(requestFor({ text }, "direct", SAMPLE_ASKING)),
    )) as ClaudeFailure;

    expect(`${failed.message} ${JSON.stringify(failed)}`).not.toContain(
      "nobody else",
    );
  }
});
