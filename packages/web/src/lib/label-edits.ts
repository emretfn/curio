/**
 * What a row's tag list needs worked out, as plain functions: the order the
 * vocabulary is offered in, and what a switch of tags comes to as the
 * owner's correction. Kept apart from the components so that each can be
 * tested as it is.
 */

/**
 * The vocabulary's tags as a post's list offers them: the post's own first,
 * then the rest, each part in the vocabulary's order. Worked out once, as
 * the list is opened, and not again while it is open: a tag that moved when
 * it was switched would put another under the pointer for the next press.
 */
export function offeredTags(
  vocabulary: readonly string[],
  onThePost: readonly string[],
): string[] {
  const has = new Set(onThePost);
  return [
    ...vocabulary.filter((tag) => has.has(tag)),
    ...vocabulary.filter((tag) => !has.has(tag)),
  ];
}

/** The owner's word on a bookmark's tags, as the route that corrects a bookmark takes it. */
export interface TagChange {
  addTags: string[];
  removeTags: string[];
  resetTags: string[];
}

/**
 * What switching a post's tags from `now` to `next` asks of the app. A tag
 * put on, or taken off, is the owner's word. One that ends where the
 * classifier had it is handed back instead: the owner has nothing left to
 * say of it, and a later run of the classifier decides it again.
 */
export function tagChange(
  next: readonly string[],
  now: readonly string[],
  classifiers: readonly string[],
): TagChange {
  const wanted = new Set(next);
  const had = new Set(now);
  const given = new Set(classifiers);
  const change: TagChange = { addTags: [], removeTags: [], resetTags: [] };
  for (const tag of new Set([...next, ...now])) {
    if (wanted.has(tag) === had.has(tag)) continue;
    if (wanted.has(tag) === given.has(tag)) change.resetTags.push(tag);
    else if (wanted.has(tag)) change.addTags.push(tag);
    else change.removeTags.push(tag);
  }
  return change;
}
