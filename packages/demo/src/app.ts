/**
 * Starts the app on a demo library: the same Next.js app `pnpm app` runs,
 * told to keep its data in another directory and to answer on another port.
 *
 * Nothing of an app in real use is touched. The build goes into a directory
 * of its own, because rebuilding `.next` breaks an app that is serving from
 * it. The data directory is the demo's, so the pairing token and the `.env`
 * the app looks for are the demo's too: there is no key in it, and the app
 * sends nothing to anyone. The backups are pointed inside that directory
 * whatever the caller's environment says, so that a demo can never write
 * into, or push a snapshot out of, the owner's real backups.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const repoRoot = join(import.meta.dirname, "../../..");
const webDirectory = join(repoRoot, "packages/web");
const nextBinary = join(webDirectory, "node_modules/next/dist/bin/next");

/** The only address the app is ever started on: this computer, to itself. */
export const DEMO_HOST = "127.0.0.1";
/** Where `pnpm demo` listens unless told otherwise: beside the app's own port, and not it. */
export const DEMO_PORT = 47131;
/** The port the real app holds, which a demo is never started on. */
const REAL_APP_PORT = 47130;
/** Next's build directory for the demo and the screenshots, beside the one `pnpm app` serves from. */
export const NEXT_DIRECTORY = ".next-demo";

/** A port a demo may listen on, from what was typed, or undefined. */
export function demoPortOf(typed: string): number | undefined {
  if (!/^[1-9][0-9]{3,4}$/.test(typed)) return undefined;
  const port = Number(typed);
  return port >= 1024 && port <= 65535 && port !== REAL_APP_PORT
    ? port
    : undefined;
}

function environment(dataDirectory: string, port: number) {
  return {
    ...process.env,
    X_BOOKMARKS_DATA_DIR: dataDirectory,
    X_BOOKMARKS_BACKUP_DIR: join(dataDirectory, "backups"),
    X_BOOKMARKS_NEXT_DIR: NEXT_DIRECTORY,
    X_BOOKMARKS_PORT: String(port),
  };
}

export function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, DEMO_HOST);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, DEMO_HOST, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Whether the app has been built into the demo's own directory. */
export const appIsBuilt = () =>
  existsSync(join(webDirectory, NEXT_DIRECTORY, "BUILD_ID"));

/** Builds the app into the demo's own directory. It takes about a minute. */
export function buildApp(): void {
  execFileSync(process.execPath, [nextBinary, "build"], {
    cwd: webDirectory,
    env: environment(join(repoRoot, "demo-data"), DEMO_PORT),
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Starts the built app on a library, and returns once it is listening. */
export async function startApp(
  dataDirectory: string,
  port: number,
): Promise<ChildProcess> {
  if (port === REAL_APP_PORT) {
    throw new Error(`Port ${REAL_APP_PORT} is the real app's.`);
  }
  const app = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", DEMO_HOST, "--port", String(port)],
    {
      cwd: webDirectory,
      env: environment(dataDirectory, port),
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const deadline = Date.now() + 30_000;
  while (!(await portIsOpen(port))) {
    if (app.exitCode !== null || Date.now() > deadline) {
      app.kill();
      throw new Error(`The app did not start on port ${port}.`);
    }
    await sleep(100);
  }
  return app;
}

/** Stops an app this file started, and waits until it has gone. */
export async function stopApp(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const exited = new Promise((resolve) => app.once("exit", resolve));
  // Asked politely, Next waits for every open connection to end first.
  app.kill("SIGKILL");
  await exited;
}
