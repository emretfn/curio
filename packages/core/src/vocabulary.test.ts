import { expect, test } from "vitest";
import { getBookmark, upsertBookmark } from "./bookmarks.ts";
import {
  correctBookmark,
  type NewClassification,
  recordClassification,
} from "./labels.ts";
import { listBookmarks, summariseLibrary } from "./library.ts";
import { listTagProposals } from "./proposals.ts";
import { insertRawCapture } from "./raw-captures.ts";
import { connectionOf, type Store } from "./store.ts";
import { openTempStore } from "./testing/temp-database.ts";
import {
  acceptTagProposal,
  addTag,
  addTagAlias,
  dismissTagProposal,
  getVocabulary,
  listTags,
  mergeTags,
  removeTagAlias,
  renameTag,
  resolveTag,
  retireTag,
  settleTagProposals,
} from "./vocabulary.ts";

const at = (hour: number) => new Date(Date.UTC(2026, 9, 14, hour));
const postId = (n: number) => String(1975000000000000000n + BigInt(n));

/** A library of `count` bookmarks, numbered from 1. */
function library(count: number): Store {
  const store = openTempStore();
  const captureId = insertRawCapture(store, {
    source: "x-web-client",
    operation: "Bookmarks",
    payload: "{}",
    receivedAt: new Date("2026-10-05T09:00:00.000Z"),
  }).id;
  for (let n = 1; n <= count; n += 1) {
    upsertBookmark(store, {
      postId: postId(n),
      authorId: String(1000 + n),
      authorHandle: `author${n}`,
      authorName: `Author ${n}`,
      text: `post ${n}`,
      postedAt: new Date("2026-01-01T00:00:00.000Z"),
      captureId,
    });
  }
  return store;
}

const classify = (
  store: Store,
  n: number,
  parts: Partial<NewClassification> = {},
) =>
  recordClassification(store, {
    postId: postId(n),
    category: "web-dev",
    format: "guide",
    tags: [],
    tooLittleText: false,
    instructionsVersion: 1,
    model: "a-model",
    ...parts,
  });

const tagsOf = (store: Store, n: number) =>
  getBookmark(store, postId(n))?.labels.tags;
const proposalsOf = (store: Store, n: number) =>
  getBookmark(store, postId(n))?.labels.classification?.proposedTags;
const open = (store: Store) =>
  listTagProposals(store).proposals.flatMap(({ variants }) =>
    variants.map(({ proposal }) => proposal),
  );
const history = (store: Store) =>
  connectionOf(store)
    .prepare(
      "SELECT version, change, tag, other FROM vocabulary_changes WHERE version > 1",
    )
    .all();

test("the owner adds a tag with nothing edited: it joins the vocabulary, a filter knows it, and the version moves", () => {
  const store = library(1);
  const before = getVocabulary(store);

  const added = addTag(store, "Drizzle ORM", { now: at(1) });

  expect(added).toEqual({
    tag: "drizzle-orm",
    bookmarks: 0,
    vocabularyVersion: before.version + 1,
  });
  expect(getVocabulary(store).tags).toEqual(
    [...before.tags, "drizzle-orm"].toSorted(),
  );
  expect(resolveTag(store, "drizzle orm")).toBe("drizzle-orm");
  expect(listTags(store).find(({ tag }) => tag === "drizzle-orm")).toEqual({
    tag: "drizzle-orm",
    origin: "owner",
    addedAt: at(1),
    retiredAt: null,
    bookmarks: 0,
    aliases: [],
  });
  expect(listBookmarks(store, { tags: ["drizzle-orm"] }).total).toBe(0);
  expect(history(store)).toEqual([
    { version: 2, change: "add", tag: "drizzle-orm", other: null },
  ]);
});

test.each(["", "two!", "a".repeat(40), "next.js", "-x"])(
  '"%s" cannot be a tag',
  (name) => {
    expect(() => addTag(library(0), name)).toThrow(/cannot be a tag/);
  },
);

test("a name that is already a tag, or another way of writing one, is refused", () => {
  const store = library(0);

  expect(() => addTag(store, "React")).toThrow(/already a tag/);
  expect(() => addTag(store, "reklam")).toThrow(
    /another way of writing the tag "ads"/,
  );
  expect(getVocabulary(store).version).toBe(1);
});

test("accepting a proposal makes it a tag and puts it on the bookmarks that prompted it, and on no other", () => {
  const store = library(4);
  classify(store, 1, { tags: ["react"], proposedTags: ["drizzle"] });
  classify(store, 2, { proposedTags: ["drizzle", "bun"] });
  classify(store, 3, { tags: ["react"] });

  const accepted = acceptTagProposal(store, "drizzle");

  expect(accepted).toMatchObject({ tag: "drizzle", bookmarks: 2 });
  expect(tagsOf(store, 1)).toEqual(["drizzle", "react"]);
  expect(tagsOf(store, 2)).toEqual(["drizzle"]);
  expect(tagsOf(store, 3)).toEqual(["react"]);
  expect(tagsOf(store, 4)).toEqual([]);
  expect(proposalsOf(store, 2)).toEqual(["bun"]);
  expect(open(store)).toEqual(["bun"]);
  expect(listBookmarks(store, { tags: ["drizzle"] }).total).toBe(2);
  // From then on the classifier can give it, and its proposing it gives it.
  classify(store, 4, { tags: ["drizzle"] });
  classify(store, 3, { proposedTags: ["Drizzle"] });
  expect(tagsOf(store, 3)).toEqual(["drizzle"]);
});

test("a proposal is accepted under a better name, together with its near-duplicates, which become other ways of writing it", () => {
  const store = library(3);
  classify(store, 1, { proposedTags: ["amp"] });
  classify(store, 2, { proposedTags: ["amp-code"] });
  classify(store, 3, { proposedTags: ["ampcode", "bun"] });

  const accepted = acceptTagProposal(store, "amp", {
    as: "amp-agent",
    variants: ["amp-code", "ampcode"],
  });

  expect(accepted).toMatchObject({ tag: "amp-agent", bookmarks: 3 });
  for (const n of [1, 2, 3]) expect(tagsOf(store, n)).toEqual(["amp-agent"]);
  expect(
    listTags(store).find(({ tag }) => tag === "amp-agent")?.aliases,
  ).toEqual(["amp", "amp-code", "ampcode"]);
  expect(resolveTag(store, "Amp Code")).toBe("amp-agent");
  expect(open(store)).toEqual(["bun"]);
});

test("a proposal accepted as a tag the vocabulary already holds becomes another way of writing that tag", () => {
  const store = library(2);
  classify(store, 1, { tags: ["react"], proposedTags: ["nextauth"] });
  classify(store, 2, { tags: ["auth"], proposedTags: ["next-auth"] });
  const tags = getVocabulary(store).tags;

  const accepted = acceptTagProposal(store, "nextauth", {
    as: "auth",
    variants: ["next-auth"],
  });

  expect(accepted).toMatchObject({ tag: "auth", bookmarks: 2 });
  expect(tagsOf(store, 1)).toEqual(["auth", "react"]);
  expect(tagsOf(store, 2)).toEqual(["auth"]);
  expect(getVocabulary(store).tags).toEqual(tags);
  expect(getVocabulary(store).aliases).toMatchObject({
    nextauth: "auth",
    "next-auth": "auth",
  });
  // Under another of the tag's names, too.
  classify(store, 1, { proposedTags: ["advertising"] });
  expect(acceptTagProposal(store, "advertising", { as: "reklam" }).tag).toBe(
    "ads",
  );
});

test("an alias is another way of writing a tag, for filters and for what the classifier suggests", () => {
  const store = library(2);
  classify(store, 1, { proposedTags: ["kimlik-dogrulama"] });

  const aliased = addTagAlias(store, "Kimlik Doğrulama", "auth");

  expect(aliased).toMatchObject({ tag: "auth", bookmarks: 1 });
  expect(tagsOf(store, 1)).toEqual(["auth"]);
  expect(resolveTag(store, "kimlik dogrulama")).toBe("auth");
  classify(store, 2, { proposedTags: ["kimlik doğrulama"] });
  expect(tagsOf(store, 2)).toEqual(["auth"]);
  // It can be pointed elsewhere, and only at a tag, and a tag is no alias.
  addTagAlias(store, "kimlik-dogrulama", "security");
  expect(resolveTag(store, "kimlik-dogrulama")).toBe("security");
  expect(() => addTagAlias(store, "x", "no-such-tag")).toThrow(RangeError);
  expect(() => addTagAlias(store, "react", "auth")).toThrow(/mergeTags/);
  expect(() => addTagAlias(store, " ", "auth")).toThrow(RangeError);
});

test("an alias taken back is no longer understood, and the bookmarks it reached keep their tag", () => {
  const store = library(2);
  classify(store, 1, { proposedTags: ["nextauth"] });
  addTagAlias(store, "nextauth", "auth");
  const version = getVocabulary(store).version;

  const removed = removeTagAlias(store, "NextAuth");

  expect(removed).toEqual({
    tag: "auth",
    bookmarks: 0,
    vocabularyVersion: version + 1,
  });
  expect(resolveTag(store, "nextauth")).toBeUndefined();
  expect(getVocabulary(store).aliases).not.toHaveProperty("nextauth");
  expect(tagsOf(store, 1)).toEqual(["auth"]);
  // Suggested again, it is a proposal again.
  classify(store, 2, { proposedTags: ["nextauth"] });
  expect(proposalsOf(store, 2)).toEqual(["nextauth"]);
  expect(() => removeTagAlias(store, "nextauth")).toThrow(RangeError);
  expect(() => removeTagAlias(store, "react")).toThrow(RangeError);
  // The starter aliases can be taken back like any other.
  removeTagAlias(store, "reklam");
  expect(resolveTag(store, "reklam")).toBeUndefined();
});

test("a dismissed proposal leaves every bookmark and does not come back", () => {
  const store = library(3);
  classify(store, 1, { proposedTags: ["hot-take", "bun"] });
  classify(store, 2, { proposedTags: ["hot-takes"] });
  const version = getVocabulary(store).version;

  expect(dismissTagProposal(store, ["hot-take", "hot-takes"])).toEqual({
    bookmarks: 2,
  });
  classify(store, 3, { proposedTags: ["Hot Take", "hot_takes"] });

  expect(open(store)).toEqual(["bun"]);
  expect(proposalsOf(store, 3)).toEqual([]);
  expect(tagsOf(store, 1)).toEqual([]);
  expect(resolveTag(store, "hot-take")).toBeUndefined();
  // What the classifier is told has not changed, so neither has the version.
  expect(getVocabulary(store).version).toBe(version);
  expect(() => dismissTagProposal(store, "react")).toThrow(/retireTag/);
  expect(() => dismissTagProposal(store, "reklam")).toThrow(RangeError);
});

test("a dismissed text that the owner later makes a tag is a tag", () => {
  const store = library(1);
  dismissTagProposal(store, "bun");

  addTag(store, "bun");

  expect(resolveTag(store, "bun")).toBe("bun");
  classify(store, 1, { tags: ["bun"] });
  expect(tagsOf(store, 1)).toEqual(["bun"]);
});

test("a retired tag is on no bookmark, is not offered or proposed again, and comes back whole when restored", () => {
  const store = library(3);
  classify(store, 1, { tags: ["react", "seo"] });
  classify(store, 2, { tags: ["seo"] });
  correctBookmark(store, postId(3), { addTags: ["seo"] });
  const version = getVocabulary(store).version;

  const retired = retireTag(store, "SEO", { now: at(2) });

  expect(retired).toEqual({
    tag: "seo",
    bookmarks: 3,
    vocabularyVersion: version + 1,
  });
  expect(getVocabulary(store).tags).not.toContain("seo");
  expect(tagsOf(store, 1)).toEqual(["react"]);
  expect(tagsOf(store, 3)).toEqual([]);
  expect(resolveTag(store, "seo")).toBeUndefined();
  expect(summariseLibrary(store).tags.map(({ tag }) => tag)).toEqual(["react"]);
  expect(listTags(store).map(({ tag }) => tag)).not.toContain("seo");
  expect(listTags(store, { includeRetired: true }).at(-1)).toMatchObject({
    tag: "seo",
    retiredAt: at(2),
    // Every bookmark that would have it back, the one the owner put it on
    // by hand among them: the three that get it again below.
    bookmarks: 3,
  });
  expect(() => retireTag(store, "seo")).toThrow(RangeError);
  expect(() => correctBookmark(store, postId(1), { addTags: ["seo"] })).toThrow(
    /retired/,
  );

  const restored = addTag(store, "seo");

  expect(restored.vocabularyVersion).toBe(version + 2);
  expect(tagsOf(store, 1)).toEqual(["react", "seo"]);
  expect(tagsOf(store, 2)).toEqual(["seo"]);
  expect(tagsOf(store, 3)).toEqual(["seo"]);
  expect(history(store)).toEqual([
    { version: version + 1, change: "retire", tag: "seo", other: null },
    { version: version + 2, change: "restore", tag: "seo", other: null },
  ]);
});

test("the last tag of the vocabulary cannot be retired", () => {
  const store = library(0);
  const tags = getVocabulary(store).tags;
  for (const tag of tags.slice(1)) retireTag(store, tag);

  expect(() => retireTag(store, tags[0] ?? "")).toThrow(/last tag/);
  expect(getVocabulary(store).tags).toEqual([tags[0]]);
});

test("a renamed tag is on the same bookmarks under its new name, corrections included, and its old name still finds it", () => {
  const store = library(3);
  classify(store, 1, { tags: ["nextjs", "react"] });
  classify(store, 2, { tags: ["nextjs"], proposedTags: ["next"] });
  correctBookmark(store, postId(2), { removeTags: ["nextjs"] });
  correctBookmark(store, postId(3), { addTags: ["nextjs"] });

  const renamed = renameTag(store, "nextjs", "Next");

  expect(renamed).toMatchObject({ tag: "next", bookmarks: 2 });
  expect(tagsOf(store, 1)).toEqual(["next", "react"]);
  // The owner's removal and addition both follow the tag to its new name.
  expect(tagsOf(store, 2)).toEqual([]);
  expect(tagsOf(store, 3)).toEqual(["next"]);
  expect(getVocabulary(store).tags).toContain("next");
  expect(getVocabulary(store).tags).not.toContain("nextjs");
  // Its old name, and what led to the old name, lead to the new one.
  expect(resolveTag(store, "nextjs")).toBe("next");
  expect(resolveTag(store, "next.js")).toBe("next");
  expect(listBookmarks(store, { tags: ["nextjs"] }).total).toBe(2);
  // A proposal already made under the new name is settled by it.
  expect(proposalsOf(store, 2)).toEqual([]);
  expect(listTags(store).find(({ tag }) => tag === "next")).toMatchObject({
    origin: "starter",
    aliases: ["next.js", "nextjs"],
  });
});

test("a tag is renamed to one of its own aliases, and to nothing another tag is known by", () => {
  const store = library(1);
  classify(store, 1, { tags: ["shadcn-ui"] });

  renameTag(store, "shadcn-ui", "shadcn");

  expect(tagsOf(store, 1)).toEqual(["shadcn"]);
  expect(resolveTag(store, "shadcn-ui")).toBe("shadcn");
  expect(() => renameTag(store, "shadcn", "react")).toThrow(/mergeTags/);
  expect(() => renameTag(store, "shadcn", "reklam")).toThrow(
    /another way of writing/,
  );
  expect(() => renameTag(store, "shadcn", "shadcn")).toThrow(/already has/);
  expect(() => renameTag(store, "no-such-tag", "x")).toThrow(RangeError);
  expect(() => renameTag(store, "shadcn", "Not A Tag!")).toThrow(
    /cannot be a tag/,
  );
});

test("one tag declared another name for a second: its bookmarks have the second, and the owner's word on it carries over", () => {
  const store = library(5);
  classify(store, 1, { tags: ["cursor"] });
  classify(store, 2, { tags: ["cursor", "codex"] });
  classify(store, 3, { tags: ["cursor"] });
  classify(store, 4, { tags: ["codex"] });
  // On 3 the owner took the first tag off; on 5 put it on by hand.
  correctBookmark(store, postId(3), { removeTags: ["cursor"] });
  correctBookmark(store, postId(5), { addTags: ["cursor"] });
  addTagAlias(store, "cursor-ide", "cursor");

  const merged = mergeTags(store, "cursor", "codex");

  expect(merged).toMatchObject({ tag: "codex", bookmarks: 3 });
  expect(tagsOf(store, 1)).toEqual(["codex"]);
  expect(tagsOf(store, 2)).toEqual(["codex"]);
  expect(tagsOf(store, 3)).toEqual([]);
  expect(tagsOf(store, 4)).toEqual(["codex"]);
  expect(tagsOf(store, 5)).toEqual(["codex"]);
  expect(getVocabulary(store).tags).not.toContain("cursor");
  expect(
    listTags(store, { includeRetired: true }).map(({ tag }) => tag),
  ).not.toContain("cursor");
  expect(resolveTag(store, "cursor")).toBe("codex");
  expect(resolveTag(store, "cursor-ide")).toBe("codex");
  expect(() => mergeTags(store, "codex", "codex")).toThrow(/same tag/);
  expect(() => mergeTags(store, "cursor", "codex")).toThrow(RangeError);
});

test("every change to what the classifier is told moves the version, and each is in the history", () => {
  const store = library(0);

  addTag(store, "bun");
  addTagAlias(store, "bunjs", "bun");
  renameTag(store, "bun", "bun-runtime");
  mergeTags(store, "gemini", "chatgpt");
  retireTag(store, "aso");

  expect(getVocabulary(store).version).toBe(6);
  expect(history(store)).toEqual([
    { version: 2, change: "add", tag: "bun", other: null },
    { version: 3, change: "alias", tag: "bun", other: "bunjs" },
    { version: 4, change: "rename", tag: "bun-runtime", other: "bun" },
    { version: 5, change: "merge", tag: "chatgpt", other: "gemini" },
    { version: 6, change: "retire", tag: "aso", other: null },
  ]);
});

test("a refused change leaves the vocabulary and the bookmarks exactly as they were", () => {
  const store = library(1);
  classify(store, 1, { tags: ["react"], proposedTags: ["bun"] });
  const before = [getVocabulary(store), getBookmark(store, postId(1))];

  // The second alias is a tag itself, so the whole acceptance is refused.
  expect(() =>
    acceptTagProposal(store, "bun", { variants: ["bunjs", "react"] }),
  ).toThrow(/mergeTags/);

  expect([getVocabulary(store), getBookmark(store, postId(1))]).toEqual(before);
});

test("the owner's corrections of tags are untouched by a change to another tag", () => {
  const store = library(1);
  classify(store, 1, { tags: ["react"] });
  correctBookmark(store, postId(1), {
    addTags: ["auth"],
    removeTags: ["react"],
  });
  const corrections = () =>
    connectionOf(store).prepare("SELECT * FROM bookmark_tag_corrections").all();
  const before = corrections();

  addTag(store, "bun");
  retireTag(store, "seo");
  renameTag(store, "nextjs", "next");
  mergeTags(store, "gemini", "chatgpt");

  expect(corrections()).toEqual(before);
  expect(tagsOf(store, 1)).toEqual(["auth"]);
});

test("proposals the vocabulary has come to know some other way are settled in one go", () => {
  const store = library(2);
  classify(store, 1, { proposedTags: ["bun", "drizzle"] });
  classify(store, 2, { proposedTags: ["drizzle", "hot-take"] });
  // Decisions written without their bookmarks being settled, as a restored
  // backup of the vocabulary alone would leave them.
  const db = connectionOf(store);
  db.prepare(
    "INSERT INTO tag_aliases (alias, tag, decided_at) VALUES ('bun', 'react', ?), ('hot-take', NULL, ?)",
  ).run(at(1).getTime(), at(1).getTime());

  expect(settleTagProposals(store)).toBe(2);

  expect(tagsOf(store, 1)).toEqual(["react"]);
  expect(open(store)).toEqual(["drizzle"]);
  expect(settleTagProposals(store)).toBe(0);
});

test("a retired tag counts the bookmarks that would have it back: the owner's own among them, and none the owner took it off", () => {
  const store = library(4);
  classify(store, 1, { tags: ["seo"] });
  classify(store, 2, { tags: ["seo"] });
  classify(store, 3, { tags: [] });
  // The owner takes it off one the classifier gave it to, and puts it on one
  // the classifier did not, and on one the classifier has never seen.
  correctBookmark(store, postId(2), { removeTags: ["seo"] });
  correctBookmark(store, postId(3), { addTags: ["seo"] });
  correctBookmark(store, postId(4), { addTags: ["seo"] });
  const counted = () =>
    listTags(store, { includeRetired: true }).find(({ tag }) => tag === "seo")
      ?.bookmarks;
  expect(counted()).toBe(3);

  retireTag(store, "seo");

  // The same three: retiring changes who has it now, not who would.
  expect(counted()).toBe(3);
  addTag(store, "seo");
  expect(counted()).toBe(3);
  expect(
    listBookmarks(store, { tags: ["seo"] }).bookmarks.map(
      (bookmark) => bookmark.postId,
    ),
  ).toHaveLength(3);
});
