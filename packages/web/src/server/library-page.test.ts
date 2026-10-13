import { correctBookmark } from "@curio/core";
import { APP_ORIGIN } from "@curio/extension";
import { expect, test } from "vitest";
import { nextPageAddress } from "../components/library/load-more.ts";
import { toItemView } from "../lib/post-view.ts";
import { listLibrary } from "./library.ts";
import { handleLibraryPage, type LibraryPageAnswer } from "./library-page.ts";
import { commonWord, openFixtureLibrary } from "./library-testing.ts";

const HOST = new URL(APP_ORIGIN).host;

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}/api/library${query}`, {
    headers: { host: HOST, "sec-fetch-site": "same-origin", ...headers },
  });
}

test("the page after a cursor is the list's next items, as views", async () => {
  const store = openFixtureLibrary();
  const first = listLibrary(store, { features: ["media"] }, { limit: 2 });
  const expected = listLibrary(
    store,
    { features: ["media"] },
    { after: first.nextCursor },
  );
  expect(expected.items.length).toBeGreaterThan(0);

  const response = handleLibraryPage(
    request(`?has=media&after=${first.nextCursor}`),
    store,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const answer = (await response.json()) as LibraryPageAnswer;
  expect(answer).toEqual({
    items: JSON.parse(
      JSON.stringify(expected.items.map((item) => toItemView(item))),
    ),
    nextCursor: expected.nextCursor,
    total: expected.total,
  });
});

test("a search's next page is its next matches, marked with what was searched for", async () => {
  const store = openFixtureLibrary();
  const word = commonWord(store);
  const text = word.toUpperCase();
  const first = listLibrary(store, { text }, { limit: 2 });
  const expected = listLibrary(store, { text }, { after: first.nextCursor });
  expect(expected.items.length).toBeGreaterThan(0);
  expect(expected.terms).toEqual([word]);

  const response = handleLibraryPage(
    request(`?q=${text}&after=${first.nextCursor}`),
    store,
  );

  expect(response.status).toBe(200);
  const answer = (await response.json()) as LibraryPageAnswer;
  expect(answer).toEqual({
    items: JSON.parse(
      JSON.stringify(
        expected.items.map((item) => toItemView(item, expected.terms)),
      ),
    ),
    nextCursor: expected.nextCursor,
    total: expected.total,
  });
  expect(JSON.stringify(answer.items)).toContain('"kind":"mark"');
});

test("a longer page can be asked for, up to the app's limit, and nothing but a number is taken", async () => {
  const store = openFixtureLibrary();
  const first = listLibrary(store, {}, { limit: 2 });
  const items = async (limit: string) => {
    const response = handleLibraryPage(
      request(`?after=${first.nextCursor}&limit=${limit}`),
      store,
    );
    return response.status === 200
      ? ((await response.json()) as LibraryPageAnswer).items.length
      : response.status;
  };

  expect(await items("3")).toBe(3);
  expect(await items("9999")).toBe(
    listLibrary(store, {}, { after: first.nextCursor, limit: 9999 }).items
      .length,
  );
  for (const limit of ["0", "-1", "1.5", "ten", "", "99999"]) {
    expect(await items(limit), limit).toBe(400);
  }
});

test("no answer carries a CORS header, so no other site's page can read the library", () => {
  const store = openFixtureLibrary();

  for (const response of [
    handleLibraryPage(request(""), store),
    handleLibraryPage(request("", { origin: "https://example.com" }), store),
    handleLibraryPage(request("?after=nonsense"), store),
  ]) {
    for (const [name] of response.headers) {
      expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    }
  }
});

test.each([
  [
    "under another name, as a re-pointed domain would",
    { host: "evil.example" },
  ],
  ["on another port", { host: "127.0.0.1:8080" }],
  ["from another site's page", { "sec-fetch-site": "cross-site" }],
  ["from another local app's page", { "sec-fetch-site": "same-site" }],
])("a request %s is refused", async (_, headers) => {
  const response = handleLibraryPage(
    request("", headers),
    openFixtureLibrary(),
  );

  expect(response.status).toBe(403);
  expect(Object.keys((await response.json()) as object)).toEqual(["error"]);
});

test("a cursor this app did not give out is refused, not guessed at", () => {
  const store = openFixtureLibrary();

  for (const after of ["1", "abc:def", "1:2:3", "w:", `${"9".repeat(40)}:1`]) {
    expect(handleLibraryPage(request(`?after=${after}`), store).status).toBe(
      400,
    );
  }
  // One of the right shape, for another kind of list than the address asks for.
  for (const query of ["?after=s:2", "?after=w:0", "?q=word&after=1:2"]) {
    expect(handleLibraryPage(request(query), store).status).toBe(400);
  }
});

test("a search keeps its place when matches have left it since the last page: none is passed over", async () => {
  const store = openFixtureLibrary();
  const word = commonWord(store);
  const all = listLibrary(store, { text: word }, { limit: 100 });
  expect(all.total).toBeGreaterThan(6);
  const idsOf = (items: { kind: string }[]) =>
    items.map((item) =>
      "bookmark" in item
        ? (item as { bookmark: { postId: string } }).bookmark.postId
        : (item as unknown as { id: string }).id,
    );
  const ranked = idsOf(all.items);
  // The reader has the first four, and files the first and the third under
  // a category, in a list of what is filed under none.
  const unfiled = { text: word, category: "none" };
  const first = listLibrary(store, unfiled, { limit: 4 });
  expect(idsOf(first.items)).toEqual(ranked.slice(0, 4));
  for (const postId of [ranked[0], ranked[2]]) {
    correctBookmark(store, postId ?? "", { category: "life" });
  }
  const expected = ranked.filter((id) => id !== ranked[0] && id !== ranked[2]);

  // Counted off by position alone, the next page starts two matches late.
  const blind = listLibrary(store, unfiled, {
    after: first.nextCursor,
    limit: 4,
  });
  expect(idsOf(blind.items)).toEqual(expected.slice(4, 8));
  expect(idsOf(blind.items)).not.toContain(expected[2]);

  // Told how many the reader's last page counted, it starts that much
  // earlier: what the reader holds twice it drops, and nothing is missed.
  const response = handleLibraryPage(
    request(
      `?q=${word}&cat=none&limit=4&after=${first.nextCursor}&seen=${first.total}`,
    ),
    store,
  );
  const answer = (await response.json()) as LibraryPageAnswer;
  expect(answer.total).toBe(all.total - 2);
  expect(answer.items.map(({ id }) => id)).toEqual(expected.slice(2, 8));
  const held = new Set(ranked.slice(0, 4));
  const fresh = answer.items.map(({ id }) => id).filter((id) => !held.has(id));
  expect(
    [...ranked.slice(0, 4), ...fresh].filter((id) => expected.includes(id)),
  ).toEqual(expected.slice(0, 8));

  // And the page after that follows on, with nothing left to make up.
  const next = listLibrary(store, unfiled, {
    after: answer.nextCursor,
    limit: 4,
    seen: answer.total,
  });
  expect(idsOf(next.items)).toEqual(expected.slice(8, 12));
});

test("what the reader saw is a number of items, and a list by time takes no notice of it", async () => {
  const store = openFixtureLibrary();
  const first = listLibrary(store, {}, { limit: 3 });
  const plain = listLibrary(store, {}, { after: first.nextCursor, limit: 3 });

  const told = listLibrary(
    store,
    {},
    { after: first.nextCursor, limit: 3, seen: first.total + 5 },
  );
  expect(told).toEqual(plain);
  // More matches than before, or as many: nothing left, nothing to make up.
  const word = commonWord(store);
  const page = listLibrary(store, { text: word }, { limit: 2 });
  expect(
    listLibrary(
      store,
      { text: word },
      { after: page.nextCursor, limit: 2, seen: page.total - 1 },
    ),
  ).toEqual(
    listLibrary(store, { text: word }, { after: page.nextCursor, limit: 2 }),
  );

  for (const seen of ["-1", "1.5", "many", "1e3", ""]) {
    const refused = handleLibraryPage(
      request(`?after=${first.nextCursor}&seen=${seen}`),
      store,
    );
    expect(refused.status, seen).toBe(400);
  }
});

test("the next page is asked for at this app, by a relative address, with what the reader last saw", () => {
  expect(nextPageAddress("q=agents&cat=none", "s:40", { seen: 57 })).toBe(
    "/api/library?q=agents&cat=none&after=s%3A40&seen=57",
  );
  expect(nextPageAddress("", "1760000000000:12")).toBe(
    "/api/library?after=1760000000000%3A12",
  );
  expect(nextPageAddress("has=media", "w:2", { limit: 100 })).toBe(
    "/api/library?has=media&after=w%3A2&limit=100",
  );
});
