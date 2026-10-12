/**
 * Runs once as the Next.js server starts, before it answers anything.
 *
 * It starts the library's backups: one look now, and one an hour from then
 * on. See `src/server/backups.ts`. Nothing is done while Next is only
 * building the app, and nothing in the Edge runtime, which has no file
 * system.
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
}
