import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The directory holding the database and the pairing token:
 * `CURIO_DATA_DIR` when set, otherwise `data/` at the repo root, which
 * git ignores.
 */
export function dataDirectory(): string {
  const configured = process.env.CURIO_DATA_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  let directory = process.cwd();
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        "Could not find the repo root above the working directory. Set CURIO_DATA_DIR to the directory that should hold the database.",
      );
    }
    directory = parent;
  }
  return join(directory, "data");
}
