/**
 * Reads the answer to one of X's bookmark mutations, `CreateBookmark` and
 * `DeleteBookmark`. The response says only that it was done; the post is
 * named in the request, as `variables.tweet_id`.
 */
import type { CaptureParser, ParsedMutation } from "../parsed.ts";
import {
  attempt,
  descend,
  id,
  type Node,
  required,
  rootNode,
  type ShapeIssue,
  unknownVariant,
} from "../shape.ts";

/** Where issues about the request are reported, as issues about the response are under `$`. */
const REQUEST_ROOT = "$request";

/** What X answers when the mutation was carried out. */
const DONE = "Done";

function json(text: string, path: string): Node | ShapeIssue {
  try {
    return { value: JSON.parse(text) as unknown, path };
  } catch {
    return {
      code: "not-json",
      path,
      detail:
        path === "$"
          ? "the payload is not JSON"
          : "the request body is not JSON",
    };
  }
}

/**
 * A parser for the mutation that answers under `data.<field>`. Anything but
 * X's confirmation there is not understood, and so changes nothing: an error
 * from X must never read as a bookmark made or removed.
 */
export function mutationParser(
  field: string,
  kind: ParsedMutation["kind"],
): CaptureParser {
  return (payload, requestBody) => {
    const response = json(payload, "$");
    if ("code" in response) return { outcome: "failed", issue: response };
    const confirmed = attempt(() => {
      const answer = required(
        required(rootNode(response.value), "data"),
        field,
      );
      if (answer.value !== DONE) unknownVariant(answer, [DONE]);
    });
    if (!confirmed.ok) return { outcome: "failed", issue: confirmed.issue };

    if (requestBody === null || requestBody === undefined) {
      return {
        outcome: "failed",
        issue: {
          code: "missing-field",
          path: REQUEST_ROOT,
          detail:
            "the capture holds no request body, and a mutation names its post only there",
        },
      };
    }
    const request = json(requestBody, REQUEST_ROOT);
    if ("code" in request) return { outcome: "failed", issue: request };
    const postId = attempt(() => id(descend(request, "variables", "tweet_id")));
    if (!postId.ok) return { outcome: "failed", issue: postId.issue };

    return {
      outcome: "parsed",
      entries: [],
      warnings: [],
      mutation: { kind, postId: postId.value },
    };
  };
}
