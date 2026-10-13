/**
 * Renders the mark, `packages/extension/icons/icon.svg`, into the PNGs the
 * extension's manifest names, and copies it to the web app as its icon, so
 * that the toolbar and the tab show the same thing. Run it with
 * `pnpm icons:build` after changing the SVG. What it writes is committed:
 * building the extension needs no browser.
 *
 * It lives in this package because the rasteriser is the test browser this
 * package already depends on, the same Chromium that will draw the icon in
 * a toolbar. That browser is started offline and resolving no hostname, with
 * scripts off; it is handed the SVG as text and asked for pictures of it.
 */
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const repoRoot = join(import.meta.dirname, "../../..");
const extensionDirectory = join(repoRoot, "packages/extension");
const source = join(extensionDirectory, "icons/icon.svg");
const webIcon = join(repoRoot, "packages/web/src/app/icon.svg");
/** Which SVG the PNGs were rendered from. `icons.test.ts` reads it. */
const renderedFrom = join(extensionDirectory, "icons/rendered-from.sha256");

/** The sizes are the manifest's: each entry of `icons` is a file to write. */
const manifest: { icons: Record<string, string> } = JSON.parse(
  readFileSync(join(extensionDirectory, "manifest.json"), "utf8"),
);
const svg = readFileSync(source, "utf8");

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
});
try {
  const context = await browser.newContext({
    offline: true,
    javaScriptEnabled: false,
    deviceScaleFactor: 1,
  });
  for (const [size, path] of Object.entries(manifest.icons)) {
    const pixels = Number(size);
    const page = await context.newPage();
    await page.setViewportSize({ width: pixels, height: pixels });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${pixels}px;height:${pixels}px}</style>${svg}`,
    );
    await page.screenshot({
      path: join(extensionDirectory, path),
      type: "png",
      omitBackground: true,
    });
    await page.close();
    console.log(`${path}: ${pixels} by ${pixels}`);
  }
} finally {
  await browser.close();
}

copyFileSync(source, webIcon);
writeFileSync(
  renderedFrom,
  `${createHash("sha256").update(svg).digest("hex")}\n`,
);
console.log("packages/web/src/app/icon.svg: copied");
