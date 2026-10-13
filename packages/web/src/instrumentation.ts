/**
 * Runs once as the Next.js server starts, before it answers anything.
 *
 * It starts the library's backups: one look now, and one an hour from then
 * on. See `src/server/backups.ts`. And it starts the tagging of new
 * bookmarks: a first pass shortly, for what arrived while the app was not
 * running, and one an hour from then on. See `src/server/tagging.ts`.
 * Nothing is done while Next is only building the app, and nothing in the
 * Edge runtime, which has no file system.
 */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  ) {
    return;
  }
  const { startBackups } = await import("./server/backups.ts");
  startBackups();
  const { startTagging } = await import("./server/tagging.ts");
  startTagging();
}
