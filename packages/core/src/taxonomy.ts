/**
 * The taxonomy: the categories and the formats a bookmark can be filed
 * under, and the rules that decide between categories. This file is the one
 * place they are written down. The classifier's instructions are built from
 * it (`packages/tagger`), the filters check their values against it, and
 * the MCP server and the UI show its labels.
 *
 * To change it, edit `TAXONOMY` below and raise its `version`. A change is
 * anything at all: a label, a definition, a rule. The classifier is told
 * every word of it, so a bookmark classified before the change was
 * classified under other instructions, and the version stored with each
 * bookmark is how that stays visible. `taxonomy.test.ts` holds the
 * fingerprint of each version and fails when the two disagree. Nothing is
 * classified again by a change alone: `pnpm tag --retag` does that, when the
 * owner asks.
 *
 * The tags are not here. The tag vocabulary is the owner's to change while
 * the app runs, so it lives in the database and nowhere else: see
 * `vocabulary.ts`. What this file holds of tags is their shape and how many
 * a bookmark may have.
 *
 * An id (`ai-agents`, `guide`) is what the database stores. Keep ids when
 * rewording labels and definitions; a removed or renamed id leaves the
 * bookmarks stored under it outside every filter until they are classified
 * again.
 */
import { createHash } from "node:crypto";

export interface TaxonomyEntry {
  /** What is stored and filtered by. Lowercase words joined by hyphens. */
  readonly id: string;
  /** What a person reads. English; Turkish is handled by aliases. */
  readonly label: string;
  /** What belongs under it, as the classifier is told. */
  readonly definition: string;
}

export interface Taxonomy {
  readonly version: number;
  /** A bookmark has exactly one. */
  readonly categories: readonly TaxonomyEntry[];
  /** How the classifier decides between two categories that both seem to fit. */
  readonly boundaryRules: readonly string[];
  /** A bookmark has exactly one, whatever its category. */
  readonly formats: readonly TaxonomyEntry[];
  /** How many tags of the vocabulary a bookmark may have. */
  readonly maxTagsPerPost: number;
  /** How many tags outside the vocabulary the classifier may suggest for one post. */
  readonly maxProposedTagsPerPost: number;
}

/**
 * Where a bookmark goes when its stored text is too little to tell, or when
 * no other category fits. Its share is the taxonomy's health: see
 * `summariseTagging`.
 */
export const OTHER_CATEGORY = "other";
/** The format of a post whose stored text does not show what kind of post it is. */
export const UNCLEAR_FORMAT = "unclear";

export const TAXONOMY = {
  version: 1,
  categories: [
    {
      id: "ai-agents",
      label: "AI agents & coding",
      definition:
        "Working with AI agents and coding assistants themselves: setup, workflows, harnesses, general-purpose skills, model comparisons for coding, plans and limits.",
    },
    {
      id: "web-dev",
      label: "Web development",
      definition:
        "Web code you write or install: React and Next.js patterns, component libraries, starters, TypeScript and CSS techniques.",
    },
    {
      id: "design",
      label: "Design & UI",
      definition:
        "How things look and feel: inspiration galleries, design principles, motion, design tools, and skills that teach an agent design.",
    },
    {
      id: "ai-models",
      label: "AI models & media",
      definition:
        "AI that is not about agents or coding: model news, image and video generation, prompt recipes, assistant uses for everyday tasks.",
    },
    {
      id: "business",
      label: "Business & growth",
      definition:
        "Getting users and revenue from a product: app ideas, ASO, paywalls, ads, SEO, social growth, taxes and company setup.",
    },
    {
      id: "mobile-dev",
      label: "Mobile development",
      definition:
        "Building and shipping mobile apps: SwiftUI, Expo and React Native, Xcode, builds, App Store submission.",
    },
    {
      id: "tools",
      label: "Tools & infrastructure",
      definition:
        "What surrounds the code: hosting, self-hosting, databases, email, security, editor and terminal setup, desktop utilities.",
    },
    {
      id: "life",
      label: "Life & career",
      definition:
        "Not about building software: job hunting and CVs, learning, shopping and consumer tips, health, film and TV, humour.",
    },
    {
      id: OTHER_CATEGORY,
      label: "Other",
      definition:
        "Too little stored text to tell, or none of the above. Never a guess: when the text does not say, this is the answer.",
    },
  ],
  boundaryRules: [
    "Agent times domain: remove the agent from the post. If what is left is design, mobile, web, business or infrastructure, file it there and tag agent-skills or mcp. Use AI agents & coding only when what is left is the agent itself.",
    "AI agents versus AI models: harnesses, skills, plans and limits are agents; models, generated media, prompt recipes and chat-assistant uses are models.",
    "Web versus Design: code you install or copy is Web; things you look at or learn taste from are Design.",
    "Design versus AI models: generated icons, logos, mockups and code-rendered video are Design; other generated media is AI models.",
    "Mobile versus Business: building and shipping, including App Store Connect automation, is Mobile; downloads and revenue are Business.",
    "Web versus Tools: code inside the app, including auth and ORM, is Web; where it runs, the editor and security are Tools.",
  ],
  formats: [
    {
      id: "launch",
      label: "Launch",
      definition:
        "Its maker announces something others can now get, install or use: a product, a release, a feature, a model, a repository.",
    },
    {
      id: "guide",
      label: "Guide",
      definition:
        "Explains one thing itself, in several steps or at length: a tutorial, a walkthrough, a setup, a course, an article.",
    },
    {
      id: "resource-list",
      label: "Resource list",
      definition:
        "Points to several things elsewhere to pick from: links, tools, repositories, accounts or examples in one post.",
    },
    {
      id: "tip",
      label: "Tip",
      definition:
        "One technique that fits in the post: a trick, a setting, a command, a single prompt.",
    },
    {
      id: "showcase",
      label: "Showcase",
      definition:
        "Shows a piece of work to look at, with nothing to get: a demo, a design, something built, a before and after, someone else's work shown off.",
    },
    {
      id: "discussion",
      label: "Discussion",
      definition:
        "An opinion, a question, a comparison, a story, a joke or a reaction, with nothing to install or follow.",
    },
    {
      id: UNCLEAR_FORMAT,
      label: "Unclear",
      definition:
        "The stored text does not show what kind of post it is, as with a bare link, or a picture or video with a few words.",
    },
  ],
  maxTagsPerPost: 4,
  maxProposedTagsPerPost: 2,
} as const satisfies Taxonomy;

export type CategoryId = (typeof TAXONOMY.categories)[number]["id"];
export type FormatId = (typeof TAXONOMY.formats)[number]["id"];

/** A tag as the vocabulary writes one: lowercase letters and digits in words joined by hyphens. */
export const TAG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The longest tag, or suggestion for one, that is kept. */
export const MAX_TAG_LENGTH = 32;

/**
 * A tag as someone typed it, brought to the form tags and aliases are
 * compared in: lowercase, without accents and with the Turkish dotless i
 * read as i, without a leading `#`, and with each run of spaces or
 * underscores as one hyphen. "Görsel Üretimi" and "gorsel_uretimi" are the
 * same text after this.
 */
export function foldTagText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[ıİ]/g, "i")
    .toLowerCase()
    .trim()
    .replace(/^#+/, "")
    .replace(/[\s_]+/g, "-");
}

export const isCategoryId = (value: string): value is CategoryId =>
  TAXONOMY.categories.some(({ id }) => id === value);

export const isFormatId = (value: string): value is FormatId =>
  TAXONOMY.formats.some(({ id }) => id === value);

/**
 * A digest of everything in a taxonomy. Two taxonomies with the same
 * fingerprint tell the classifier the same thing.
 */
export function taxonomyFingerprint(taxonomy: Taxonomy = TAXONOMY): string {
  return createHash("sha256")
    .update(JSON.stringify(taxonomy))
    .digest("hex")
    .slice(0, 16);
}
