/**
 * The one place in this repo that calls Claude, and the one place anything
 * of the library leaves this computer for a third party.
 *
 * Everything it sends goes to `CLAUDE_API_ORIGIN` and nowhere else: the
 * client is given that address outright, whatever the environment says,
 * and every request passes `onlyToClaude`, which refuses any other host and
 * follows no redirect. What it sends is a `ClaudeRequest` built by
 * `request.ts` from the fields of `input.ts`. It makes requests and names
 * no host of X's; nothing here fetches anything to add to a post.
 */
import Anthropic from "@anthropic-ai/sdk";
import { assertNotXOwnedUrl } from "@x-bookmarks/core";

/** The Claude API. The only origin this package sends anything to. */
export const CLAUDE_API_ORIGIN = "https://api.anthropic.com";

export type ClaudeRequest = Anthropic.MessageCreateParamsNonStreaming;
export type ClaudeMessage = Anthropic.Message;
export type BatchResult = Anthropic.Messages.MessageBatchResult;

/** The function that sends a request: the platform's own, or a fake of the API in a test. */
export type Send = typeof globalThis.fetch;

/** Thrown in place of a request to any host but the Claude API. */
export class ForeignHostError extends Error {
  constructor() {
    super(
      `A request to a host other than ${CLAUDE_API_ORIGIN} was about to be made. The classifier sends the library's text to the Claude API and to nothing else.`,
    );
    this.name = "ForeignHostError";
  }
}

/**
 * The headers a request to the Claude API carries: the key, the API version,
 * the content type, and the SDK's own description of itself (its version,
 * the runtime, the platform, the retry count and the timeout). Any other is
 * dropped: the SDK also adds whatever a variable in the environment tells
 * it to, and what leaves this computer is decided here, not there.
 */
const SENT_HEADER =
  /^(?:accept|content-type|content-length|user-agent|x-api-key|anthropic-version|x-stainless-[a-z-]+)$/;

/**
 * Wraps a sender so that it reaches the Claude API alone. An address the
 * API hands back, such as where a batch's results are, is checked like any
 * other, and a redirect is an error and not a second request.
 */
export function onlyToClaude(send: Send): Send {
  return (input, init) => {
    const url = assertNotXOwnedUrl(
      input instanceof Request ? input.url : String(input),
    );
    if (url.origin !== CLAUDE_API_ORIGIN) throw new ForeignHostError();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const name of [...headers.keys()]) {
      if (!SENT_HEADER.test(name)) headers.delete(name);
    }
    return send(input, { ...init, headers, redirect: "error" });
  };
}

/**
 * Why a request came to nothing, as a kind the run can act on. The message
 * is fit to show: the status and the API's own name for the error, and
 * nothing of the request, the key or a post.
 */
export class ClaudeFailure extends Error {
  readonly kind:
    | "unreachable"
    | "unauthorised"
    | "forbidden"
    | "not-found"
    | "rate-limited"
    | "rejected"
    | "unavailable"
    | "failed";
  constructor(kind: ClaudeFailure["kind"], message: string) {
    super(message);
    this.name = "ClaudeFailure";
    this.kind = kind;
  }
}

/** The API's name for an error, such as `invalid_request_error`, when its answer gave one. */
function typeOf(error: InstanceType<typeof Anthropic.APIError>): string {
  const body: unknown = error.error;
  if (typeof body === "object" && body !== null && "error" in body) {
    const inner: unknown = body.error;
    if (typeof inner === "object" && inner !== null && "type" in inner) {
      return String(inner.type);
    }
  }
  return "an error";
}

function failureOf(error: unknown): unknown {
  if (error instanceof ForeignHostError) return error;
  // Most specific first. A connection error has no status, so it is asked
  // for before the classes that have one.
  if (error instanceof Anthropic.APIConnectionError) {
    // The SDK reports whatever the sender threw as a failed connection. A
    // refusal to leave for another host is no such thing, and is not to be
    // mistaken for an API that will be back later.
    if (
      error.cause instanceof Error &&
      error.cause.name.endsWith("HostError")
    ) {
      return error.cause;
    }
    return new ClaudeFailure(
      "unreachable",
      "The Claude API could not be reached. Nothing was lost: what was not classified is classified by the next run.",
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ClaudeFailure(
      "unauthorised",
      "The Claude API did not accept the API key (401). Check that the key in .env is current and belongs to a workspace that is still active.",
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeFailure(
      "forbidden",
      `The Claude API refused the request for this key (403, ${typeOf(error)}). The key's workspace may not be allowed this model or this operation.`,
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ClaudeFailure(
      "not-found",
      `The Claude API knows no such model or batch for this key (404, ${typeOf(error)}).`,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ClaudeFailure(
      "rate-limited",
      "The Claude API's rate limit was reached and stayed reached through the retries (429). Run again later; what is classified is kept.",
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new ClaudeFailure(
      "rejected",
      `The Claude API rejected the request (400, ${typeOf(error)}). When this is every request, the cause is the request's shape or the account's credit, not a post.`,
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeFailure(
      typeof error.status === "number" && error.status >= 500
        ? "unavailable"
        : "failed",
      `The Claude API answered with ${error.status ?? "no status"} (${typeOf(error)}).`,
    );
  }
  return error;
}

async function asking<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw failureOf(error);
  }
}

/** Where a batch stands. */
export interface BatchStatus {
  ended: boolean;
  /** How many of its requests are still being processed. */
  processing: number;
}

/** The Claude API as this package uses it: one message, a batch of them, or one long answer. */
export interface Claude {
  /** Sends one request and returns the model's message. Throws a `ClaudeFailure`. */
  classify(request: ClaudeRequest): Promise<ClaudeMessage>;
  /**
   * The most attempts one call to `classify` puts on the wire: the first,
   * and each time the client tries again after a failure that may pass.
   * Any of them can be one that got no answer and was charged all the same
   * (`lostRequests`), so a caller with a spend cap sets aside the most a
   * request can cost this many times over before it calls.
   */
  attemptsPerRequest: number;
  /**
   * Sends one request whose answer is long, the weekly digest's, and
   * returns the model's message. It is given minutes and not a minute, and
   * it is tried once: an attempt that times out may have been charged, so
   * whether to try again is the caller's to decide against its spend cap.
   * Throws a `ClaudeFailure`.
   */
  write(request: ClaudeRequest): Promise<ClaudeMessage>;
  /**
   * How many attempts at `classify` or `write` went out and got no answer
   * at all: a timeout, a dropped connection. The API may have worked on
   * each and charged for it, and nothing says whether it did. A request the
   * API answered with an error is not among them: an error is not charged.
   */
  lostRequests(): number;
  /**
   * Submits requests as one batch and returns the API's id for it. It is
   * tried once: a second try after a lost answer could create, and be
   * charged for, a second batch.
   */
  submitBatch(
    requests: readonly { customId: string; request: ClaudeRequest }[],
  ): Promise<string>;
  batchStatus(batchId: string): Promise<BatchStatus>;
  /** The results of an ended batch, in no particular order. */
  batchResults(
    batchId: string,
  ): Promise<AsyncIterable<{ customId: string; result: BatchResult }>>;
}

/**
 * Whether this process is a test run, or was started by one: Vitest and
 * Node's own test runner each set a variable, which a process they start
 * inherits. The end-to-end test's app is such a process.
 */
const underTest = () =>
  process.env.VITEST !== undefined ||
  process.env.NODE_TEST_CONTEXT !== undefined;

/** How long one request may take, and how often it is tried again after a failure that may pass. */
const TIMEOUT_MS = 60_000;
const RETRIES = 4;
/** How long the submission of a batch may take: it carries every request of the run. */
const SUBMIT_TIMEOUT_MS = 10 * 60_000;
/** How long a long answer may take: a week's digest, thought over and written out. */
const WRITE_TIMEOUT_MS = 5 * 60_000;

/**
 * A client for the Claude API that holds `apiKey` and uses nothing else to
 * sign in: not the environment's key or token, not a stored profile. The
 * environment cannot move it to another address either, and nothing it
 * does is logged. Under a test runner it is built only over a sender the
 * test supplies.
 */
export function createClaude(options: {
  apiKey: string;
  /** In place of the platform's own sender. A test passes a fake of the API. */
  send?: Send | undefined;
  /** How often a request is tried again after a failure that may pass. */
  retries?: number | undefined;
}): Claude {
  // No test reaches the real API, whatever key it has found (AI-10): under
  // a test runner a client is built over a fake, or not at all.
  if (options.send === undefined && underTest()) {
    throw new Error(
      "A test was about to build a client for the real Claude API. Tests pass the fake of testing/fake-api.ts as the sender.",
    );
  }
  const send = onlyToClaude(options.send ?? globalThis.fetch);
  let lost = 0;
  /** Counts the attempts at a message that went out and brought nothing back. */
  const counting: Send = async (input, init) => {
    try {
      return await send(input, init);
    } catch (error) {
      const { pathname } = new URL(
        input instanceof Request ? input.url : String(input),
      );
      if (pathname === "/v1/messages" && !(error instanceof ForeignHostError)) {
        lost += 1;
      }
      throw error;
    }
  };
  const retries = options.retries ?? RETRIES;
  const client = new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: CLAUDE_API_ORIGIN,
    fetch: counting,
    logLevel: "off",
    timeout: TIMEOUT_MS,
    maxRetries: retries,
  });
  return {
    classify: (request) => asking(() => client.messages.create(request)),
    attemptsPerRequest: retries + 1,
    write: (request) =>
      asking(() =>
        client.messages.create(request, {
          maxRetries: 0,
          timeout: WRITE_TIMEOUT_MS,
        }),
      ),
    lostRequests: () => lost,
    submitBatch: (requests) =>
      asking(async () => {
        const batch = await client.messages.batches.create(
          {
            requests: requests.map(({ customId, request }) => ({
              custom_id: customId,
              params: request,
            })),
          },
          { maxRetries: 0, timeout: SUBMIT_TIMEOUT_MS },
        );
        return batch.id;
      }),
    batchStatus: (batchId) =>
      asking(async () => {
        const batch = await client.messages.batches.retrieve(batchId);
        return {
          ended: batch.processing_status === "ended",
          processing: batch.request_counts.processing,
        };
      }),
    batchResults: (batchId) =>
      asking(async () => {
        const results = await client.messages.batches.results(batchId);
        return (async function* () {
          try {
            for await (const { custom_id, result } of results) {
              yield { customId: custom_id, result };
            }
          } catch (error) {
            throw failureOf(error);
          }
        })();
      }),
  };
}
