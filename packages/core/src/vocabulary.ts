/**
 * The tag vocabulary: the tags a bookmark can have, and the other ways each
 * is written. It lives in the database, in `tags` and `tag_aliases`, and
 * nowhere else: the owner changes it while the app runs, from the
 * interface, and nothing is edited to do so. Migration 7 wrote the set it
 * starts as. The classifier's instructions and the limits on its answer are
 * built from the vocabulary as it stands when a run begins (`getVocabulary`),
 * and the filters resolve what they are given against it.
 *
 * Every change is the owner's and goes through a function here: adding a
 * tag, accepting one the classifier proposed, retiring, renaming, merging
 * one into another, naming an alias, dismissing a proposal. Each change that
 * alters what the classifier is told gets a version, and a classification
 * records the version it was made against. The bookmarks follow a change at
 * once and without the classifier: they are rewritten here, in the same
 * transaction.
 *
 * What a change does not do is ask the classifier about the bookmarks that
 * were classified before it. A bookmark classified before a tag existed was
 * never asked about that tag; `tagging.ts` finds those that mention it, for
 * a small pass that can add the new tag and change nothing else.
 */
import { connectionOf, type Store } from "./store.ts";
import { foldTagText, MAX_TAG_LENGTH, TAG_SHAPE } from "./taxonomy.ts";

type Connection = ReturnType<typeof connectionOf>;

/** The vocabulary as it stands. */
export interface Vocabulary {
  /** Raised by every change to the tags or their aliases. Version 1 is the starter set. */
  version: number;
  /** The tags a bookmark can have now, in alphabetical order. */
  tags: string[];
  /** Other ways of writing them, folded, each with the tag it leads to. */
  aliases: Record<string, string>;
}

/** Package-internal: the vocabulary's current version. */
export function vocabularyVersion(db: Connection): number {
  return (
    db
      .prepare<[], number>("SELECT max(version) FROM vocabulary_changes")
      .pluck()
      .get() ?? 1
  );
}

export function getVocabulary(store: Store): Vocabulary {
  const db = connectionOf(store);
  return {
    version: vocabularyVersion(db),
    tags: db
      .prepare<[], string>(
        "SELECT tag FROM tags WHERE retired_at IS NULL ORDER BY tag",
      )
      .pluck()
      .all(),
    aliases: Object.fromEntries(
      db
        .prepare<[], [string, string]>(
          `SELECT a.alias, a.tag FROM tag_aliases a
           JOIN tags t ON t.tag = a.tag AND t.retired_at IS NULL
           ORDER BY a.alias`,
        )
        .raw()
        .all(),
    ),
  };
}

/**
 * What a folded text is to the vocabulary: a tag, another way of writing
 * one, a tag that was retired, a text the owner said is no tag, or nothing
 * it knows.
 */
type Standing =
  | { is: "tag"; tag: string }
  | { is: "alias"; tag: string }
  | { is: "retired" }
  | { is: "dismissed" }
  | { is: "unknown" };

function standingOf(db: Connection, folded: string): Standing {
  const tag = db
    .prepare<[string], { retired: number }>(
      "SELECT retired_at IS NOT NULL AS retired FROM tags WHERE tag = ?",
    )
    .get(folded);
  if (tag !== undefined) {
    return tag.retired === 1 ? { is: "retired" } : { is: "tag", tag: folded };
  }
  const alias = db
    .prepare<[string], { tag: string | null; retired: number | null }>(
      `SELECT a.tag AS tag, t.retired_at IS NOT NULL AS retired
       FROM tag_aliases a LEFT JOIN tags t ON t.tag = a.tag
       WHERE a.alias = ?`,
    )
    .get(folded);
  if (alias === undefined) return { is: "unknown" };
  if (alias.tag === null) return { is: "dismissed" };
  // An alias of a retired tag leads nowhere while the tag is retired.
  return alias.retired === 0
    ? { is: "alias", tag: alias.tag }
    : { is: "retired" };
}

/**
 * Package-internal: what the classifier's suggestion of a text comes to. A
 * tag to put on the bookmark, when the text is a tag or another way of
 * writing one; `null` when it is to be dropped, because the owner retired
 * that tag or said the text is none; `undefined` when the vocabulary does
 * not know it, which makes it a proposal.
 */
export function suggestionOf(
  db: Connection,
  folded: string,
): string | null | undefined {
  const standing = standingOf(db, folded);
  if (standing.is === "tag" || standing.is === "alias") return standing.tag;
  return standing.is === "unknown" ? undefined : null;
}

/** Package-internal: the vocabulary's tag for a text as typed, or undefined. */
export function resolveIn(db: Connection, text: string): string | undefined {
  return suggestionOf(db, foldTagText(text)) ?? undefined;
}

/**
 * The vocabulary's tag for a text as someone typed it, in any case and with
 * or without accents: the tag itself, or another way of writing it
 * ("reklam" for `ads`). Undefined when it is neither, or the tag is retired.
 */
export function resolveTag(store: Store, text: string): string | undefined {
  return resolveIn(connectionOf(store), text);
}

/** Package-internal: the tag a filter or a correction names, or a refusal that says what the text is instead. */
export function tagOf(db: Connection, value: string): string {
  const standing = standingOf(db, foldTagText(value));
  if (standing.is === "tag" || standing.is === "alias") return standing.tag;
  throw new RangeError(
    standing.is === "retired"
      ? `"${value}" is a tag that was retired. The tags there are now come from listTags.`
      : `"${value}" is not a tag of the vocabulary, nor another way of writing one. The tags there are come from listTags.`,
  );
}

const FROM_PROPOSALS = `
  FROM bookmark_classifications cl, json_each(cl.proposed_tags) AS p`;

/**
 * Takes one proposal off every bookmark that holds it, and puts `tag` on
 * those bookmarks when there is one. Returns how many bookmarks held it.
 */
function settleProposal(
  db: Connection,
  proposal: string,
  tag: string | null,
): number {
  const holders = db
    .prepare<[string], { postId: string; proposed: string }>(
      `SELECT cl.post_id AS postId, cl.proposed_tags AS proposed
       ${FROM_PROPOSALS}
       WHERE p.value = ?`,
    )
    .all(proposal);
  const keep = db.prepare(
    "UPDATE bookmark_classifications SET proposed_tags = ? WHERE post_id = ?",
  );
  const put = db.prepare(
    "INSERT OR IGNORE INTO bookmark_tags (post_id, tag) VALUES (?, ?)",
  );
  for (const { postId, proposed } of holders) {
    const rest = (JSON.parse(proposed) as string[]).filter(
      (value) => value !== proposal,
    );
    keep.run(JSON.stringify(rest), postId);
    if (tag !== null) put.run(postId, tag);
  }
  return holders.length;
}

type Change =
  | "add"
  | "restore"
  | "retire"
  | "rename"
  | "merge"
  | "alias"
  | "unalias";

/** Records a change and returns the vocabulary's new version. */
function record(
  db: Connection,
  change: Change,
  tag: string,
  other: string | null,
  at: number,
): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO vocabulary_changes (version, change, tag, other, changed_at)
       VALUES ((SELECT max(version) + 1 FROM vocabulary_changes), ?, ?, ?, ?)`,
    )
    .run(change, tag, other, at);
  return Number(lastInsertRowid);
}

const timeOf = (date: Date | undefined) => (date ?? new Date()).getTime();

/** The name of a tag as the vocabulary writes one, or a refusal. */
function nameOf(text: string): string {
  const name = foldTagText(text);
  if (!TAG_SHAPE.test(name) || name.length > MAX_TAG_LENGTH) {
    throw new RangeError(
      `"${text}" cannot be a tag. A tag is lowercase letters and digits, in words joined by hyphens, ${MAX_TAG_LENGTH} characters at most.`,
    );
  }
  return name;
}

/** The tag, when it is one the vocabulary holds now, or a refusal. */
function activeTag(db: Connection, text: string): string {
  const name = foldTagText(text);
  if (standingOf(db, name).is !== "tag") {
    throw new RangeError(
      `"${text}" is not a tag of the vocabulary. The tags there are come from listTags.`,
    );
  }
  return name;
}

/** Makes `alias` lead to `tag`, in place of whatever it led to, and settles the proposals written that way. */
function pointAlias(
  db: Connection,
  alias: string,
  tag: string | null,
  at: number,
): number {
  db.prepare(
    `INSERT INTO tag_aliases (alias, tag, decided_at) VALUES (?, ?, ?)
     ON CONFLICT (alias) DO UPDATE SET
       tag = excluded.tag, decided_at = excluded.decided_at`,
  ).run(alias, tag, at);
  return settleProposal(db, alias, tag);
}

/** What a change to the vocabulary came to. */
export interface VocabularyChange {
  /** The tag the change was about, as the vocabulary now writes it. */
  tag: string;
  /** How many bookmarks the change reached: gained the tag, lost it, or had it rewritten. */
  bookmarks: number;
  /** The vocabulary's version after the change. */
  vocabularyVersion: number;
}

/** Adds `name` to the vocabulary inside a transaction that is already open. */
function add(
  db: Connection,
  name: string,
  aliases: readonly string[],
  at: number,
): VocabularyChange {
  const standing = standingOf(db, name);
  if (standing.is === "tag") {
    throw new RangeError(`"${name}" is already a tag of the vocabulary.`);
  }
  if (standing.is === "alias") {
    throw new RangeError(
      `"${name}" is another way of writing the tag "${standing.tag}". It cannot be a tag of its own as well.`,
    );
  }
  let version: number;
  if (db.prepare("SELECT 1 FROM tags WHERE tag = ?").get(name) !== undefined) {
    // A retired tag comes back, and with it the bookmarks that had it. The
    // bookmarks classified while it was away were never asked about it.
    version = record(db, "restore", name, null, at);
    db.prepare(
      "UPDATE tags SET retired_at = NULL, added_version = ? WHERE tag = ?",
    ).run(version, name);
  } else {
    version = record(db, "add", name, null, at);
    db.prepare(
      "INSERT INTO tags (tag, origin, added_version, added_at) VALUES (?, 'owner', ?, ?)",
    ).run(name, version, at);
  }
  // A tag is not also "no tag at all", or another way of writing a tag that
  // was retired, whatever was said of the text before.
  db.prepare("DELETE FROM tag_aliases WHERE alias = ?").run(name);
  let bookmarks = settleProposal(db, name, name);
  for (const text of aliases) {
    const alias = foldTagText(text);
    if (alias === "" || alias === name) continue;
    const taken = standingOf(db, alias);
    if (taken.is === "tag" || taken.is === "retired") {
      throw new RangeError(
        `"${text}" is a tag itself, so it cannot be another way of writing "${name}". Merge the two with mergeTags.`,
      );
    }
    bookmarks += pointAlias(db, alias, name, at);
    version = record(db, "alias", name, alias, at);
  }
  return { tag: name, bookmarks, vocabularyVersion: version };
}

/**
 * Adds a tag to the vocabulary, or brings a retired one back. Bookmarks the
 * classifier proposed that very tag for get it at once; so do those it
 * proposed one of `aliases` for, which become other ways of writing the tag.
 * Other bookmarks are not touched: see `listClassificationCandidates` with
 * `which: "new-tags"` for the ones worth asking the classifier about.
 */
export function addTag(
  store: Store,
  name: string,
  options: { aliases?: readonly string[]; now?: Date } = {},
): VocabularyChange {
  const db = connectionOf(store);
  const tag = nameOf(name);
  return db
    .transaction(() => add(db, tag, options.aliases ?? [], timeOf(options.now)))
    .immediate();
}

/**
 * Accepts a tag the classifier proposed. Under its own name it becomes a
 * new tag; `as` gives it another name, which may be a new tag or one the
 * vocabulary already holds, and then the proposal becomes another way of
 * writing that tag. `variants` are other proposals for the same subject,
 * accepted with it. Every bookmark any of them was proposed for gets the
 * tag, without the classifier being asked again, however many tags it has:
 * the limit on tags is on one answer of the classifier, and this is the
 * owner's decision.
 *
 * A name the owner retired is refused, as `renameTag` refuses it. Taking it
 * would bring the retired tag back on every bookmark it was retired from,
 * which is more than accepting a proposal says; `addTag` does that, when it
 * is what the owner wants.
 */
export function acceptTagProposal(
  store: Store,
  proposal: string,
  options: { as?: string; variants?: readonly string[]; now?: Date } = {},
): VocabularyChange {
  const db = connectionOf(store);
  const at = timeOf(options.now);
  const accept = db.transaction((): VocabularyChange => {
    const proposed = [proposal, ...(options.variants ?? [])];
    const name = options.as ?? proposal;
    if (standingOf(db, foldTagText(name)).is === "retired") {
      throw new RangeError(
        `"${name}" is a tag that was retired, or a name for one. Accepting a proposal under it would bring the tag back on every bookmark it was retired from. Bring it back with addTag first, or choose another name.`,
      );
    }
    const target = resolveIn(db, name);
    if (target === undefined) {
      return add(db, nameOf(name), proposed, at);
    }
    // The name is one the vocabulary knows: the proposals join that tag.
    let bookmarks = 0;
    let version = vocabularyVersion(db);
    for (const text of proposed) {
      const alias = foldTagText(text);
      if (alias === "" || alias === target) continue;
      const taken = standingOf(db, alias);
      if (taken.is === "tag" || taken.is === "retired") {
        throw new RangeError(
          taken.is === "tag"
            ? `"${text}" is a tag itself. Merge it into "${target}" with mergeTags.`
            : `"${text}" is a tag that was retired, or a name for one, so it cannot be another way of writing "${target}".`,
        );
      }
      bookmarks += pointAlias(db, alias, target, at);
      version = record(db, "alias", target, alias, at);
    }
    return { tag: target, bookmarks, vocabularyVersion: version };
  });
  return accept.immediate();
}

/**
 * Makes a text another way of writing a tag: in what a filter is given, and
 * in what the classifier suggests, from now on. Bookmarks that hold the
 * text as a proposal get the tag.
 */
export function addTagAlias(
  store: Store,
  alias: string,
  tag: string,
  options: { now?: Date } = {},
): VocabularyChange {
  const db = connectionOf(store);
  const at = timeOf(options.now);
  const name = foldTagText(alias);
  if (name === "")
    throw new RangeError("There is no text to make an alias of.");
  const point = db.transaction((): VocabularyChange => {
    const target = activeTag(db, tag);
    const standing = standingOf(db, name);
    if (standing.is === "tag" || standing.is === "retired") {
      throw new RangeError(
        `"${alias}" is a tag itself. To make it another name for "${target}", merge the two with mergeTags.`,
      );
    }
    const bookmarks = pointAlias(db, name, target, at);
    return {
      tag: target,
      bookmarks,
      vocabularyVersion: record(db, "alias", target, name, at),
    };
  });
  return point.immediate();
}

/**
 * Takes back an alias: the text is no longer another way of writing a tag,
 * in a filter or in what the classifier suggests. Bookmarks that got the
 * tag through it keep the tag; `correctBookmark` takes it off one that
 * should not have it.
 */
export function removeTagAlias(
  store: Store,
  alias: string,
  options: { now?: Date } = {},
): VocabularyChange {
  const db = connectionOf(store);
  const at = timeOf(options.now);
  const name = foldTagText(alias);
  const remove = db.transaction((): VocabularyChange => {
    const tag = db
      .prepare<[string], string>(
        "SELECT tag FROM tag_aliases WHERE alias = ? AND tag IS NOT NULL",
      )
      .pluck()
      .get(name);
    if (tag === undefined) {
      throw new RangeError(`"${alias}" is not another way of writing a tag.`);
    }
    db.prepare("DELETE FROM tag_aliases WHERE alias = ?").run(name);
    return {
      tag,
      bookmarks: 0,
      vocabularyVersion: record(db, "unalias", tag, name, at),
    };
  });
  return remove.immediate();
}

/**
 * The owner's decision that a text the classifier proposed is no tag. It
 * leaves the list of proposals, on every bookmark, and does not come back:
 * the classifier's later suggestions of the same text are dropped. Takes
 * one text or several, as when a group of near-duplicates is dismissed
 * together. Returns how many bookmarks held one of them.
 */
export function dismissTagProposal(
  store: Store,
  proposal: string | readonly string[],
  options: { now?: Date } = {},
): { bookmarks: number } {
  const db = connectionOf(store);
  const at = timeOf(options.now);
  const dismiss = db.transaction(() => {
    let bookmarks = 0;
    for (const text of typeof proposal === "string" ? [proposal] : proposal) {
      const name = foldTagText(text);
      if (name === "") continue;
      const standing = standingOf(db, name);
      if (standing.is === "tag" || standing.is === "alias") {
        throw new RangeError(
          `"${text}" is ${standing.is === "tag" ? "a tag of the vocabulary" : `another way of writing "${standing.tag}"`}, not a proposal. A tag is retired with retireTag.`,
        );
      }
      // A retired tag's name is dropped already; there is nothing to add.
      if (standing.is !== "retired")
        bookmarks += pointAlias(db, name, null, at);
    }
    return { bookmarks };
  });
  return dismiss.immediate();
}

const having = (db: Connection, tag: string) =>
  db
    .prepare<[string], number>(
      "SELECT count(*) FROM bookmark_effective_tags WHERE tag = ?",
    )
    .pluck()
    .get(tag) ?? 0;

/**
 * Takes a tag out of the vocabulary. The bookmarks that have it stop having
 * it, in every list, filter and count, and the classifier is no longer
 * offered it or allowed to propose it. Nothing is deleted: `addTag` with the
 * same name brings it back, on the bookmarks that had it.
 */
export function retireTag(
  store: Store,
  tag: string,
  options: { now?: Date } = {},
): VocabularyChange {
  const db = connectionOf(store);
  const at = timeOf(options.now);
  const retire = db.transaction((): VocabularyChange => {
    const name = activeTag(db, tag);
    const active = db
      .prepare<[], number>("SELECT count(*) FROM tags WHERE retired_at IS NULL")
      .pluck()
      .get();
    if (active === 1) {
      throw new RangeError(
        "The vocabulary's last tag cannot be retired: the classifier needs at least one to choose from.",
      );
    }
    const bookmarks = having(db, name);
    db.prepare("UPDATE tags SET retired_at = ? WHERE tag = ?").run(at, name);
    return {
      tag: name,
      bookmarks,
      vocabularyVersion: record(db, "retire", name, null, at),
    };
  });
  return retire.immediate();
}

/**
 * Gives a tag a new name. Every bookmark that has it has it under the new
 * name from then on, the owner's corrections included, and the old name
 * stays as another way of writing it, so a filter that still uses it works.
 */
export function renameTag(
  store: Store,
  from: string,
  to: string,
  options: { now?: Date } = {},
): VocabularyChange {
  const db = connectionOf(store);
  const at = timeOf(options.now);
  const rename = db.transaction((): VocabularyChange => {
    const old = activeTag(db, from);
    const name = nameOf(to);
    const standing = standingOf(db, name);
    if (standing.is === "tag" || standing.is === "retired") {
      throw new RangeError(
        name === old
          ? `"${to}" is the name the tag already has.`
          : standing.is === "tag"
            ? `"${to}" is a tag already. To make "${old}" another name for it, merge the two with mergeTags.`
            : `"${to}" is a tag that was retired, or a name for one. Bring it back with addTag and merge the two, or choose another name.`,
      );
    }
    if (standing.is === "alias" && standing.tag !== old) {
      throw new RangeError(
        `"${to}" is another way of writing the tag "${standing.tag}".`,
      );
    }
    const bookmarks = having(db, old);
    // The new name stops being an alias of the tag, or "no tag at all".
    db.prepare("DELETE FROM tag_aliases WHERE alias = ?").run(name);
    db.prepare("UPDATE tags SET tag = ? WHERE tag = ?").run(name, old);
    for (const table of ["bookmark_tags", "bookmark_tag_corrections"]) {
      db.prepare(`UPDATE ${table} SET tag = ? WHERE tag = ?`).run(name, old);
    }
    db.prepare("UPDATE tag_aliases SET tag = ? WHERE tag = ?").run(name, old);
    pointAlias(db, old, name, at);
    settleProposal(db, name, name);
    return {
      tag: name,
      bookmarks,
      vocabularyVersion: record(db, "rename", name, old, at),
    };
  });
  return rename.immediate();
}

/**
 * Declares one tag another name for a second. The bookmarks that had the
 * first have the second from then on. The first leaves the vocabulary and
 * stays as another way of writing the second, with everything that led to
 * it.
 *
 * What the owner said of the first tag on a bookmark follows it only as far
 * as the owner meant it. A tag the owner added there is added under the
 * second name. A tag the owner took off there stays off where the second
 * would otherwise arrive on that bookmark through this merge alone: the
 * classifier gave it the first and not the second. Where the bookmark has
 * the second in its own right, the owner said nothing about it and it
 * stays. In both cases the owner's own word on the second tag, where there
 * is one, stands as it was.
 */
export function mergeTags(
  store: Store,
  from: string,
  into: string,
  options: { now?: Date } = {},
): VocabularyChange {
  const db = connectionOf(store);
  const at = timeOf(options.now);
  const merge = db.transaction((): VocabularyChange => {
    const gone = activeTag(db, from);
    const kept = activeTag(db, into);
    if (gone === kept) {
      throw new RangeError(`"${from}" and "${into}" are the same tag.`);
    }
    const bookmarks = having(db, gone);
    // Before the classifier's rows move, while they still say which of the
    // two tags each bookmark was given.
    db.prepare(
      `INSERT OR IGNORE INTO bookmark_tag_corrections (post_id, tag, action, corrected_at)
       SELECT x.post_id, @kept, x.action, x.corrected_at
       FROM bookmark_tag_corrections x
       WHERE x.tag = @gone AND (
         x.action = 'add'
         OR (EXISTS (SELECT 1 FROM bookmark_tags t
                     WHERE t.post_id = x.post_id AND t.tag = @gone)
             AND NOT EXISTS (SELECT 1 FROM bookmark_tags t
                             WHERE t.post_id = x.post_id AND t.tag = @kept)))`,
    ).run({ gone, kept });
    db.prepare(
      `INSERT OR IGNORE INTO bookmark_tags (post_id, tag)
       SELECT post_id, @kept FROM bookmark_tags WHERE tag = @gone`,
    ).run({ gone, kept });
    for (const table of ["bookmark_tags", "bookmark_tag_corrections"]) {
      db.prepare(`DELETE FROM ${table} WHERE tag = ?`).run(gone);
    }
    db.prepare("UPDATE tag_aliases SET tag = ? WHERE tag = ?").run(kept, gone);
    db.prepare("DELETE FROM tags WHERE tag = ?").run(gone);
    pointAlias(db, gone, kept, at);
    return {
      tag: kept,
      bookmarks,
      vocabularyVersion: record(db, "merge", kept, gone, at),
    };
  });
  return merge.immediate();
}

/**
 * Settles every stored proposal the vocabulary has since come to know: a
 * text that is now a tag or another way of writing one is put on the
 * bookmarks it was proposed for, and one that was dismissed or retired is
 * dropped. The functions above settle as they go; this is for a database
 * whose vocabulary was changed some other way, such as a restored backup.
 * Returns how many proposals were settled.
 */
export function settleTagProposals(store: Store): number {
  const db = connectionOf(store);
  const settle = db.transaction(() => {
    const proposals = db
      .prepare<[], string>(`SELECT DISTINCT p.value ${FROM_PROPOSALS}`)
      .pluck()
      .all();
    let settled = 0;
    for (const proposal of proposals) {
      const known = suggestionOf(db, proposal);
      if (known === undefined) continue;
      settleProposal(db, proposal, known);
      settled += 1;
    }
    return settled;
  });
  return settle.immediate();
}

/** One tag of the vocabulary. */
export interface TagInfo {
  tag: string;
  /** `starter` for a tag the library began with; `owner` for one added since. */
  origin: "starter" | "owner";
  addedAt: Date;
  /** Set for a tag that was retired. Only listed when asked for. */
  retiredAt: Date | null;
  /** How many bookmarks have it. For a retired tag, how many would get it back. */
  bookmarks: number;
  /** The other ways it is written. */
  aliases: string[];
}

/**
 * The tags of the vocabulary, most used first, with their aliases. Retired
 * tags are left out unless asked for.
 */
export function listTags(
  store: Store,
  options: { includeRetired?: boolean } = {},
): TagInfo[] {
  const db = connectionOf(store);
  const aliases = new Map<string, string[]>();
  for (const [alias, tag] of db
    .prepare<[], [string, string]>(
      "SELECT alias, tag FROM tag_aliases WHERE tag IS NOT NULL ORDER BY alias",
    )
    .raw()
    .all()) {
    aliases.set(tag, [...(aliases.get(tag) ?? []), alias]);
  }
  return db
    .prepare<
      [],
      {
        tag: string;
        origin: TagInfo["origin"];
        addedAt: number;
        retiredAt: number | null;
        bookmarks: number;
      }
    >(
      `SELECT t.tag AS tag, t.origin AS origin, t.added_at AS addedAt,
              t.retired_at AS retiredAt,
              CASE WHEN t.retired_at IS NULL
                THEN (SELECT count(*) FROM bookmark_effective_tags e WHERE e.tag = t.tag)
                -- What bookmark_effective_tags would hold of it were it not
                -- retired: the classifier's, less those the owner spoke on,
                -- plus those the owner added.
                ELSE (
                  SELECT count(*) FROM (
                    SELECT b.post_id FROM bookmark_tags b
                    WHERE b.tag = t.tag AND NOT EXISTS (
                      SELECT 1 FROM bookmark_tag_corrections x
                      WHERE x.post_id = b.post_id AND x.tag = b.tag)
                    UNION ALL
                    SELECT x.post_id FROM bookmark_tag_corrections x
                    WHERE x.tag = t.tag AND x.action = 'add'))
              END AS bookmarks
       FROM tags t
       ${options.includeRetired === true ? "" : "WHERE t.retired_at IS NULL"}
       ORDER BY t.retired_at IS NOT NULL, bookmarks DESC, t.tag`,
    )
    .all()
    .map((row) => ({
      ...row,
      addedAt: new Date(row.addedAt),
      retiredAt: row.retiredAt === null ? null : new Date(row.retiredAt),
      aliases: aliases.get(row.tag) ?? [],
    }));
}
