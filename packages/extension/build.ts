import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Chrome cannot run TypeScript, and a content script cannot import, so this
// is the one place the repo compiles: each entry point becomes one readable
// file under dist/, which is the directory to load unpacked.
//
// A directory given as the first argument is built into instead. The
// end-to-end test passes one of its own, because this build starts by
// emptying its target, and dist/ may be what a running Chrome has loaded.
const outdir = resolve(process.argv[2] ?? join(import.meta.dirname, "dist"));
const out = pathToFileURL(`${outdir}/`);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const shared = {
  bundle: true,
  target: "chrome130",
  outdir,
  absWorkingDir: import.meta.dirname,
  logLevel: "info",
} as const;

/** A file that ships as it is, at the same place under the target. */
const copied = (from: string, to: string = from.replace(/^src\//, "")) =>
  cp(new URL(`./${from}`, import.meta.url), new URL(to, out));

// The icons the manifest names. They are rendered from icons/icon.svg by
// `pnpm icons:build` and committed, so that this build needs no browser.
const manifest: { icons: Record<string, string> } = JSON.parse(
  await readFile(new URL("./manifest.json", import.meta.url), "utf8"),
);

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/page-hook.ts", "src/relay.ts", "src/popup.ts"],
    format: "iife",
  }),
  build({ ...shared, entryPoints: ["src/background.ts"], format: "esm" }),
  copied("manifest.json"),
  copied("src/popup.html"),
  copied("src/popup.css"),
  ...Object.values(manifest.icons).map((icon) => copied(icon)),
]);
