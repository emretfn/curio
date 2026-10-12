import type { ParsedMutation } from "./parsers/parsed.ts";
import { connectionOf, type Store } from "./store.ts";

/**
 * Package-internal: records what a mutation capture says about a post, dated
 * to when that capture was received. `parseCapture` is the one caller.
 *
 * There is no way to pass the time, for the reason `upsertBookmark` takes
 * none: it is the capture's, whenever the parser runs. The row keeps the
 * latest capture of each kind, so replaying an older one changes nothing and
 * the result does not depend on the order captures are parsed in.
 */
export function recordMutation(
  store: Store,
  mutation: ParsedMutation,
  captureId: number,
): void {
  const [at, capture] =
    mutation.kind === "bookmarked"
      ? ["bookmarked_at", "bookmarked_capture_id"]
      : ["removed_at", "removed_capture_id"];
  const { changes } = connectionOf(store)
    .prepare(
      `INSERT INTO bookmark_mutations (post_id, ${at}, ${capture})
       SELECT @postId, received_at, id FROM raw_captures WHERE id = @captureId
       ON CONFLICT (post_id) DO UPDATE SET
         ${at} = excluded.${at},
         ${capture} = excluded.${capture}
       WHERE bookmark_mutations.${at} IS NULL
          OR (excluded.${at}, excluded.${capture})
             > (bookmark_mutations.${at}, bookmark_mutations.${capture})`,
    )
    .run({ postId: mutation.postId, captureId });
  // Zero changes is also what an older capture replayed gives, so the capture
  // is looked for only then.
  if (changes === 0) {
    const exists = connectionOf(store)
      .prepare("SELECT 1 FROM raw_captures WHERE id = ?")
      .get(captureId);
    if (exists === undefined) {
      throw new Error(`Raw capture ${captureId} does not exist.`);
    }
  }
}
