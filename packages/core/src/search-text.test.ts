import { expect, test } from "vitest";
import { excerpt, markMatches, parseSearchQuery } from "./search-text.ts";

test("words must all match, and a word of three characters or more also matches as a prefix", () => {
  expect(parseSearchQuery("Agent go kit")).toEqual({
    terms: ["agent", "go", "kit"],
    expression: '("agent" OR "agent"*) AND "go" AND ("kit" OR "kit"*)',
  });
});

test("with any, one word is enough", () => {
  expect(parseSearchQuery("llm rag", "any").expression).toBe(
    '("llm" OR "llm"*) OR ("rag" OR "rag"*)',
  );
});

test("words in double quotes are a phrase, matched as written and not as a prefix", () => {
  expect(parseSearchQuery('"open source" tools')).toEqual({
    terms: ["open source", "tools"],
    expression: '"open source" AND ("tools" OR "tools"*)',
  });
});

test("the dotless and the dotted capital i are searched for as a plain i", () => {
  expect(parseSearchQuery("IŞIK ışık İstanbul").terms).toEqual([
    "işik",
    "işik",
    "istanbul",
  ]);
});

test.each([
  ["nothing", ""],
  ["spaces", "   "],
  ["punctuation alone", '* - "" : ()'],
])("a query of %s searches for nothing", (_, query) => {
  expect(parseSearchQuery(query)).toEqual({ terms: [], expression: null });
});

test("nothing typed reaches the index as syntax", () => {
  expect(parseSearchQuery('title:x NOT y* (z) a"b').expression).toBe(
    '("title:x" OR "title:x"*) AND ("not" OR "not"*) AND "y*" AND "(z)" AND "a" AND "b"',
  );
  expect(parseSearchQuery('"say ""hi"""').expression).toBe('"say" AND "hi"');
});

const LONG =
  `${"start ".repeat(40)}the needle is here ${"end ".repeat(60)}`.trim();

test("a text that fits is returned whole", () => {
  expect(excerpt("short text", 320, ["text"])).toBe("short text");
});

test("a long text is cut around the first word that matched, at spaces, with an ellipsis at each cut", () => {
  const cut = excerpt(LONG, 80, ["needle"]);

  expect(cut).toMatch(/^…start .*the needle is here .*end…$/);
  expect(cut.length).toBeLessThanOrEqual(82);
});

test("with no match in the text, a long text is cut from its start", () => {
  expect(excerpt(LONG, 40, ["absent"])).toBe(
    "start start start start start start…",
  );
  expect(excerpt(LONG, 40)).toBe("start start start start start start…");
});

test("a match at the very end keeps the room before it", () => {
  const cut = excerpt(`${"word ".repeat(100)}needle`, 60, ["needle"]);

  expect(cut).toMatch(/^…word .*word needle$/);
  expect(cut.length).toBeGreaterThan(50);
});

test("the match is found however it was typed: case, accents and the dotless i", () => {
  const text = `${"dolgu ".repeat(60)}IŞIK hızında ÇALIŞMA ${"dolgu ".repeat(60)}`;

  for (const term of ["işik", "isik", "calisma", "çalışma"]) {
    expect(excerpt(text, 60, [term]), term).toMatch(/IŞIK hızında ÇALIŞMA/);
  }
});

test("a word is matched from its start, not from its middle", () => {
  const text = `${"x ".repeat(100)}preagent ${"y ".repeat(100)}agents`;

  expect(excerpt(text, 40, ["agent"])).toMatch(/agents$/);
});

test("a cut never splits a character in two, in a text without spaces", () => {
  const text = "\u{1F516}".repeat(200);

  for (const length of [20, 21, 33]) {
    const cut = excerpt(text, length);
    expect(cut.replaceAll("…", "")).toBe(
      "\u{1F516}".repeat(Math.floor(length / 2)),
    );
  }
});

const marked = (text: string, terms: string[]) =>
  markMatches(text, terms)
    .filter((piece) => piece.marked)
    .map((piece) => piece.text);

test("the matches in a text are marked, and the pieces together are the text", () => {
  const text = "Agents at work: an agent, reagents, AGENTIC.";

  const pieces = markMatches(text, ["agent"]);

  expect(pieces).toEqual([
    { text: "Agent", marked: true },
    { text: "s at work: an ", marked: false },
    { text: "agent", marked: true },
    { text: ", reagents, ", marked: false },
    { text: "AGENT", marked: true },
    { text: "IC.", marked: false },
  ]);
  expect(pieces.map((piece) => piece.text).join("")).toBe(text);
});

test("a text with no match, and any text when nothing was searched for, is one unmarked piece", () => {
  expect(markMatches("nothing here", ["absent"])).toEqual([
    { text: "nothing here", marked: false },
  ]);
  expect(markMatches("nothing here", [])).toEqual([
    { text: "nothing here", marked: false },
  ]);
  expect(markMatches("nothing here", ["?!"])).toEqual([
    { text: "nothing here", marked: false },
  ]);
  expect(markMatches("", ["a"])).toEqual([{ text: "", marked: false }]);
});

test("a match is marked as it is written, however the term was typed", () => {
  const text = "İstanbul'da IŞIK hızında çalışma, ışıklar";

  expect(marked(text, parseSearchQuery("ISTANBUL isik Çalişma").terms)).toEqual(
    ["İstanbul", "IŞIK", "çalışma", "ışık"],
  );
  // A decomposed accent is marked with its letter.
  expect(marked("cafe\u0301 society", ["cafe"])).toEqual(["cafe\u0301"]);
  // A mark never ends inside a character that folds to several.
  expect(marked("한국어 공부", ["한구"])).toEqual(["한국"]);
});

test("a short word is marked only where it is the whole word, as it is only found there", () => {
  expect(marked("go to google, then Go", ["go"])).toEqual(["go", "Go"]);
  expect(marked("kit and kitap", ["kit"])).toEqual(["kit", "kit"]);
});

test("a term of several words is marked across what separates them, as the index reads it", () => {
  expect(marked("Use Node.js or node-js, not nodes js", ["node.js"])).toEqual([
    "Node.js",
    "node-js",
  ]);
  expect(marked("an open  source tool", ["open source"])).toEqual([
    "open  source",
  ]);
  expect(marked("by @someone and someone_else", ["@someone"])).toEqual([
    "someone",
    "someone",
  ]);
});

test("the marks of several terms never overlap, and every one is found", () => {
  const pieces = markMatches("alpha beta alphabet", [
    "alpha",
    "beta",
    "alphabet",
  ]);

  expect(pieces.filter((piece) => piece.marked).map((p) => p.text)).toEqual([
    "alpha",
    "beta",
    "alpha",
  ]);
  expect(pieces.map((piece) => piece.text).join("")).toBe(
    "alpha beta alphabet",
  );
});
