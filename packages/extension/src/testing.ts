import { vi } from "vitest";
import {
  BODY_DIGEST_HEADER,
  NONCE_HEADER,
  PROOF_HEADER,
  proveResponse,
  requestSignatureIsValid,
  SIGNATURE_SCHEME,
  sha256Hex,
} from "./auth.ts";
import { parseQueuedCapture } from "./protocol.ts";
import type { KeyValueStore } from "./queue.ts";

/** The pairing token the fake app holds unless told otherwise. */
export const TOKEN = "kq3vX2mB8sYt0aLr5nWc7dHf1gJz4pQe9uTi6oVbNxM";

/** Storage that outlives a queue, as `chrome.storage.local` outlives a service worker. */
export function memoryStorage(): KeyValueStore & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => structuredClone(data.get(key)),
    set: async (items) => {
      for (const [key, value] of Object.entries(structuredClone(items))) {
        data.set(key, value);
      }
    },
    remove: async (key) => void data.delete(key),
    keys: async () => [...data.keys()],
  };
}

/**
 * How the far end treats one capture.
 * - a number: the app answers with that status, with its proof.
 * - `unreachable`: nothing is listening.
 * - `stored-then-lost`: the app stores it, and the answer never arrives.
 * - `mimic`: something without the token answers exactly as the app would.
 * - `wrong-id`: the app, with its proof, confirms some other capture.
 */
export type Answer =
  | number
  | "unreachable"
  | "stored-then-lost"
  | "mimic"
  | "wrong-id";

interface SeenRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A stand-in for whatever listens on the app's port. By default it is the
 * app: it holds `token`, checks each request's signature, stores a capture
 * once per id, and signs its answers. `squatter` is something else entirely,
 * answering 200 to everything.
 */
export function fakeApp(options: { token?: string; squatter?: boolean } = {}) {
  const appToken = options.token ?? TOKEN;
  const stored = new Map<string, string>();
  const requests: SeenRequest[] = [];
  const script: Answer[] = [];
  let down = false;
  let gate: Promise<void> | undefined;

  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = Object.fromEntries(new Headers(init?.headers));
    const body = String(init?.body);
    if (down) throw new TypeError("Failed to fetch");
    requests.push({ path, headers, body });
    await gate;
    if (options.squatter) return Response.json({ status: "stored" });

    const nonce = headers[NONCE_HEADER] ?? "";
    const [scheme, signature = ""] = (headers.authorization ?? "").split(" ");
    const signed =
      scheme === SIGNATURE_SCHEME &&
      headers[BODY_DIGEST_HEADER] === (await sha256Hex(body)) &&
      (await requestSignatureIsValid(
        appToken,
        { method: "POST", path, nonce, bodyDigest: await sha256Hex(body) },
        signature,
      ));
    if (!signed) return Response.json({ error: "unsigned" }, { status: 401 });

    const proven = async (status: number, answer: unknown) => {
      const text = JSON.stringify(answer);
      const proof = await proveResponse(appToken, {
        nonce,
        status,
        bodyDigest: await sha256Hex(text),
      });
      return new Response(text, { status, headers: { [PROOF_HEADER]: proof } });
    };
    if (path === "/api/pairing") return proven(200, { paired: true });

    const capture = parseQueuedCapture(JSON.parse(body));
    if (capture === undefined) return proven(422, { error: "invalid" });
    const answer = script.shift() ?? 200;
    if (answer === "unreachable") throw new TypeError("Failed to fetch");
    if (answer === "mimic") {
      return Response.json(
        { status: "stored", id: capture.id },
        { status: 201, headers: { [PROOF_HEADER]: "0".repeat(64) } },
      );
    }
    if (answer === "wrong-id") {
      return proven(201, { status: "stored", id: "some-other-capture" });
    }
    if (answer !== 200 && answer !== "stored-then-lost") {
      return proven(answer, { error: "refused" });
    }
    const isNew = !stored.has(capture.id);
    if (isNew) stored.set(capture.id, capture.payload);
    if (answer === "stored-then-lost") throw new TypeError("Failed to fetch");
    return proven(isNew ? 201 : 200, {
      status: isNew ? "stored" : "duplicate",
      id: capture.id,
    });
  });

  return {
    fetch,
    stored,
    requests,
    /** Scripts the answers to the next captures, in order. */
    answer: (...answers: Answer[]) => void script.push(...answers),
    goDown: () => {
      down = true;
    },
    comeUp: () => {
      down = false;
    },
    /** Makes every request wait, unanswered, until the returned function is called. */
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      gate = promise;
      return () => {
        gate = undefined;
        resolve();
      };
    },
    /** The ids of the captures that reached the far end, in order. */
    captureIds: () =>
      requests
        .filter(({ path }) => path === "/api/ingest")
        .map(({ body }) => JSON.parse(body).id as string),
  };
}

/**
 * The shapes of an SVG drawing, one string each, however they are spaced and
 * indented: what the mark's copies are compared by.
 */
export function shapesOf(markup: string): string[] {
  return (markup.match(/<(?:rect|path|circle)\b[^>]*>/g) ?? []).map((shape) =>
    shape.replace(/\s+/g, " ").replace(/ ?\/?>$/, ""),
  );
}
