/**
 * What the owner changes from the app's own screens: what a bookmark is
 * filed under, and the tag vocabulary. Every such change arrives at
 * `POST /api/owner/<action>` and is handled here, by `handleOwnerWrite`,
 * which lets a request through the page door (`refuseUnlessOwnPage`) before
 * it reads a byte of its body.
 *
 * Nothing is decided here. A correction is core's `correctBookmark`, and a
 * change to the vocabulary is one of the functions of core's `vocabulary.ts`,
 * each of which checks what it is given and carries the bookmarks with it
 * (LAB-4, LAB-7). This file reads the request, calls the one function, and
 * says in a sentence what came of it.
 *
 * No action here starts the classifier's paid work by a control of its own.
 * A tag that joins the vocabulary is reported through `afterTagAdded`, and
 * what the app does with that is `scheduleTagging`'s to decide: nothing,
 * unless the owner has turned the app's own tagging on. The answer says
 * which, when bookmarks are waiting to be asked about a new tag.
 */
import type { Store } from "@curio/core";
import { type LabelsView, labelsView } from "../lib/post-view.ts";
import { counted } from "../lib/words.ts";
import {
  acceptTagProposal,
  addTag,
  addTagAlias,
  correctBookmark,
  dismissTagProposal,
  listTags,
  mergeTags,
  removeTagAlias,
  renameTag,
  resolveTag,
  retireTag,
  summariseTagging,
} from "./core.ts";
import { readPageBody, refuseUnlessOwnPage, tooLarge } from "./page-door.ts";

/** What a screen is told of a change it asked for. */
export interface OwnerWriteAnswer {
  /** What happened, in a sentence fit to show. */
  message: string;
  /** After a correction: what the bookmark is filed under now. */
  labels?: LabelsView;
  /** After a change to the vocabulary: the tag it was about, as the vocabulary now writes it. */
  tag?: string;
}

export interface OwnerWriteRefusal {
  error: string;
}

export interface OwnerWriteDependencies {
  store: Store;
  /**
   * Called once a tag has joined the vocabulary, with nothing to wait for:
   * the route uses it to have the bookmarks that mention the tag asked
   * about it, where the app's own passes are on.
   */
  afterTagAdded?: () => void;
  /**
   * Whether the owner has let the app tag by itself, as the tagger reads it
   * now. Left out, the answer says nothing of what follows a new tag.
   */
  appTaggingOn?: () => Promise<boolean>;
}

/** The request asked for something that cannot be done, and why, in words for the owner. */
class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

const MAX_NAME_LENGTH = 64;
const MAX_NAMES = 50;

/** A name the owner typed or chose: a tag, an alias, a proposal. */
function nameIn(body: Body, field: string): string {
  const value = body[field];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_NAME_LENGTH
  ) {
    throw new Refused(400, `"${field}" must be a name.`);
  }
  return value.trim();
}

function optionalNameIn(body: Body, field: string): string | undefined {
  return body[field] === undefined || body[field] === ""
    ? undefined
    : nameIn(body, field);
}

function namesIn(body: Body, field: string): string[] {
  const value = body[field];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_NAMES ||
    value.some(
      (name) =>
        typeof name !== "string" ||
        name.trim() === "" ||
        name.length > MAX_NAME_LENGTH,
    )
  ) {
    throw new Refused(400, `"${field}" must be a list of names.`);
  }
  return (value as string[]).map((name) => name.trim());
}

/** A category or a format: an id, null to hand it back to the classifier, or left out. */
function labelIn(body: Body, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > MAX_NAME_LENGTH) {
    throw new Refused(
      400,
      `"${field}" must be an id of the taxonomy, or null.`,
    );
  }
  return value;
}

const quoted = (name: string) => `“${name}”`;

/** Says that a tag has joined the vocabulary. What follows is not this request's to wait for, or to fail on. */
function tagAdded(afterTagAdded: (() => void) | undefined): void {
  try {
    afterTagAdded?.();
  } catch (error) {
    console.error(
      `What follows a new tag could not be started (${error instanceof Error ? error.name : "unknown error"}). The tag is in the vocabulary.`,
    );
  }
}

function correct({ store }: OwnerWriteDependencies, body: Body) {
  const postId = body.postId;
  if (typeof postId !== "string" || !/^[0-9]{1,20}$/.test(postId)) {
    throw new Refused(400, '"postId" must be the id of a post.');
  }
  let bookmark: ReturnType<typeof correctBookmark>;
  try {
    bookmark = correctBookmark(store, postId, {
      category: labelIn(body, "category"),
      format: labelIn(body, "format"),
      addTags: namesIn(body, "addTags"),
      removeTags: namesIn(body, "removeTags"),
      resetTags: namesIn(body, "resetTags"),
    });
  } catch (error) {
    if (error instanceof Error && /holds no bookmark/.test(error.message)) {
      throw new Refused(404, "The library holds no such bookmark.");
    }
    throw error;
  }
  return { message: "Saved.", labels: labelsView(bookmark) };
}

/**
 * What becomes of the bookmarks that were classified before a tag joined
 * and mention it: the classifier is asked about them, by the app's next pass
 * where the owner has turned that on, and by `pnpm tag --new-tags` where
 * not. A sentence to end the answer with, or none when no bookmark waits.
 */
async function whatFollows({
  store,
  appTaggingOn,
}: OwnerWriteDependencies): Promise<string> {
  if (appTaggingOn === undefined) return "";
  const waiting = summariseTagging(store).mentioningNewTags;
  if (waiting === 0) return "";
  return (await appTaggingOn())
    ? counted(
        waiting,
        " The app’s next pass asks the classifier about {n} bookmark that mentions a tag added since it was classified.",
        " The app’s next pass asks the classifier about {n} bookmarks that mention a tag added since they were classified.",
      )
    : counted(
        waiting,
        " {n} bookmark that mentions a tag added since it was classified waits for pnpm tag --new-tags: the app’s own tagging is off.",
        " {n} bookmarks that mention a tag added since they were classified wait for pnpm tag --new-tags: the app’s own tagging is off.",
      );
}

async function acceptProposal(
  dependencies: OwnerWriteDependencies,
  body: Body,
): Promise<OwnerWriteAnswer> {
  const { store, afterTagAdded } = dependencies;
  const proposal = nameIn(body, "proposal");
  const as = optionalNameIn(body, "as");
  const variants = namesIn(body, "variants");
  // Whether the name it is accepted under is a tag already decides what the
  // sentence says; core decides what happens.
  const existing = resolveTag(store, as ?? proposal);
  const change = acceptTagProposal(store, proposal, {
    ...(as === undefined ? {} : { as }),
    variants,
  });
  if (existing === undefined) tagAdded(afterTagAdded);
  const got = counted(
    change.bookmarks,
    "{n} bookmark has it now.",
    "{n} bookmarks have it now.",
  );
  return {
    tag: change.tag,
    message:
      existing === undefined
        ? `${quoted(change.tag)} is a tag now. ${got}${await whatFollows(dependencies)}`
        : `${quoted(proposal)} is another way of writing ${quoted(change.tag)} now. ${counted(change.bookmarks, "{n} bookmark got the tag.", "{n} bookmarks got the tag.")}`,
  };
}

function dismissProposals(
  { store }: OwnerWriteDependencies,
  body: Body,
): OwnerWriteAnswer {
  const proposals = namesIn(body, "proposals");
  if (proposals.length === 0) {
    throw new Refused(400, '"proposals" must name at least one proposal.');
  }
  const { bookmarks } = dismissTagProposal(store, proposals);
  return {
    message: `Dismissed. ${counted(bookmarks, "It was proposed for {n} bookmark", "It was proposed for {n} bookmarks")}, and will not be proposed again.`,
  };
}

async function add(
  dependencies: OwnerWriteDependencies,
  body: Body,
): Promise<OwnerWriteAnswer> {
  const { store, afterTagAdded } = dependencies;
  const change = addTag(store, nameIn(body, "name"), {
    aliases: namesIn(body, "aliases"),
  });
  tagAdded(afterTagAdded);
  const got =
    change.bookmarks === 0
      ? ""
      : ` ${counted(change.bookmarks, "{n} bookmark it was proposed for has it.", "{n} bookmarks it was proposed for have it.")}`;
  return {
    tag: change.tag,
    message: `${quoted(change.tag)} is a tag now.${got}${await whatFollows(dependencies)}`,
  };
}

/** How many bookmarks have a tag, as the vocabulary's own list counts them. */
const having = (store: Store, tag: string) =>
  listTags(store).find((listed) => listed.tag === tag)?.bookmarks ?? 0;

async function restore(
  dependencies: OwnerWriteDependencies,
  body: Body,
): Promise<OwnerWriteAnswer> {
  const { store, afterTagAdded } = dependencies;
  const name = nameIn(body, "tag");
  // `addTag` also makes a tag that never was. Restoring is only for one that
  // was retired, so a mistyped name here cannot grow the vocabulary.
  const retired = listTags(store, { includeRetired: true }).some(
    ({ tag, retiredAt }) => tag === name && retiredAt !== null,
  );
  if (!retired) {
    throw new Refused(422, `${quoted(name)} is not a retired tag.`);
  }
  const change = addTag(store, name);
  tagAdded(afterTagAdded);
  return {
    tag: change.tag,
    message: `${quoted(change.tag)} is a tag again. ${counted(having(store, change.tag), "{n} bookmark has it back.", "{n} bookmarks have it back.")}${await whatFollows(dependencies)}`,
  };
}

function rename(
  { store }: OwnerWriteDependencies,
  body: Body,
): OwnerWriteAnswer {
  const from = nameIn(body, "tag");
  const change = renameTag(store, from, nameIn(body, "to"));
  return {
    tag: change.tag,
    message: `${quoted(from)} is ${quoted(change.tag)} now${counted(change.bookmarks, ", on {n} bookmark", ", on {n} bookmarks")}. The old name still finds it.`,
  };
}

function merge(
  { store }: OwnerWriteDependencies,
  body: Body,
): OwnerWriteAnswer {
  const from = nameIn(body, "from");
  const change = mergeTags(store, from, nameIn(body, "into"));
  return {
    tag: change.tag,
    message: `${quoted(from)} is merged into ${quoted(change.tag)}. ${counted(change.bookmarks, "{n} bookmark had it", "{n} bookmarks had it")}, and the old name still finds them.`,
  };
}

function retire(
  { store }: OwnerWriteDependencies,
  body: Body,
): OwnerWriteAnswer {
  const change = retireTag(store, nameIn(body, "tag"));
  return {
    tag: change.tag,
    message: `${quoted(change.tag)} is retired. ${counted(change.bookmarks, "{n} bookmark no longer shows it.", "{n} bookmarks no longer show it.")} Restoring it brings it back.`,
  };
}

function addAlias(
  { store }: OwnerWriteDependencies,
  body: Body,
): OwnerWriteAnswer {
  const alias = nameIn(body, "alias");
  const change = addTagAlias(store, alias, nameIn(body, "tag"));
  return {
    tag: change.tag,
    message: `${quoted(alias)} is another way of writing ${quoted(change.tag)} now.`,
  };
}

function removeAlias(
  { store }: OwnerWriteDependencies,
  body: Body,
): OwnerWriteAnswer {
  const alias = nameIn(body, "alias");
  const change = removeTagAlias(store, alias);
  return {
    tag: change.tag,
    message: `${quoted(alias)} no longer leads to ${quoted(change.tag)}. The bookmarks that have the tag keep it.`,
  };
}

/** Every change the app's own pages can make, by the last part of its address. */
const ACTIONS = {
  correct,
  "accept-proposal": acceptProposal,
  "dismiss-proposals": dismissProposals,
  "add-tag": add,
  "restore-tag": restore,
  "rename-tag": rename,
  "merge-tags": merge,
  "retire-tag": retire,
  "add-alias": addAlias,
  "remove-alias": removeAlias,
} as const satisfies Record<
  string,
  (
    dependencies: OwnerWriteDependencies,
    body: Body,
  ) => OwnerWriteAnswer | Promise<OwnerWriteAnswer>
>;

export type OwnerAction = keyof typeof ACTIONS;
export const OWNER_ACTIONS = Object.keys(ACTIONS) as OwnerAction[];

/** Where a screen sends a change. */
export const ownerWritePath = (action: OwnerAction) => `/api/owner/${action}`;

/**
 * Core's refusals are written for whoever calls its functions, and name
 * them. A screen has no functions: the sentences that only point at one are
 * dropped, a function's name where it stands for a verb is left out, and
 * bringing a retired tag back is called what the Tags page calls it, which
 * is the button the owner is being sent to.
 */
export function forOwner(message: string): string {
  return message
    .replace(/\bBring it back with addTag\b/g, "Restore it")
    .replace(/ The tags there are(?: now)? come from listTags\./g, "")
    .replace(/ A tag is retired with retireTag\./g, "")
    .replace(/ with (?:mergeTags|addTag)\b/g, "")
    .replace(/"([^"]*)"/g, "“$1”");
}

function answer(
  status: number,
  body: OwnerWriteAnswer | OwnerWriteRefusal,
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Makes one change the owner asked for from a page of this app. A request
 * from anywhere else is refused before its body is read.
 */
export async function handleOwnerWrite(
  request: Request,
  action: string,
  dependencies: OwnerWriteDependencies,
): Promise<Response> {
  const refused = refuseUnlessOwnPage(request);
  if (refused !== null) return refused;
  if (!Object.hasOwn(ACTIONS, action)) {
    return answer(404, { error: "There is no such change to make." });
  }
  const text = await readPageBody(request);
  if (text === null) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { error: "The body is not JSON." });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return answer(400, { error: "The body is not an object." });
  }
  try {
    return answer(
      200,
      await ACTIONS[action as OwnerAction](dependencies, body as Body),
    );
  } catch (error) {
    if (error instanceof Refused) {
      return answer(error.status, { error: error.message });
    }
    // Core refuses what the taxonomy or the vocabulary does not allow with a
    // RangeError that says why. Nothing was changed.
    if (error instanceof RangeError) {
      return answer(422, { error: forOwner(error.message) });
    }
    // The error's name alone: its message could quote what it was working on.
    console.error(
      `A change from the app's own page could not be made (${error instanceof Error ? error.name : "an unknown error"}).`,
    );
    return answer(500, {
      error: "The change could not be made. Nothing was changed.",
    });
  }
}
