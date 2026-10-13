/**
 * The two ways a request reaches the model, and the one place the choice
 * between them is made.
 *
 * - `direct`: one request, one answer, at once, with the instructions read
 *   from the prompt cache after the first request. The route every run takes
 *   unless told otherwise.
 * - `batch`: every request handed over together through the Message Batches
 *   API, answered within the hour as a rule and within a day at most, at
 *   half the listed price and with no rate limit to pace against.
 *
 * Direct is the default because it is the cheaper of the two as they are
 * sent here, and the one that has been run. The owner's first sample, 50
 * bookmarks on 2026-10-13, measured it: the instructions are nine tenths of
 * a request, and read from the cache they cost a tenth of the input price,
 * which comes to about $0.00012 a bookmark. A batch's requests are
 * processed side by side, where the cache is hit only when it happens to
 * be, so they are sent without it and pay half price on every token: about
 * $0.0002 a bookmark. Half price loses to a tenth.
 *
 * The batch route stays for a run large enough to be slowed by the rate
 * limit, where its lack of one is worth more than the difference: ask for it
 * with `--batch`. Its requests carry the same output schema as a direct
 * one's; Anthropic's documentation says the schema is enforced in a batch
 * too (the structured outputs page lists batch processing under "Works
 * with"), and no batch had been run from here when this was written. Should
 * one come back rejected, the run says so and records no bookmark as failed.
 */
export type Transport = "direct" | "batch";

export function chooseTransport(run: {
  /** The route the owner asked for by name, if any. */
  asked?: Transport | undefined;
}): Transport {
  return run.asked ?? "direct";
}
