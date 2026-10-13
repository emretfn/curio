/**
 * `pnpm screenshots`: takes the images the README shows, from the demo
 * library and the built extension, into `docs/screenshots/`.
 *
 * It builds a demo library in a temporary directory, starts the app on it on
 * a free port, builds the extension into the same directory, and drives
 * Playwright's Chromium with that extension loaded: through five screens of
 * the app, and through two states of the extension's popup, each once in the
 * light theme and once in the dark. Every image is taken at twice the
 * density, so it is crisp on a high-density display.
 *
 * The browser is told that the app's real address leads to this run's app,
 * as the end-to-end test's is, so that the extension pairs with it exactly
 * as it would with the real one; nothing here listens on the real port. No
 * other name resolves, so the browser can reach nothing but this computer,
 * and the run fails if a page asks for anything but the app.
 *
 * `--no-build` takes the app as it was last built into the demo's
 * directory, which makes a second run a matter of seconds. `--only <name>`
 * takes one shot.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@x-bookmarks/core";
import { APP_ORIGIN, EXTENSION_ID } from "@x-bookmarks/extension";
import { type BrowserContext, chromium, type Page } from "playwright";
import {
  appIsBuilt,
  buildApp,
  DEMO_HOST,
  DEMO_PORT,
  demoEnvironment,
  freePort,
  portIsOpen,
  REAL_APP_PORT,
  repoRoot,
  startApp,
  stopApp,
  webDirectory,
} from "./app.ts";
import { buildDemoLibrary, type DemoLibrary } from "./library.ts";

const OUTPUT = join(repoRoot, "docs/screenshots");
/** One viewport for every screen of the app. */
const VIEWPORT = { width: 1200, height: 800 };
/** The popup's own width; its height is whatever its state takes. */
const POPUP_VIEWPORT = { width: 344, height: 480 };
/** Pixels to a CSS pixel. */
const DENSITY = 2;
const THEMES = ["light", "dark"] as const;
const POPUP = `chrome-extension://${EXTENSION_ID}/popup.html`;

/** What the extension's service worker has of Chrome, as far as this file uses it. */
declare const chrome: {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
};

interface Run {
  context: BrowserContext;
  demo: DemoLibrary;
  /** The pairing token of this run's app, as `pnpm pair` prints it. */
  token: string;
}

interface Shot {
  name: string;
  /** Opens the page and brings it to what the picture is of. */
  open: (page: Page, run: Run) => Promise<void>;
  /** The popup is pictured as it is, whatever its height; a screen of the app at the viewport. */
  popup?: true;
}

/** The library's list is drawn row by row after it arrives; a picture waits for that. */
async function listIsSettled(page: Page): Promise<void> {
  await page.getByTestId("result-count").waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-list="static"]') === null,
  );
  await page.evaluate(async () => {
    const places = () =>
      `${[...document.querySelectorAll("[data-row]")]
        .map((row) => Math.round(row.getBoundingClientRect().top))
        .join(",")}/${document.documentElement.scrollHeight}`;
    let last = "";
    let still = 0;
    for (let frame = 0; frame < 240 && still < 6; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = places();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  });
}

const popupIs = (page: Page, state: string) =>
  page.locator(`#status[data-state="${state}"]`).waitFor();

const SHOTS: Shot[] = [
  {
    name: "library",
    open: async (page) => {
      await page.goto(`${APP_ORIGIN}/`);
      await listIsSettled(page);
    },
  },
  {
    name: "search",
    open: async (page) => {
      // Typed without the dotless i, as on a keyboard that has none.
      await page.goto(`${APP_ORIGIN}/?q=kisayol`);
      await listIsSettled(page);
    },
  },
  {
    name: "labels",
    open: async (page) => {
      await page.goto(`${APP_ORIGIN}/?cat=tools&tag=security`);
      await listIsSettled(page);
      // The first post's category, opened from the keyboard as its owner
      // would. It is one the demo's owner refiled, and the menu says so.
      await page.keyboard.press("j");
      await page.keyboard.press("c");
      await page.getByRole("menu").waitFor();
      await page.waitForFunction(
        () => document.activeElement?.closest('[role="menu"]') != null,
      );
    },
  },
  {
    name: "tags",
    open: async (page) => {
      await page.goto(`${APP_ORIGIN}/tags`);
      await page.locator("[data-proposal]").first().waitFor();
    },
  },
  {
    name: "digest",
    open: async (page, { demo }) => {
      await page.goto(`${APP_ORIGIN}/digest?week=${demo.digestWeek.key}`);
      await page.getByTestId("digest-written").waitFor();
    },
  },
  {
    // A fresh install: the popup says how to pair. Taken before the next.
    name: "popup-not-paired",
    popup: true,
    open: async (page) => {
      await page.goto(POPUP);
      await popupIs(page, "not-paired");
    },
  },
  {
    // Paired with the app for real, with the token `pnpm pair` prints. The
    // counts are then written into the extension's own storage, to the
    // number of captures the demo library holds: those were not taken by
    // this extension, and no page of X's is opened here to take others.
    name: "popup-paired",
    popup: true,
    open: async (page, { context, demo, token }) => {
      await page.goto(POPUP);
      await popupIs(page, "not-paired");
      await page.locator("#token").fill(token);
      await page.keyboard.press("Enter");
      await popupIs(page, "ready");
      const [worker] = context.serviceWorkers();
      if (worker === undefined) {
        throw new Error("The extension's service worker is not running.");
      }
      await worker.evaluate(
        ([captured, at]) =>
          chrome.storage.local.set({
            stats: {
              captured,
              lastCapturedAt: at,
              lastDeliveredAt: at,
              lastError: null,
            },
          }),
        [demo.captures, Date.now() - 4 * 60_000] as const,
      );
      await page.goto(POPUP);
      await popupIs(page, "up-to-date");
    },
  },
];

function options(args: string[]): { build: boolean; only: string | null } {
  let build = true;
  let only: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-build") build = false;
    else if (arg === "--only" && args[index + 1] !== undefined) {
      only = args[index + 1] ?? null;
      index += 1;
    } else {
      console.error(
        `pnpm screenshots [--no-build] [--only ${SHOTS.map(({ name }) => name).join("|")}]`,
      );
      process.exit(1);
    }
  }
  return { build, only };
}

/** Makes the files smaller where `pngquant` is installed; they are fine without it. */
function shrink(files: string[]): boolean {
  try {
    execFileSync(
      "pngquant",
      [
        "--force",
        "--skip-if-larger",
        "--ext",
        ".png",
        "--quality",
        "80-98",
        "--speed",
        "1",
        ...files,
      ],
      { stdio: "ignore" },
    );
    return true;
  } catch (error) {
    // Status 98 and 99 are pngquant saying a file is better left as it is.
    const { status } = error as { status?: number };
    return status === 98 || status === 99;
  }
}

const { build, only } = options(process.argv.slice(2));
const shots = SHOTS.filter(({ name }) => only === null || name === only);
if (shots.length === 0) {
  console.error(`There is no shot named ${only}.`);
  process.exit(1);
}

if (build || !appIsBuilt()) {
  if (await portIsOpen(DEMO_PORT)) {
    console.error(
      `Something is listening on ${DEMO_HOST}:${DEMO_PORT}, which is where pnpm demo runs. It serves from the directory this would build into, so stop it first, or pass --no-build to take the app as it was last built.`,
    );
    process.exit(1);
  }
  console.log("Building the app.");
  buildApp();
}

const scratch = mkdtempSync(join(tmpdir(), "x-bookmarks-screenshots-"));
const data = join(scratch, "data");
const extension = join(scratch, "extension");
mkdirSync(data, { mode: 0o700 });
const store = openStore(join(data, "bookmarks.db"));
const demo = buildDemoLibrary(store);
store.close();
// The extension, built into this run's own directory: the build empties its
// target, and `dist/` may be what a running Chrome has loaded.
execFileSync(process.execPath, ["build.ts", extension], {
  cwd: join(repoRoot, "packages/extension"),
  stdio: ["ignore", "ignore", "inherit"],
});
// The token, as its owner gets it: from the terminal, by the app's own command.
const token =
  /^ {2}(\S{20,})$/m.exec(
    execFileSync(process.execPath, ["pair.ts"], {
      cwd: webDirectory,
      env: demoEnvironment(data),
      encoding: "utf8",
    }),
  )?.[1] ?? "";
if (token === "") throw new Error("The app printed no pairing token.");

const port = await freePort();
const app = await startApp(data, port, { asTheRealAddress: true });
let context: BrowserContext | undefined;
const elsewhere: string[] = [];
const written: string[] = [];
try {
  context = await chromium.launchPersistentContext(join(scratch, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: DENSITY,
    reducedMotion: "reduce",
    locale: "en-GB",
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      // The app's real address leads to this run's app, and no name
      // resolves at all: the browser can reach nothing but this computer.
      `--host-resolver-rules=MAP ${DEMO_HOST}:${REAL_APP_PORT} ${DEMO_HOST}:${port}, MAP * ~NOTFOUND`,
      "--disable-background-networking",
      "--disable-component-update",
      "--hide-scrollbars",
      "--font-render-hinting=none",
    ],
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (
      url.startsWith(`${APP_ORIGIN}/`) ||
      url.startsWith("chrome-extension:")
    ) {
      return route.continue();
    }
    elsewhere.push(url);
    return route.abort();
  });
  if (context.serviceWorkers().length === 0) {
    await context.waitForEvent("serviceworker");
  }
  mkdirSync(OUTPUT, { recursive: true });
  for (const shot of shots) {
    const page = await context.newPage();
    if (shot.popup) await page.setViewportSize(POPUP_VIEWPORT);
    await page.emulateMedia({ colorScheme: "light" });
    await shot.open(page, { context, demo, token });
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });
      // The pointer is parked where it hovers over nothing, and the theme
      // has a frame or two to be drawn in.
      await page.mouse.move(0, 0);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const file = join(OUTPUT, `${shot.name}-${theme}.png`);
      if (shot.popup) {
        await page.locator("body").screenshot({ path: file });
      } else {
        await page.screenshot({ path: file, animations: "disabled" });
      }
      written.push(file);
    }
    await page.close();
  }
} finally {
  await context?.close();
  await stopApp(app);
  rmSync(scratch, { recursive: true, force: true });
}

if (elsewhere.length > 0) {
  console.error(
    `The pages asked for something outside the app, which was refused:\n${[...new Set(elsewhere)].join("\n")}`,
  );
  process.exit(1);
}
const shrunk = shrink(written);
for (const file of written) {
  console.log(
    `${file.slice(repoRoot.length + 1)}  ${Math.round(statSync(file).size / 1024)} kB`,
  );
}
if (!shrunk) {
  console.log(
    "pngquant is not installed, so the files are as the browser wrote them. Install it and run this again to make them smaller.",
  );
}
