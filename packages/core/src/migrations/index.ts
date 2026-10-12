import type { Migration } from "../migrate.ts";
import { migration as init } from "./0001-init.ts";

/** Every migration, in the order it is applied. Append only. */
export const migrations: readonly Migration[] = [init];
