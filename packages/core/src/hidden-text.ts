/**
 * Characters that show as nothing and that a model still reads: the Unicode
 * tag block, which spells hidden ASCII, and the supplementary variation
 * selectors, which can carry hidden bytes. A post could use them to hold
 * text its reader never saw.
 */
const HIDDEN = /[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

/**
 * The text without those characters. Everything from a post that is handed
 * to a model goes through this: what the MCP server returns, and what the
 * classifier is sent. The cost is that a flag made of tag characters
 * (England, Scotland, Wales) shows as a plain black flag.
 *
 * It is narrow on purpose. A post is passed on as its author wrote it, and
 * the other characters that show as nothing are part of how real posts are
 * written: the zero-width joiner holds an emoji family together and shapes
 * Indic scripts, the zero-width non-joiner is ordinary Persian spelling,
 * and direction marks keep a mixed Arabic and English line in order. None
 * of them spells text a reader cannot see, which is what this is for.
 * Widening it would also change what the classifier is sent, for every
 * post, and so its instructions version (LAB-3).
 *
 * Prose a model wrote is held to more: `digests.ts` takes every format
 * character out of a digest, because nothing in a summary needs one and
 * each is a way to split an address in two or to show a reader something
 * other than what is stored.
 */
export function visibleText(text: string): string {
  return text.replace(HIDDEN, "");
}
