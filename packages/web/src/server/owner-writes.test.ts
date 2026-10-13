import {
  getBookmark,
  getVocabulary,
  listTagProposals,
  listTags,
  resolveTag,
  type Store,
  summariseTagging,
} from "@x-bookmarks/core";
import { expect, test, vi } from "vitest";
import { type FiledLibrary, openFiledLibrary } from "./library-testing.ts";
import {
  forOwner,
  handleOwnerWrite,
  OWNER_ACTIONS,
  type OwnerAction,
  type OwnerWriteAnswer,
  ownerWritePath,
} from "./owner-writes.ts";
import { MAX_PAGE_WRITE_BYTES } from "./page-door.ts";
import { pageRequest } from "./testing.ts";

/** The library with some of it filed, and the way a page of the app changes it. */
function setUp() {
  const library = openFiledLibrary();
  const afterTagAdded = vi.fn();
  const send = async (
    action: string,
    body: unknown,
    headers: Record<string, string | null> = {},
  ) => {
    const request = pageRequest(
      `/api/owner/${action}`,
      typeof body === "string" ? body : JSON.stringify(body),
      headers,
    );
    const response = await handleOwnerWrite(request, action, {
      store: library.store,
      afterTagAdded,
    });
    return {
      request,
      status: response.status,
      answer: (await response.json()) as OwnerWriteAnswer & { error?: string },
      headers: response.headers,
    };
  };
  return { ...library, afterTagAdded, send };
}

const labelsOf = (store: Store, postId: string) => {
  const bookmark = getBookmark(store, postId);
  if (bookmark === undefined) throw new Error("The bookmark is missing.");
  return bookmark.labels;
};

/** Everything a change from a page could have touched, to show that a refused one touched nothing. */
const standing = ({ store, bookmarks }: FiledLibrary) =>
  JSON.stringify({
    vocabulary: listTags(store, { includeRetired: true }),
    version: getVocabulary(store).version,
    proposals: listTagProposals(store),
    labels: bookmarks.map(({ postId }) => labelsOf(store, postId)),
  });

/** A body each action would act on, were its request let in. */
function validBody(action: OwnerAction, library: FiledLibrary) {
  const postId = library.classified[0]?.postId;
  const bodies: Record<OwnerAction, Record<string, unknown>> = {
    correct: { postId, category: "life", addTags: ["seo"] },
    "accept-proposal": { proposal: "server-actions" },
    "dismiss-proposals": { proposals: ["drizzle"] },
    "add-tag": { name: "drizzle" },
    "restore-tag": { tag: "seo" },
    "rename-tag": { tag: "react", to: "reactjs" },
    "merge-tags": { from: "react", into: "nextjs" },
    "retire-tag": { tag: "react" },
    "add-alias": { alias: "nxt", tag: "nextjs" },
    "remove-alias": { alias: "next.js" },
  };
  return bodies[action];
}

test("a correction from the app's own page is stored as the owner's word, and the answer is the bookmark as it then stands", async () => {
  const { store, classified, send } = setUp();
  const [post] = classified;
  if (post === undefined) throw new Error("Nothing is classified.");

  const { status, answer, headers } = await send("correct", {
    postId: post.postId,
    category: "design",
    format: "showcase",
    // An alias is read as its tag.
    addTags: ["reklam"],
    removeTags: ["react"],
  });

  expect(status).toBe(200);
  expect(headers.get("cache-control")).toBe("no-store");
  expect(answer.labels).toEqual({
    category: "design",
    format: "showcase",
    tags: ["ads", "nextjs"],
    tooLittleText: false,
    corrected: { category: true, format: true, tags: true },
    classifier: {
      category: "web-dev",
      format: "guide",
      tags: ["nextjs", "react"],
    },
  });
  // The classifier's own answer is as it was: a correction is kept apart.
  expect(labelsOf(store, post.postId)).toMatchObject({
    category: "design",
    classification: { category: "web-dev", format: "guide" },
  });
  expect(summariseTagging(store).corrected).toBe(2);
});

test("a part the owner set is handed back to the classifier with null, and a tag with resetTags", async () => {
  const { store, classified, send } = setUp();
  const postId = classified[0]?.postId ?? "";
  await send("correct", {
    postId,
    category: "design",
    addTags: ["seo"],
    removeTags: ["react"],
  });

  const { answer } = await send("correct", {
    postId,
    category: null,
    resetTags: ["seo", "react"],
  });

  expect(answer.labels).toMatchObject({
    category: "web-dev",
    tags: ["nextjs", "react"],
    corrected: { category: false, format: false, tags: false },
  });
  expect(labelsOf(store, postId).corrected.tags).toBe(false);
});

test("a bookmark the classifier has not seen can be filed by hand", async () => {
  const { bookmarks, send } = setUp();
  const unfiled = bookmarks.find(({ labels }) => labels.category === null);
  if (unfiled === undefined) throw new Error("Everything is filed.");

  const { answer } = await send("correct", {
    postId: unfiled.postId,
    category: "tools",
    addTags: ["security"],
  });

  expect(answer.labels).toEqual({
    category: "tools",
    format: null,
    tags: ["security"],
    tooLittleText: false,
    corrected: { category: true, format: false, tags: true },
    classifier: null,
  });
});

test.each(OWNER_ACTIONS)(
  "%s is refused from another site's page before its body is read, and changes nothing",
  async (action) => {
    const library = setUp();
    const before = standing(library);

    const fromElsewhere = await library.send(
      action,
      validBody(action, library),
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    );
    const rebound = await library.send(action, validBody(action, library), {
      host: "evil.example:47130",
      origin: "http://evil.example:47130",
    });
    const asAForm = await library.send(action, validBody(action, library), {
      "content-type": "text/plain",
    });

    expect([fromElsewhere.status, rebound.status, asAForm.status]).toEqual([
      403, 403, 415,
    ]);
    for (const { request } of [fromElsewhere, rebound, asAForm]) {
      expect(request.bodyUsed).toBe(false);
    }
    expect(standing(library)).toBe(before);
    expect(library.afterTagAdded).not.toHaveBeenCalled();
    expect(ownerWritePath(action)).toBe(`/api/owner/${action}`);
  },
);

test.each(OWNER_ACTIONS)(
  "%s is made when the app's own page asks",
  async (action) => {
    const library = setUp();
    // Restoring needs something retired.
    if (action === "restore-tag")
      await library.send("retire-tag", { tag: "seo" });
    const before = standing(library);

    const { status, answer } = await library.send(
      action,
      validBody(action, library),
    );

    expect(answer.error).toBeUndefined();
    expect(status).toBe(200);
    expect(answer.message).toMatch(/\S/);
    expect(standing(library)).not.toBe(before);
  },
);

test("what is not a change at all is refused, and says why", async () => {
  const library = setUp();
  const before = standing(library);
  const postId = library.classified[0]?.postId;

  const refusals = {
    "an action there is none of": await library.send("delete-everything", {}),
    "a body that is not JSON": await library.send("correct", "{not json"),
    "a body that is a list": await library.send("correct", [1]),
    "a post id that is none": await library.send("correct", {
      postId: "1; DROP",
      category: "life",
    }),
    "a category that is not a text": await library.send("correct", {
      postId,
      category: 7,
    }),
    "tags that are not a list": await library.send("correct", {
      postId,
      addTags: "seo",
    }),
    "a name too long to be one": await library.send("add-tag", {
      name: "x".repeat(65),
    }),
    "no name": await library.send("add-tag", {}),
    "nothing to dismiss": await library.send("dismiss-proposals", {}),
    "a body larger than a change can be": await library.send("add-tag", {
      name: "ok",
      aliases: Array.from({ length: 40 }, () => "y".repeat(60)),
      padding: "z".repeat(MAX_PAGE_WRITE_BYTES),
    }),
  };

  expect(
    Object.fromEntries(
      Object.entries(refusals).map(([name, { status }]) => [name, status]),
    ),
  ).toEqual({
    "an action there is none of": 404,
    "a body that is not JSON": 400,
    "a body that is a list": 400,
    "a post id that is none": 400,
    "a category that is not a text": 400,
    "tags that are not a list": 400,
    "a name too long to be one": 400,
    "no name": 400,
    "nothing to dismiss": 400,
    "a body larger than a change can be": 413,
  });
  for (const { answer } of Object.values(refusals)) {
    expect(answer.error).toMatch(/\S/);
  }
  expect(standing(library)).toBe(before);
});

test("what the taxonomy or the vocabulary does not hold is refused whole, in words fit for a screen", async () => {
  const library = setUp();
  const before = standing(library);
  const postId = library.classified[0]?.postId;

  const refusals = [
    await library.send("correct", { postId, category: "cooking" }),
    await library.send("correct", { postId, format: "thread" }),
    // One unknown tag refuses the whole correction, the category with it.
    await library.send("correct", {
      postId,
      category: "life",
      addTags: ["no-such-tag"],
    }),
    await library.send("add-tag", { name: "Not A Tag!" }),
    await library.send("add-tag", { name: "react" }),
    await library.send("rename-tag", { tag: "react", to: "nextjs" }),
    await library.send("merge-tags", { from: "react", into: "react" }),
    await library.send("add-alias", { alias: "react", tag: "nextjs" }),
    await library.send("remove-alias", { alias: "never-an-alias" }),
    await library.send("retire-tag", { tag: "no-such-tag" }),
    await library.send("dismiss-proposals", { proposals: ["react"] }),
    // Restoring is for a tag that was retired: it cannot make a new one.
    await library.send("restore-tag", { tag: "brand-new" }),
    await library.send("restore-tag", { tag: "react" }),
  ];

  for (const { status, answer } of refusals) {
    expect(status).toBe(422);
    expect(answer.error).toMatch(/\S/);
    // Core's refusals name its functions. A screen has none.
    expect(answer.error).not.toMatch(/listTags|mergeTags|retireTag|addTag|"/);
  }
  expect(standing(library)).toBe(before);
  expect(library.afterTagAdded).not.toHaveBeenCalled();

  const unknown = await library.send("correct", {
    postId: "1975000000000000999",
    category: "life",
  });
  expect(unknown.status).toBe(404);
});

test("core's refusals are reworded for a screen without losing what they say", () => {
  expect(
    forOwner(
      '"x" is a tag itself. To make it another name for "y", merge the two with mergeTags.',
    ),
  ).toBe(
    "“x” is a tag itself. To make it another name for “y”, merge the two.",
  );
  expect(
    forOwner(
      '"x" is not a tag of the vocabulary. The tags there are come from listTags.',
    ),
  ).toBe("“x” is not a tag of the vocabulary.");
  expect(
    forOwner(
      '"x" is a tag that was retired, or a name for one. Bring it back with addTag and merge the two, or choose another name.',
    ),
  ).toBe(
    "“x” is a tag that was retired, or a name for one. Bring it back and merge the two, or choose another name.",
  );
});

test("an accepted proposal becomes a tag on the bookmarks it was proposed for, and the app is told a tag was added", async () => {
  const { store, classified, afterTagAdded, send } = setUp();
  const proposedFor = classified.slice(0, 2).map(({ postId }) => postId);

  const { answer } = await send("accept-proposal", {
    proposal: "server-actions",
  });

  expect(answer).toEqual({
    tag: "server-actions",
    message: "“server-actions” is a tag now. 2 bookmarks have it now.",
  });
  for (const postId of proposedFor) {
    expect(labelsOf(store, postId).tags).toContain("server-actions");
  }
  expect(resolveTag(store, "server-actions")).toBe("server-actions");
  expect(afterTagAdded).toHaveBeenCalledTimes(1);
  // The other spelling was not ticked, so it is still a proposal.
  expect(
    listTagProposals(store).proposals.flatMap(({ variants }) =>
      variants.map(({ proposal }) => proposal),
    ),
  ).toContain("server-action");
});

test("a proposal is accepted with the other spellings the owner ticked, and with none the owner did not", async () => {
  const { store, classified, send } = setUp();

  const { answer } = await send("accept-proposal", {
    proposal: "server-actions",
    variants: ["server-action"],
  });

  expect(answer.message).toBe(
    "“server-actions” is a tag now. 3 bookmarks have it now.",
  );
  expect(labelsOf(store, classified[2]?.postId ?? "").tags).toContain(
    "server-actions",
  );
  expect(resolveTag(store, "server-action")).toBe("server-actions");
  expect(
    listTagProposals(store).proposals.map(({ proposal }) => proposal),
  ).toEqual(["drizzle"]);
});

test("a proposal made another way of writing a tag puts that tag on its bookmarks, and adds no tag", async () => {
  const { store, classified, afterTagAdded, send } = setUp();
  const tags = getVocabulary(store).tags;

  const { answer } = await send("accept-proposal", {
    proposal: "drizzle",
    as: "self-hosting",
  });

  expect(answer).toEqual({
    tag: "self-hosting",
    message:
      "“drizzle” is another way of writing “self-hosting” now. 1 bookmark got the tag.",
  });
  expect(labelsOf(store, classified[1]?.postId ?? "").tags).toContain(
    "self-hosting",
  );
  expect(getVocabulary(store).tags).toEqual(tags);
  expect(afterTagAdded).not.toHaveBeenCalled();
});

test("a dismissed proposal leaves the list and is on no bookmark", async () => {
  const { store, bookmarks, send } = setUp();

  const { answer } = await send("dismiss-proposals", {
    proposals: ["server-actions", "server-action"],
  });

  expect(answer.message).toBe(
    "Dismissed. It was proposed for 3 bookmarks, and will not be proposed again.",
  );
  expect(
    listTagProposals(store).proposals.map(({ proposal }) => proposal),
  ).toEqual(["drizzle"]);
  expect(resolveTag(store, "server-actions")).toBeUndefined();
  for (const { postId } of bookmarks) {
    expect(labelsOf(store, postId).tags).not.toContain("server-actions");
  }
});

test("the vocabulary is kept from the screen: add, rename, alias, merge, retire and restore, each carrying its bookmarks", async () => {
  const { store, classified, afterTagAdded, send } = setUp();
  const withReact = classified.slice(0, 2).map(({ postId }) => postId);
  const said = async (action: OwnerAction, body: Record<string, unknown>) => {
    const { status, answer } = await send(action, body);
    expect(answer.error).toBeUndefined();
    expect(status).toBe(200);
    return answer.message;
  };

  expect(await said("add-tag", { name: "Drizzle ORM" })).toBe(
    "“drizzle-orm” is a tag now.",
  );
  expect(afterTagAdded).toHaveBeenCalledTimes(1);

  expect(await said("rename-tag", { tag: "react", to: "reactjs" })).toBe(
    "“react” is “reactjs” now, on 2 bookmarks. The old name still finds it.",
  );
  for (const postId of withReact) {
    expect(labelsOf(store, postId).tags).toContain("reactjs");
  }
  expect(resolveTag(store, "react")).toBe("reactjs");

  expect(await said("add-alias", { alias: "React JS", tag: "reactjs" })).toBe(
    "“React JS” is another way of writing “reactjs” now.",
  );
  expect(resolveTag(store, "react-js")).toBe("reactjs");
  expect(await said("remove-alias", { alias: "react-js" })).toBe(
    "“react-js” no longer leads to “reactjs”. The bookmarks that have the tag keep it.",
  );
  expect(resolveTag(store, "react-js")).toBeUndefined();

  expect(await said("merge-tags", { from: "reactjs", into: "nextjs" })).toBe(
    "“reactjs” is merged into “nextjs”. 2 bookmarks had it, and the old name still finds them.",
  );
  for (const postId of withReact) {
    expect(labelsOf(store, postId).tags).toContain("nextjs");
    expect(labelsOf(store, postId).tags).not.toContain("reactjs");
  }

  expect(await said("retire-tag", { tag: "nextjs" })).toBe(
    "“nextjs” is retired. 2 bookmarks no longer show it. Restoring it brings it back.",
  );
  for (const postId of withReact) {
    expect(labelsOf(store, postId).tags).not.toContain("nextjs");
  }
  expect(afterTagAdded).toHaveBeenCalledTimes(1);

  expect(await said("restore-tag", { tag: "nextjs" })).toBe(
    "“nextjs” is a tag again. 2 bookmarks have it back.",
  );
  for (const postId of withReact) {
    expect(labelsOf(store, postId).tags).toContain("nextjs");
  }
  expect(afterTagAdded).toHaveBeenCalledTimes(2);
});

test("a change is made and answered even when what follows a new tag cannot be started", async () => {
  const { store } = openFiledLibrary();

  const response = await handleOwnerWrite(
    pageRequest("/api/owner/add-tag", JSON.stringify({ name: "drizzle" })),
    "add-tag",
    {
      store,
      afterTagAdded: () => {
        throw new Error("no timer");
      },
    },
  );

  expect(response.status).toBe(200);
  expect(resolveTag(store, "drizzle")).toBe("drizzle");
});

test("after a new tag the answer says what becomes of the bookmarks that mention it: the app's next pass, or the owner's command when the app's tagging is off", async () => {
  const add = async (on: boolean | undefined) => {
    const { store, classified } = openFiledLibrary();
    // A word one of the classified bookmarks holds, as the new tag's name.
    const [word] =
      classified[0]?.text.toLowerCase().match(/\b[a-z]{5,}\b/) ?? [];
    if (word === undefined)
      throw new Error("The fixture's text holds no word.");
    const response = await handleOwnerWrite(
      pageRequest("/api/owner/add-tag", JSON.stringify({ name: word })),
      "add-tag",
      on === undefined ? { store } : { store, appTaggingOn: async () => on },
    );
    const { message } = (await response.json()) as OwnerWriteAnswer;
    const waiting = summariseTagging(store).mentioningNewTags;
    expect(waiting).toBeGreaterThan(0);
    return { message, waiting, word };
  };

  const off = await add(false);
  expect(off.message).toMatch(
    new RegExp(
      `^“${off.word}” is a tag now\\. ${off.waiting} bookmarks? that mentions? a tag added since (?:it was|they were) classified waits? for pnpm tag --new-tags: the app’s own tagging is off\\.$`,
    ),
  );
  const on = await add(true);
  expect(on.message).toMatch(
    new RegExp(
      `^“${on.word}” is a tag now\\. The app’s next pass asks the classifier about ${on.waiting} bookmarks? that mentions? a tag added since`,
    ),
  );
  // Where the setting is not known, nothing is said of it.
  expect((await add(undefined)).message).toMatch(/is a tag now\.$/);
});

test("a tag that no classified bookmark mentions has nothing waiting, and the answer says nothing of a pass", async () => {
  const { store } = openFiledLibrary();

  const response = await handleOwnerWrite(
    pageRequest("/api/owner/add-tag", JSON.stringify({ name: "zzqqxx" })),
    "add-tag",
    { store, appTaggingOn: async () => false },
  );

  expect(((await response.json()) as OwnerWriteAnswer).message).toBe(
    "“zzqqxx” is a tag now.",
  );
});
