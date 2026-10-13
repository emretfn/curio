import {
  BODY_DIGEST_HEADER,
  NONCE_HEADER,
  newNonce,
  PROOF_HEADER,
  responseProofIsValid,
  SIGNATURE_SCHEME,
  sha256Hex,
  signRequest,
} from "./auth.ts";
import type { Pairing, Status, Trouble } from "./channel.ts";
import {
  APP_ORIGIN,
  type CaptureProblem,
  INGEST_PATH,
  PAIRING_PATH,
  parseIngestAnswer,
  parseQueuedCapture,
  type QueuedCapture,
  type SeenResponse,
} from "./protocol.ts";

/** The storage the queue needs. `chrome.storage.local` in the extension. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  /** Writes every item or none of them. */
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface CaptureQueueOptions {
  storage: KeyValueStore;
  fetch: typeof fetch;
  /** The clock captures are dated by. It must be one no web page can reach. */
  now?: () => number;
  newId?: () => string;
  /** How long one exchange may take before the app counts as unreachable. */
  timeoutMs?: number;
}

export interface CaptureQueue {
  /**
   * Dates a seen response by this queue's clock and stores it for delivery.
   * It stays stored until the app acknowledges it.
   */
  enqueue(seen: SeenResponse): Promise<QueuedCapture>;
  /** Records an allowlisted response that could not be captured. */
  noteProblem(problem: CaptureProblem): Promise<void>;
  /** Saves the pairing token and asks the app to prove it holds the same one. */
  pair(token: string): Promise<Status>;
  /**
   * Asks the app again to prove it holds the saved token, as `pair` does,
   * for a token saved while the app was not answering. Sends the same signed
   * greeting and nothing else; with no token saved it sends nothing.
   */
  checkPairing(): Promise<Status>;
  /**
   * Sends waiting captures to the app, oldest first, once the app has proved
   * it holds the token, and stops at the first one it cannot be reached for.
   * Calls made while a delivery is running join it. `retryRejected` also
   * re-sends captures the app refused earlier.
   */
  deliver(options?: { retryRejected?: boolean }): Promise<Status>;
  status(): Promise<Status>;
}

interface Stats {
  /**
   * Counted in the same write that stores the capture, so it is exact. The
   * number delivered is not stored: it is what was captured and is no longer
   * in the queue, which stays true if the worker stops between two writes.
   */
  captured: number;
  lastCapturedAt: number | null;
  lastDeliveredAt: number | null;
  lastError: {
    at: number;
    message: string;
    from: "capture" | "delivery";
    /** Absent on an error stored before errors said what they were about. */
    trouble?: Trouble;
  } | null;
}

/** How one request to the app's address ended. */
type Exchange =
  | { kind: "unreachable" }
  /** Something answered, without proof that it holds the token. */
  | { kind: "unproven" }
  /** The app answered. */
  | { kind: "answer"; status: number; body: unknown };

const TOKEN_KEY = "token";
const PAIRED_KEY = "paired";
const STATS_KEY = "stats";
const WAITING = "queue:";
const REJECTED = "rejected:";

const NOT_PAIRED =
  "Not paired. Run `pnpm pair` in the x-bookmarks folder and paste the token it prints.";
const UNREACHABLE = `The app did not answer at ${APP_ORIGIN}. Captures are kept and sent when it is running.`;
const UNPROVEN = `Whatever answered at ${APP_ORIGIN} did not prove it holds this pairing token, so nothing was sent to it. Either the token is not the app's current one (run \`pnpm pair\` and pair again) or another program is using the app's port.`;

export function createCaptureQueue(options: CaptureQueueOptions): CaptureQueue {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 15_000;

  // Counters are read, changed and written back, so those steps run one at a
  // time. A service worker has one thread, but awaits interleave.
  let statsTurn: Promise<unknown> = Promise.resolve();
  function updateStats(
    change: (stats: Stats) => void,
    together: Record<string, unknown> = {},
  ): Promise<void> {
    const turn = statsTurn.then(async () => {
      const stats = await readStats();
      change(stats);
      await storage.set({ ...together, [STATS_KEY]: stats });
    });
    statsTurn = turn.catch(() => {});
    return turn;
  }
  async function readStats(): Promise<Stats> {
    return {
      captured: 0,
      lastCapturedAt: null,
      lastDeliveredAt: null,
      lastError: null,
      ...((await storage.get(STATS_KEY)) as Partial<Stats> | undefined),
    };
  }
  const deliveryError = (trouble: Trouble, message: string): Promise<void> =>
    updateStats((stats) => {
      stats.lastError = { at: now(), message, from: "delivery", trouble };
    });
  const clearDeliveryError = (): Promise<void> =>
    updateStats((stats) => {
      if (stats.lastError?.from === "delivery") stats.lastError = null;
    });

  async function keysUnder(prefix: string): Promise<string[]> {
    // Keys start with the capture time, zero-padded, so this is oldest first.
    return (await storage.keys())
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  /**
   * Posts to the app and believes the answer only if it carries the app's
   * proof. The token itself is never sent: the request is signed with it.
   */
  async function exchange(
    path: string,
    token: string,
    body: string,
  ): Promise<Exchange> {
    const nonce = newNonce();
    const bodyDigest = await sha256Hex(body);
    const signature = await signRequest(token, {
      method: "POST",
      path,
      nonce,
      bodyDigest,
    });
    let status: number;
    let text: string;
    let proof: string | null;
    try {
      const response = await options.fetch(`${APP_ORIGIN}${path}`, {
        method: "POST",
        headers: {
          authorization: `${SIGNATURE_SCHEME} ${signature}`,
          [NONCE_HEADER]: nonce,
          [BODY_DIGEST_HEADER]: bodyDigest,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      proof = response.headers.get(PROOF_HEADER);
      text = await response.text();
    } catch {
      return { kind: "unreachable" };
    }
    const proven =
      proof !== null &&
      (await responseProofIsValid(
        token,
        { nonce, status, bodyDigest: await sha256Hex(text) },
        proof,
      ));
    if (!proven) return { kind: "unproven" };
    try {
      return { kind: "answer", status, body: JSON.parse(text) };
    } catch {
      return { kind: "answer", status, body: undefined };
    }
  }

  /**
   * Asks the app to prove it holds the token, before anything else is sent.
   * True when it did. Records the outcome either way.
   */
  async function appProvesItself(token: string): Promise<boolean> {
    const hello = await exchange(PAIRING_PATH, token, "{}");
    if (hello.kind === "unreachable") {
      await deliveryError("app-unreachable", UNREACHABLE);
      return false;
    }
    if (hello.kind === "unproven" || hello.status !== 200) {
      await storage.set({ [PAIRED_KEY]: false });
      await deliveryError("app-unproven", UNPROVEN);
      return false;
    }
    await storage.set({ [PAIRED_KEY]: true });
    return true;
  }

  async function readToken(): Promise<string | undefined> {
    const token = await storage.get(TOKEN_KEY);
    return typeof token === "string" && token !== "" ? token : undefined;
  }

  /** One pass over the queue. True when it ended because nothing was left to send. */
  async function pass(retryRejected: boolean): Promise<boolean> {
    const keys = [
      ...(retryRejected ? await keysUnder(REJECTED) : []),
      ...(await keysUnder(WAITING)),
    ];
    if (keys.length === 0) return true;
    const token = await readToken();
    if (token === undefined) {
      await deliveryError("not-paired", NOT_PAIRED);
      return false;
    }
    // No capture leaves the extension until the other end has shown it is
    // the paired app: anything can be listening on the port while the app is
    // closed.
    if (!(await appProvesItself(token))) return false;

    let refused = false;
    let delivered = false;
    for (const key of keys) {
      const capture = parseQueuedCapture(await storage.get(key));
      if (capture === undefined) continue;
      const result = await exchange(
        INGEST_PATH,
        token,
        JSON.stringify(capture),
      );
      if (result.kind === "unreachable") {
        await deliveryError("app-unreachable", UNREACHABLE);
        return false;
      }
      if (result.kind === "unproven") {
        await deliveryError("app-unproven", UNPROVEN);
        return false;
      }
      if ([400, 413, 422].includes(result.status)) {
        refused = true;
        if (key.startsWith(WAITING)) {
          // Set aside so one refused capture cannot hold up the rest. Written
          // under the new key before the old one goes, so it is never lost.
          await storage.set({
            [REJECTED + key.slice(WAITING.length)]: capture,
          });
          await storage.remove(key);
        }
        await deliveryError(
          "capture-refused",
          `The app refused a capture (HTTP ${result.status}). It is kept in the extension.`,
        );
        continue;
      }
      // Only the app's own word that this very capture is stored removes it.
      const answer = parseIngestAnswer(result.body);
      const stored =
        (result.status === 200 || result.status === 201) &&
        answer?.id === capture.id;
      if (!stored) {
        await deliveryError(
          "capture-unconfirmed",
          `The app answered HTTP ${result.status} without confirming the capture. Captures are kept and retried.`,
        );
        return false;
      }
      await storage.remove(key);
      delivered = true;
      await updateStats((stats) => {
        stats.lastDeliveredAt = now();
      });
    }
    // Only an answer from the app shows that an earlier delivery error is
    // over.
    if (delivered && !refused) await clearDeliveryError();
    return true;
  }

  let running: Promise<void> | undefined;
  let askedAgain = false;
  let retryRejectedNext = false;
  function deliver(retryRejected: boolean): Promise<void> {
    retryRejectedNext ||= retryRejected;
    if (running !== undefined) {
      // A capture queued after the running pass listed its keys would wait
      // for the next retry; note it so the run makes another pass.
      askedAgain = true;
      return running;
    }
    running = (async () => {
      try {
        let drained: boolean;
        do {
          askedAgain = false;
          const retry = retryRejectedNext;
          retryRejectedNext = false;
          drained = await pass(retry);
        } while (drained && askedAgain);
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  async function pairing(): Promise<Pairing> {
    if ((await readToken()) === undefined) return "none";
    const paired = await storage.get(PAIRED_KEY);
    if (paired === true) return "paired";
    return paired === false ? "refused" : "unconfirmed";
  }

  async function status(): Promise<Status> {
    await statsTurn;
    const [stats, pairingNow, waiting, rejected] = await Promise.all([
      readStats(),
      pairing(),
      keysUnder(WAITING),
      keysUnder(REJECTED),
    ]);
    return {
      pairing: pairingNow,
      captured: stats.captured,
      delivered: Math.max(0, stats.captured - waiting.length - rejected.length),
      pending: waiting.length,
      rejected: rejected.length,
      lastCapturedAt: stats.lastCapturedAt,
      lastDeliveredAt: stats.lastDeliveredAt,
      lastError: stats.lastError && {
        at: stats.lastError.at,
        message: stats.lastError.message,
        trouble: stats.lastError.trouble ?? null,
      },
    };
  }

  /** Has the app prove it holds `token`, and delivers what was waiting if it does. */
  async function confirm(token: string): Promise<Status> {
    if (await appProvesItself(token)) {
      await clearDeliveryError();
      await deliver(false);
    }
    return status();
  }

  return {
    async enqueue(seen) {
      const capturedAt = now();
      const queued: QueuedCapture = { id: newId(), ...seen, capturedAt };
      const order = String(Math.max(0, capturedAt)).padStart(15, "0");
      // The capture and its count go in together, in one write.
      await updateStats(
        (stats) => {
          stats.captured += 1;
          stats.lastCapturedAt = capturedAt;
        },
        { [`${WAITING}${order}:${queued.id}`]: queued },
      );
      return queued;
    },
    async noteProblem(problem) {
      await updateStats((stats) => {
        stats.lastError = {
          at: now(),
          message: `${problem.operation}: ${problem.detail}`,
          from: "capture",
          trouble: "not-captured",
        };
      });
    },
    async pair(token) {
      await storage.set({ [TOKEN_KEY]: token.trim() });
      // Unconfirmed until the app proves itself with this token.
      await storage.remove(PAIRED_KEY);
      return confirm(token.trim());
    },
    async checkPairing() {
      const token = await readToken();
      return token === undefined ? status() : confirm(token);
    },
    async deliver({ retryRejected = false } = {}) {
      await deliver(retryRejected);
      return status();
    },
    status,
  };
}
