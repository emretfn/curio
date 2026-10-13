/**
 * `pnpm screenshots`: takes the images the README shows, from the demo
 * library, into `docs/screenshots/`.
 *
 * It builds a demo library in a temporary directory, starts the app on it on
 * a free port, and drives Playwright's Chromium through the screens, once in
 * the light theme and once in the dark. Each image is taken at one fixed
 * viewport and at twice the density, so it is crisp on a high-density
 * display.
 *
 * The browser is started so that it cannot reach any host by name: every
 * hostname is made unresolvable, and the app is asked for by its address.
 * Any request a page makes to anywhere but the app is refused and reported,
 * and the run fails if there was one.
 *
 * `--no-build` takes the app as it was last built into the demo's directory,
 * which makes a second run a matter of seconds. `--only <name>` takes one
 * shot.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@x-bookmarks/core";
import { type Browser, chromium, type Page } from "playwright";
import {
  appIsBuilt,
  buildApp,
  DEMO_HOST,
  DEMO_PORT,
  freePort,
  portIsOpen,
  repoRoot,
  startApp,
  stopApp,
} from "./app.ts";
import { buildDemoLibrary, type DemoLibrary } from "./library.ts";

const OUTPUT = join(repoRoot, "docs/screenshots");
/** One viewport for every image. */
const VIEWPORT = { width: 1200, height: 800 };
/** Pixels to a CSS pixel. */
const DENSITY = 2;
const THEMES = ["light", "dark"] as const;

interface Shot {
  name: string;
  /** Where the screen is, given what the demo holds. */
  path: (demo: DemoLibrary) => string;
  /** What is done on the screen before the picture is taken. */
  prepare?: (page: Page, demo: DemoLibrary) => Promise<void>;
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

const SHOTS: Shot[] = [
  {
    name: "library",
    path: () => "/",
    prepare: listIsSettled,
  },
  {
    name: "search",
    // Typed without the dotless i, as on a keyboard that has none.
    path: () => "/?q=kisayol",
    prepare: listIsSettled,
  },
  {
    name: "labels",
    path: () => "/?cat=tools&tag=security",
    prepare: async (page) => {
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
    path: () => "/tags",
    prepare: async (page) => {
      await page.locator("[data-proposal]").first().waitFor();
    },
  },
  {
    name: "digest",
    path: ({ digestWeek }) => `/digest?week=${digestWeek.key}`,
    prepare: async (page) => {
      await page.getByTestId("digest-written").waitFor();
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
const store = openStore(join(scratch, "bookmarks.db"));
const demo = buildDemoLibrary(store);
store.close();

const port = await freePort();
const app = await startApp(scratch, port);
const origin = `http://${DEMO_HOST}:${port}`;
let browser: Browser | undefined;
const elsewhere: string[] = [];
const written: string[] = [];
try {
  browser = await chromium.launch({
    args: [
      // No name resolves, so the browser can reach nothing but this
      // computer: not a site, and not Chromium's own services.
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${DEMO_HOST}`,
      "--disable-background-networking",
      "--disable-component-update",
      // The page is the same from one run to the next.
      "--hide-scrollbars",
      "--font-render-hinting=none",
    ],
  });
  mkdirSync(OUTPUT, { recursive: true });
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DENSITY,
      colorScheme: theme,
      reducedMotion: "reduce",
      locale: "en-GB",
    });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(`${origin}/`)) return route.continue();
      elsewhere.push(url);
      return route.abort();
    });
    for (const shot of shots) {
      const page = await context.newPage();
      await page.goto(`${origin}${shot.path(demo)}`);
      await shot.prepare?.(page, demo);
      // The pointer is parked where it hovers over nothing.
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready);
      const file = join(OUTPUT, `${shot.name}-${theme}.png`);
      await page.screenshot({ path: file, animations: "disabled" });
      written.push(file);
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser?.close();
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
