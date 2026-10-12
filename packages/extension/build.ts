import { cp, mkdir, rm } from "node:fs/promises";
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

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/page-hook.ts", "src/relay.ts", "src/popup.ts"],
    format: "iife",
  }),
  build({ ...shared, entryPoints: ["src/background.ts"], format: "esm" }),
  cp(
    new URL("./manifest.json", import.meta.url),
    new URL("manifest.json", out),
  ),
  cp(new URL("./src/popup.html", import.meta.url), new URL("popup.html", out)),
]);
