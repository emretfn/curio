/**
 * A vocabulary and a list of proposals for tests that build a request or
 * read the instructions without a library: invented, and never changed, so
 * that a fingerprint taken with it moves only when the wording does.
 */
import type { Asking } from "../instructions.ts";

export const SAMPLE_ASKING: Asking = {
  vocabulary: {
    version: 7,
    tags: ["ads", "auth", "nextjs", "react", "seo", "tailwind"],
    aliases: { reklam: "ads", "next.js": "nextjs", "kimlik-dogrulama": "auth" },
  },
  proposals: ["drizzle", "server-actions"],
};

/** The same vocabulary with nothing proposed and no other names. */
export const BARE_ASKING: Asking = {
  vocabulary: { ...SAMPLE_ASKING.vocabulary, aliases: {} },
  proposals: [],
};
