/**
 * `pnpm diagram`: exports the README's architecture diagram from its source,
 * `docs/architecture/architecture.html`, to a light and a dark PNG beside it.
 *
 * The source is one page for both themes: its colours are redefined under
 * `prefers-color-scheme`, so the page is rendered once in each. Only the
 * diagram is captured, at one CSS pixel to a unit of its `viewBox` and twice
 * the density, which is the export the diagram's design system describes.
 *
 * The page is a local file with no web font and no other request in it, and
 * the browser is started so that no hostname resolves.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { repoRoot } from "./app.ts";

const DIRECTORY = join(repoRoot, "docs/architecture");
const SOURCE = join(DIRECTORY, "architecture.html");
/** Pixels to a unit of the diagram. */
const DENSITY = 2;

const browser = await chromium.launch({
  args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--font-render-hinting=none"],
});
const written: string[] = [];
try {
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      deviceScaleFactor: DENSITY,
      colorScheme: theme,
    });
    const elsewhere: string[] = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("file:")) return route.continue();
      elsewhere.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(pathToFileURL(SOURCE).href);
    await page.evaluate(() => document.fonts.ready);
    const svg = page.locator("svg").first();
    await svg.evaluate((element) => {
      const box = (element as SVGSVGElement).viewBox.baseVal;
      if (!(box.width > 0 && box.height > 0)) {
        throw new Error("The diagram has no viewBox to take its size from.");
      }
      // One CSS pixel to a unit, whatever the page's own layout says.
      for (const [axis, size] of [
        ["width", box.width],
        ["height", box.height],
      ] as const) {
        for (const prefix of ["", "min-", "max-"]) {
          (element as SVGSVGElement).style.setProperty(
            prefix + axis,
            `${size}px`,
            "important",
          );
        }
      }
      // Nothing above the diagram may clip it.
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        parent.style.setProperty("overflow", "visible", "important");
      }
    });
    const file = join(DIRECTORY, `architecture-${theme}.png`);
    await svg.screenshot({ path: file, omitBackground: true });
    written.push(file);
    await context.close();
    if (elsewhere.length > 0) {
      throw new Error(
        `The diagram's page asked for something that is not a local file: ${elsewhere.join(", ")}`,
      );
    }
  }
} finally {
  await browser.close();
}

// Smaller where `pngquant` is installed; the files are fine without it.
try {
  execFileSync(
    "pngquant",
    [
      "--force",
      "--skip-if-larger",
      "--ext",
      ".png",
      "--speed",
      "1",
      ...written,
    ],
    { stdio: "ignore" },
  );
} catch {
  // Not installed, or the file is better left as it is.
}
for (const file of written) {
  console.log(
    `${file.slice(repoRoot.length + 1)}  ${Math.round(statSync(file).size / 1024)} kB`,
  );
}
