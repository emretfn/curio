/**
 * The one way a page of this app changes the library: a POST to this app,
 * by a relative address, with a JSON body. It is kept in a file of its own
 * so that the only code in the browser that sends the server a change is
 * these few lines.
 *
 * The app lets the request in because of what the browser says about it,
 * which this code cannot write: where the page is, and that the page and
 * the app are one origin. See `refuseUnlessOwnPage`.
 */
import type {
  OwnerAction,
  OwnerWriteAnswer,
  OwnerWriteRefusal,
} from "@/server/owner-writes";

/** A change the app refused or could not make. Its message is fit to show. */
export class OwnerWriteError extends Error {
  /**
   * Whether the app itself said no, as against the change never reaching
   * it. A refusal is often the sign of a screen that is behind the library:
   * the tag it offered was retired since, in another tab.
   */
  readonly refused: boolean;
  constructor(message: string, refused = false) {
    super(message);
    this.name = "OwnerWriteError";
    this.refused = refused;
  }
}

const UNREACHABLE =
  "The change did not reach the app. Check that it is still running, then try again.";

/** Makes one change, and returns what the app says came of it. */
export async function ownerWrite(
  action: OwnerAction,
  body: Record<string, unknown>,
): Promise<OwnerWriteAnswer> {
  let response: Response;
  try {
    response = await fetch(`/api/owner/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new OwnerWriteError(UNREACHABLE);
  }
  let answer: OwnerWriteAnswer | OwnerWriteRefusal;
  try {
    answer = (await response.json()) as OwnerWriteAnswer | OwnerWriteRefusal;
  } catch {
    throw new OwnerWriteError(UNREACHABLE);
  }
  if (!response.ok || "error" in answer) {
    throw new OwnerWriteError(
      "error" in answer ? answer.error : `The app answered ${response.status}.`,
      true,
    );
  }
  return answer;
}

/** A failure as a sentence to show, whatever was thrown. */
export const failureMessage = (error: unknown): string =>
  error instanceof OwnerWriteError
    ? error.message
    : "The change could not be made.";
