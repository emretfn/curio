import { APP_ORIGIN } from "@x-bookmarks/extension";
import { expect, test } from "vitest";
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
