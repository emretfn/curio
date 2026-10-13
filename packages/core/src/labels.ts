/**
 * Writing what a bookmark is filed under. Two hands write, and each has
 * functions and tables of its own:
 *
 * - The classifier calls `recordClassification`. It replaces the
 *   classifier's earlier answer for that bookmark and touches nothing else.
 * - The owner calls `correctBookmark`. A correction is stored apart and is
 *   read first, so no later run of the classifier can undo it.
 *
 * A tag outside the vocabulary is never put on a bookmark. What the
 * classifier suggests is kept as a proposal until the owner accepts or
 * dismisses it: `vocabulary.ts` holds the vocabulary and every change to
 * it, and `proposals.ts` lists the proposals worth a look.
 *
 * Everything written is checked here, whoever calls: the category and the
 * format against `TAXONOMY`, the tags against the vocabulary as it stands.
 */
import { type Bookmark, getBookmark } from "./bookmarks.ts";
import { connectionOf, type Store } from "./store.ts";
import {
  foldTagText,
  isCategoryId,
  isFormatId,
  MAX_TAG_LENGTH,
  OTHER_CATEGORY,
  TAG_SHAPE,
  TAXONOMY,
} from "./taxonomy.ts";
import {
  resolveIn,
  suggestionOf,
  tagOf,
  vocabularyVersion,
} from "./vocabulary.ts";

type Connection = ReturnType<typeof connectionOf>;

const idsOf = (entries: readonly { id: string }[]) =>
  entries.map(({ id }) => id).join(", ");

/** Package-internal: the category id, or a refusal that names the ids there are. */
export function categoryOf(value: string): string {
  const id = value.trim().toLowerCase();
  if (!isCategoryId(id)) {
    throw new RangeError(
      `"${value}" is not a category. The categories are: ${idsOf(TAXONOMY.categories)}.`,
    );
  }
  return id;
}

/** Package-internal: the format id, or a refusal that names the ids there are. */
export function formatOf(value: string): string {
  const id = value.trim().toLowerCase();
  if (!isFormatId(id)) {
    throw new RangeError(
      `"${value}" is not a format. The formats are: ${idsOf(TAXONOMY.formats)}.`,
    );
  }
  return id;
}

function assertBookmark(db: Connection, postId: string): void {
  const found = db
    .prepare<[string], number>("SELECT 1 FROM bookmarks WHERE post_id = ?")
    .pluck()
    .get(postId);
  if (found === undefined) {
    throw new Error(`The library holds no bookmark ${postId}.`);
  }
}

const timeOf = (date: Date | undefined) => (date ?? new Date()).getTime();

/** What the classifier answered for one bookmark. */
export interface NewClassification {
  postId: string;
  category: string;
  format: string;
  /** Tags of the vocabulary: `TAXONOMY.maxTagsPerPost` at most. */
  tags: readonly string[];
  /**
   * What it suggested beyond the vocabulary, as it wrote it. One that turns
   * out to be another way of writing a tag becomes that tag; one the owner
   * has ruled out, or that is not shaped like a tag, is dropped; the rest
   * are kept as proposals, `TAXONOMY.maxProposedTagsPerPost` at most.
   */
  proposedTags?: readonly string[];
  /** The stored text was too little to tell. The category is then "other". */
  tooLittleText: boolean;
  /** The version of the classifier's instructions that produced this. */
  instructionsVersion: number;
  /**
   * The version of the vocabulary the classifier was given. The current one
   * unless said: a batch is answered some time after it was asked.
   */
  vocabularyVersion?: number | undefined;
  /** The model that answered. Null only where none was asked, with `tooLittleText`. */
  model: string | null;
  classifiedAt?: Date;
}

/**
 * Stores the classifier's answer for a bookmark, in place of its earlier
 * one, under the current version of the taxonomy, and clears any failure
 * recorded for it. The owner's corrections are not read and not written:
 * a bookmark the owner has filed stays where the owner put it.
 *
 * Throws for anything the taxonomy does not hold, so that a mistake in a
 * caller cannot put an unknown category or tag into the library.
 */
export function recordClassification(
  store: Store,
  classification: NewClassification,
): void {
  const db = connectionOf(store);
  const category = categoryOf(classification.category);
  const format = formatOf(classification.format);
  if (classification.tooLittleText && category !== OTHER_CATEGORY) {
    throw new RangeError(
      `A bookmark with too little text to tell is filed under "${OTHER_CATEGORY}", not "${category}".`,
    );
  }
  if (classification.model === null && !classification.tooLittleText) {
    throw new RangeError(
      "A classification no model made is only for a bookmark with too little text to send.",
    );
  }
  if (
    !Number.isInteger(classification.instructionsVersion) ||
    classification.instructionsVersion < 1
  ) {
    throw new RangeError("instructionsVersion must be a whole number above 0.");
  }
  const record = db.transaction(() => {
    assertBookmark(db, classification.postId);
    const current = vocabularyVersion(db);
    const asked = classification.vocabularyVersion ?? current;
    if (!Number.isInteger(asked) || asked < 1 || asked > current) {
      throw new RangeError(
        `vocabularyVersion must be a version the vocabulary has had, from 1 to ${current}; got ${asked}.`,
      );
    }
    const tags = new Set<string>();
    for (const tag of classification.tags) {
      if (suggestionOf(db, tag) !== tag) {
        throw new RangeError(
          `"${tag}" is not a tag of the vocabulary as it stands. A suggestion for a new tag goes in proposedTags.`,
        );
      }
      tags.add(tag);
    }
    if (tags.size > TAXONOMY.maxTagsPerPost) {
      throw new RangeError(
        `A bookmark has at most ${TAXONOMY.maxTagsPerPost} tags; got ${tags.size}.`,
      );
    }
    const proposals = new Set<string>();
    for (const suggested of classification.proposedTags ?? []) {
      const folded = foldTagText(suggested);
      const known = suggestionOf(db, folded);
      if (known === null) continue;
      if (known !== undefined) {
        if (tags.size < TAXONOMY.maxTagsPerPost) tags.add(known);
      } else if (
        TAG_SHAPE.test(folded) &&
        folded.length <= MAX_TAG_LENGTH &&
        proposals.size < TAXONOMY.maxProposedTagsPerPost
      ) {
        proposals.add(folded);
      }
    }
    db.prepare(
      `INSERT INTO bookmark_classifications (
         post_id, category, format, too_little_text, proposed_tags,
         taxonomy_version, instructions_version, vocabulary_version, model,
         classified_at
       )
       VALUES (
         @postId, @category, @format, @tooLittleText, @proposedTags,
         @taxonomyVersion, @instructionsVersion, @vocabularyVersion, @model,
         @classifiedAt
       )
       ON CONFLICT (post_id) DO UPDATE SET
         category = excluded.category,
         format = excluded.format,
         too_little_text = excluded.too_little_text,
         proposed_tags = excluded.proposed_tags,
         taxonomy_version = excluded.taxonomy_version,
         instructions_version = excluded.instructions_version,
         vocabulary_version = excluded.vocabulary_version,
         model = excluded.model,
         classified_at = excluded.classified_at`,
    ).run({
      postId: classification.postId,
      category,
      format,
      tooLittleText: classification.tooLittleText ? 1 : 0,
      proposedTags: JSON.stringify([...proposals].toSorted()),
      taxonomyVersion: TAXONOMY.version,
      instructionsVersion: classification.instructionsVersion,
      vocabularyVersion: asked,
      model: classification.model,
      classifiedAt: timeOf(classification.classifiedAt),
    });
    db.prepare("DELETE FROM bookmark_tags WHERE post_id = ?").run(
      classification.postId,
    );
    const insert = db.prepare(
      "INSERT INTO bookmark_tags (post_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) insert.run(classification.postId, tag);
    db.prepare("DELETE FROM classification_failures WHERE post_id = ?").run(
      classification.postId,
    );
  });
  record.immediate();
}

/** The owner's word on one bookmark. A part left out is left as it is. */
export interface Correction {
  /** A category id, or null to hand the category back to the classifier. */
  category?: string | null | undefined;
  /** A format id, or null to hand the format back to the classifier. */
  format?: string | null | undefined;
  /** Tags to put on the bookmark, whatever the classifier says. A tag may be written as one of its aliases. */
  addTags?: readonly string[] | undefined;
  /** Tags to keep off the bookmark, whatever the classifier says. */
  removeTags?: readonly string[] | undefined;
  /** Tags to hand back to the classifier: the owner's word on each is forgotten. */
  resetTags?: readonly string[] | undefined;
  correctedAt?: Date | undefined;
}

/**
 * Records what the owner says a bookmark is filed under, and returns the
 * bookmark as it then stands. A correction is kept apart from the
 * classifier's answer and is read before it, so it holds through every
 * later run, a re-tagging under a new taxonomy included.
 */
export function correctBookmark(
  store: Store,
  postId: string,
  correction: Correction,
): Bookmark {
  const db = connectionOf(store);
  const at = timeOf(correction.correctedAt);
  const correct = db.transaction(() => {
    assertBookmark(db, postId);
    const current = db
      .prepare<[string], { category: string | null; format: string | null }>(
        "SELECT category, format FROM bookmark_corrections WHERE post_id = ?",
      )
      .get(postId) ?? { category: null, format: null };
    const category =
      correction.category === undefined
        ? current.category
        : correction.category === null
          ? null
          : categoryOf(correction.category);
    const format =
      correction.format === undefined
        ? current.format
        : correction.format === null
          ? null
          : formatOf(correction.format);
    if (category === null && format === null) {
      db.prepare("DELETE FROM bookmark_corrections WHERE post_id = ?").run(
        postId,
      );
    } else if (category !== current.category || format !== current.format) {
      db.prepare(
        `INSERT INTO bookmark_corrections (post_id, category, format, corrected_at)
         VALUES (@postId, @category, @format, @at)
         ON CONFLICT (post_id) DO UPDATE SET
           category = excluded.category,
           format = excluded.format,
           corrected_at = excluded.corrected_at`,
      ).run({ postId, category, format, at });
    }

    const decide = db.prepare(
      `INSERT INTO bookmark_tag_corrections (post_id, tag, action, corrected_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (post_id, tag) DO UPDATE SET
         action = excluded.action,
         corrected_at = excluded.corrected_at`,
    );
    for (const tag of correction.addTags ?? []) {
      decide.run(postId, tagOf(db, tag), "add", at);
    }
    for (const tag of correction.removeTags ?? []) {
      decide.run(postId, tagOf(db, tag), "remove", at);
    }
    const forget = db.prepare(
      "DELETE FROM bookmark_tag_corrections WHERE post_id = ? AND tag = ?",
    );
    for (const tag of correction.resetTags ?? []) {
      // By its folded text as well: a tag the vocabulary has since dropped
      // no longer resolves, and its correction must still be forgettable.
      forget.run(postId, resolveIn(db, tag) ?? foldTagText(tag));
    }
  });
  correct.immediate();
  const bookmark = getBookmark(store, postId);
  if (bookmark === undefined) {
    throw new Error(`Bookmark ${postId} is missing after its correction.`);
  }
  return bookmark;
}

/** What the classifier said of the tags a bookmark had never been asked about. */
export interface NewTagsAnswer {
  postId: string;
  /** The tags of its answer. Only those added to the vocabulary since the bookmark was classified are taken. */
  tags: readonly string[];
  /** The version of the vocabulary the classifier was given: the current one unless said. */
  vocabularyVersion?: number | undefined;
}

/**
 * Stores the outcome of asking the classifier again about a bookmark that
 * was classified before some tags existed. Of its answer only those tags
 * are taken, the ones the bookmark had never been asked about, and they are
 * added to what it has: its category, its format and its other tags stay
 * exactly as they were, so a pass like this can never move a bookmark the
 * owner has learnt where to find. The bookmark then counts as asked about
 * the whole vocabulary of that version. Returns the tags it gained.
 */
export function recordNewTags(store: Store, answer: NewTagsAnswer): string[] {
  const db = connectionOf(store);
  const record = db.transaction(() => {
    const classified = db
      .prepare<[string], number>(
        "SELECT vocabulary_version FROM bookmark_classifications WHERE post_id = ?",
      )
      .pluck()
      .get(answer.postId);
    if (classified === undefined) {
      throw new Error(
        `Bookmark ${answer.postId} has no classification to add tags to.`,
      );
    }
    const current = vocabularyVersion(db);
    const asked = answer.vocabularyVersion ?? current;
    if (!Number.isInteger(asked) || asked < 1 || asked > current) {
      throw new RangeError(
        `vocabularyVersion must be a version the vocabulary has had, from 1 to ${current}; got ${asked}.`,
      );
    }
    if (asked <= classified) return [];
    const isNew = db
      .prepare<[string, number, number], number>(
        `SELECT 1 FROM tags
         WHERE tag = ? AND retired_at IS NULL
           AND added_version > ? AND added_version <= ?`,
      )
      .pluck();
    const put = db.prepare(
      "INSERT OR IGNORE INTO bookmark_tags (post_id, tag) VALUES (?, ?)",
    );
    const gained: string[] = [];
    for (const tag of new Set(answer.tags)) {
      if (isNew.get(tag, classified, asked) !== 1) continue;
      if (put.run(answer.postId, tag).changes > 0) gained.push(tag);
    }
    db.prepare(
      "UPDATE bookmark_classifications SET vocabulary_version = ? WHERE post_id = ?",
    ).run(asked, answer.postId);
    return gained;
  });
  return record.immediate();
}
