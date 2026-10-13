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
import { APP_PORT } from "@curio/extension";

export const repoRoot = join(import.meta.dirname, "../../..");
export const webDirectory = join(repoRoot, "packages/web");
const nextBinary = join(webDirectory, "node_modules/next/dist/bin/next");

/** The only address the app is ever started on: this computer, to itself. */
export const DEMO_HOST = "127.0.0.1";
/** Where `pnpm demo` listens unless told otherwise: beside the app's own port, and not it. */
export const DEMO_PORT = 47131;
/** The port the real app holds, which nothing here ever listens on. */
export const REAL_APP_PORT = APP_PORT;
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

/**
 * What a command of the app's is run with on a demo library. `answersAt` is
 * the port the app takes for its own in the address it answers to: the one
 * it listens on, for a demo; or the real app's, for the screenshots, whose
 * browser is told that the real address leads to this app, so that the
 * extension can be paired with it.
 */
export function demoEnvironment(
  dataDirectory: string,
  answersAt: number = REAL_APP_PORT,
): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  delete inherited.CURIO_PORT;
  return {
    ...inherited,
    CURIO_DATA_DIR: dataDirectory,
    CURIO_BACKUP_DIR: join(dataDirectory, "backups"),
    CURIO_NEXT_DIR: NEXT_DIRECTORY,
    // Next's own usage reports, which the app's config switches off as well.
    NEXT_TELEMETRY_DISABLED: "1",
    ...(answersAt === REAL_APP_PORT ? {} : { CURIO_PORT: String(answersAt) }),
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
    env: demoEnvironment(join(repoRoot, "demo-data"), DEMO_PORT),
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/**
 * Starts the built app on a library, and returns once it is listening. It
 * never listens on the real app's port. With `asTheRealAddress` it answers
 * to the real app's address all the same, for a browser that has been told
 * that address leads here.
 */
export async function startApp(
  dataDirectory: string,
  port: number,
  { asTheRealAddress = false } = {},
): Promise<ChildProcess> {
  if (port === REAL_APP_PORT) {
    throw new Error(`Port ${REAL_APP_PORT} is the real app's.`);
  }
  const app = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", DEMO_HOST, "--port", String(port)],
    {
      cwd: webDirectory,
      env: demoEnvironment(
        dataDirectory,
        asTheRealAddress ? REAL_APP_PORT : port,
      ),
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
