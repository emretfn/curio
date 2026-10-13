import { expect, test } from "vitest";
import { upsertBookmark } from "./bookmarks.ts";
import { recordClassification } from "./labels.ts";
import { listBookmarks } from "./library.ts";
import { listTagProposals, MAX_TAG_PROPOSALS } from "./proposals.ts";
import { insertRawCapture } from "./raw-captures.ts";
import type { Store } from "./store.ts";
import { openTempStore } from "./testing/temp-database.ts";
import { acceptTagProposal, dismissTagProposal } from "./vocabulary.ts";

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
const postId = (n: number) => String(1975000000000000000n + BigInt(n));

/**
 * A library in which bookmark n was classified on day n of the month and
 * given the proposals at position n - 1 of `proposals`.
 */
function proposing(...proposals: string[][]): Store {
  const store = openTempStore();
  const captureId = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: new Date("2026-09-30T09:00:00.000Z"),
  }).id;
  proposals.forEach((proposedTags, index) => {
    const n = index + 1;
    upsertBookmark(store, {
      postId: postId(n),
      authorId: String(1000 + n),
      authorHandle: `author${n}`,
      authorName: `Author ${n}`,
      text: `post ${n}`,
      postedAt: new Date("2026-01-01T00:00:00.000Z"),
      captureId,
    });
    recordClassification(store, {
      postId: postId(n),
      category: "web-dev",
      format: "guide",
      tags: [],
      proposedTags,
      tooLittleText: false,
      instructionsVersion: 1,
      model: "a-model",
      classifiedAt: day(n),
    });
  });
  return store;
}

const names = (store: Store, options = {}) =>
  listTagProposals(store, options).proposals.map(({ proposal }) => proposal);

test("a proposal is listed with how many bookmarks it was made for, the most proposed first", () => {
  const store = proposing(
    ["bun"],
    ["bun", "drizzle"],
    ["bun"],
    ["drizzle"],
    ["htmx"],
  );

  expect(listTagProposals(store)).toEqual({
    total: 3,
    belowThreshold: 0,
    proposals: [
      {
        proposal: "bun",
        bookmarks: 3,
        variants: [{ proposal: "bun", bookmarks: 3 }],
        similarTags: [],
        lastProposedAt: day(3),
      },
      {
        proposal: "drizzle",
        bookmarks: 2,
        variants: [{ proposal: "drizzle", bookmarks: 2 }],
        similarTags: [],
        lastProposedAt: day(4),
      },
      {
        proposal: "htmx",
        bookmarks: 1,
        variants: [{ proposal: "htmx", bookmarks: 1 }],
        similarTags: [],
        lastProposedAt: day(5),
      },
    ],
  });
});

test("a threshold leaves out what was proposed too seldom, and says how much that is", () => {
  const store = proposing(
    ["bun"],
    ["bun", "drizzle"],
    ["bun"],
    ["drizzle"],
    ["htmx"],
    ["zig"],
  );

  expect(listTagProposals(store, { minBookmarks: 2 })).toMatchObject({
    total: 2,
    belowThreshold: 2,
  });
  expect(names(store, { minBookmarks: 2 })).toEqual(["bun", "drizzle"]);
  expect(names(store, { minBookmarks: 3 })).toEqual(["bun"]);
  expect(names(store, { minBookmarks: 4 })).toEqual([]);
});

test("near-duplicates are one group, counted by the bookmarks any of them was made for", () => {
  const store = proposing(
    ["amp"],
    ["amp-code"],
    ["amp", "amp-code"],
    ["shannon-pentest"],
    ["ai-pentesting"],
    ["next-auth"],
    ["nextauth"],
    ["bun"],
  );

  const { proposals, total } = listTagProposals(store);

  expect(total).toBe(4);
  expect(
    proposals.map(({ proposal, bookmarks, variants }) => ({
      proposal,
      bookmarks,
      variants: variants.map(
        (variant) => `${variant.proposal} ${variant.bookmarks}`,
      ),
    })),
  ).toEqual([
    // Three bookmarks between the two names, one of which had both.
    { proposal: "amp", bookmarks: 3, variants: ["amp 2", "amp-code 2"] },
    // The same word under two endings.
    {
      proposal: "ai-pentesting",
      bookmarks: 2,
      variants: ["ai-pentesting 1", "shannon-pentest 1"],
    },
    // The same letters, with and without the hyphen.
    {
      proposal: "nextauth",
      bookmarks: 2,
      variants: ["nextauth 1", "next-auth 1"],
    },
    { proposal: "bun", bookmarks: 1, variants: ["bun 1"] },
  ]);
  // A group over the threshold is listed whole, though no one name reaches it.
  expect(names(store, { minBookmarks: 2 })).toEqual([
    "amp",
    "ai-pentesting",
    "nextauth",
  ]);
});

test("a word many names share ties none of them together", () => {
  const store = proposing(
    ["ai-video"],
    ["ai-music"],
    ["ai-writing"],
    ["app-review"],
    ["app-icons"],
    ["server-actions"],
    ["server-components"],
    ["server-islands"],
    ["server-functions"],
    ["server-sent-events"],
  );

  // "ai" and "app" are too common anywhere; "server" is too common here.
  expect(listTagProposals(store).total).toBe(10);
  for (const { variants } of listTagProposals(store).proposals) {
    expect(variants).toHaveLength(1);
  }
});

test("a proposal that resembles a tag of the vocabulary says which, as a hint and nothing more", () => {
  const store = proposing(
    ["mcp-servers"],
    ["tailwindcss"],
    ["tailwind-css"],
    ["zig"],
  );

  const byName = new Map(
    listTagProposals(store).proposals.map((proposal) => [
      proposal.proposal,
      proposal,
    ]),
  );

  expect(byName.get("mcp-servers")?.similarTags).toEqual(["mcp"]);
  // One name of the group holds the tag's own word; the group resembles it.
  expect(byName.get("tailwindcss")?.similarTags).toEqual(["tailwind"]);
  expect(
    byName.get("tailwindcss")?.variants.map(({ proposal }) => proposal),
  ).toEqual(["tailwindcss", "tailwind-css"]);
  expect(byName.get("zig")?.similarTags).toEqual([]);
  // Nothing was put on any bookmark by being listed.
  expect(listBookmarks(store, { tags: ["mcp"] }).total).toBe(0);
});

test("a week's review asks for what was proposed since, and a group counts if any of its names was", () => {
  const store = proposing(["amp"], ["bun"], ["drizzle"], ["amp-code"]);

  expect(names(store, { proposedSince: day(3) })).toEqual(["amp", "drizzle"]);
  expect(
    listTagProposals(store, { proposedSince: day(3) }).proposals[0],
  ).toMatchObject({
    proposal: "amp",
    bookmarks: 2,
    lastProposedAt: day(4),
  });
  expect(names(store, { proposedSince: day(9) })).toEqual([]);
});

test("the list is read a page at a time", () => {
  const store = proposing(["bun"], ["bun", "drizzle"], ["htmx"], ["zig"]);

  expect(names(store, { limit: 2 })).toEqual(["bun", "drizzle"]);
  expect(names(store, { limit: 2, offset: 2 })).toEqual(["htmx", "zig"]);
  expect(listTagProposals(store, { limit: 2, offset: 2 }).total).toBe(4);
  for (const options of [
    { limit: 0 },
    { limit: MAX_TAG_PROPOSALS + 1 },
    { offset: -1 },
    { minBookmarks: 0 },
  ]) {
    expect(() => listTagProposals(store, options)).toThrow(RangeError);
  }
});

test("a proposal that was accepted or dismissed is no longer listed, and one dismissed does not come back", () => {
  const store = proposing(["amp"], ["amp-code"], ["hot-take"], ["bun"]);

  acceptTagProposal(store, "amp", { variants: ["amp-code"] });
  dismissTagProposal(store, "hot-take");
  recordClassification(store, {
    postId: postId(4),
    category: "web-dev",
    format: "guide",
    tags: [],
    proposedTags: ["hot-take", "amp-code"],
    tooLittleText: false,
    instructionsVersion: 1,
    model: "a-model",
  });

  expect(listTagProposals(store)).toMatchObject({ total: 0, proposals: [] });
  expect(listBookmarks(store, { tags: ["amp"] }).total).toBe(3);
});

test("an empty library has no proposals", () => {
  expect(listTagProposals(openTempStore())).toEqual({
    total: 0,
    belowThreshold: 0,
    proposals: [],
  });
});
