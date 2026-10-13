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
 */
export function visibleText(text: string): string {
  return text.replace(HIDDEN, "");
}
