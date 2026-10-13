/**
 * Every post of the demo library. All of them were written for it: none is
 * taken from, paraphrased from or modelled on a real post, and the accounts
 * they are written under are in `../authors.ts`.
 */
import type { PostSpec } from "../post-spec.ts";
import { AGENTS } from "./agents.ts";
import { BUSINESS } from "./business.ts";
import { DESIGN } from "./design.ts";
import { DIGEST_WEEK, SINCE } from "./latest.ts";
import { LIFE, OTHER } from "./life-and-other.ts";
import { MOBILE } from "./mobile.ts";
import { MODELS } from "./models.ts";
import { TOOLS } from "./tools.ts";
import { WEB } from "./web.ts";

export const POSTS: readonly PostSpec[] = [
  ...SINCE,
  ...DIGEST_WEEK,
  ...AGENTS,
  ...WEB,
  ...DESIGN,
  ...MODELS,
  ...BUSINESS,
  ...MOBILE,
  ...TOOLS,
  ...LIFE,
  ...OTHER,
];
