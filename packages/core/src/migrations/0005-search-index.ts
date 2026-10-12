import type { Migration } from "../migrate.ts";

export const migration: Migration = {
  version: 5,
  name: "search-index",
  sql: `
-- The words a bookmark can be found by, one row per bookmark, as five
-- columns that search weighs differently:
--   text     the post's own text, which holds its links written out in full
--   author   the author's handle and display name
--   title    the headline of what the post points at: its link card's title
--            and its X Article's title
--   quoted   the quoted post: its author, its text, and its headlines
--   detail   the rest: the card's description and site, the article's
--            opening excerpt, and the descriptions of the media
--
-- Every 'ı' (dotless i) is written as 'i'. The tokenizer below folds case and
-- strips the marks of ş, ç, ğ, ö and ü, but leaves 'ı' alone, so without this
-- "ışık" would not be found by "IŞIK" or by "isik" typed on a keyboard that
-- has no 'ı'. Queries are folded the same way, in src/search.ts. The fold
-- replaces one character with one, so positions in this text are positions
-- in the original.
CREATE VIEW bookmark_search_text AS
SELECT
  b.id AS id,
  replace(b.text, 'ı', 'i') AS text,
  replace(b.author_handle || ' ' || b.author_name, 'ı', 'i') AS author,
  replace(concat_ws(' ', b.card ->> '$.title', b.article ->> '$.title'), 'ı', 'i') AS title,
  replace(
    CASE WHEN b.quoted ->> '$.available' THEN
      concat_ws(' ',
        b.quoted ->> '$.authorHandle',
        b.quoted ->> '$.authorName',
        b.quoted ->> '$.text',
        b.quoted ->> '$.card.title',
        b.quoted ->> '$.article.title')
    ELSE '' END,
    'ı', 'i') AS quoted,
  replace(
    concat_ws(' ',
      b.card ->> '$.description',
      b.card ->> '$.domain',
      b.article ->> '$.previewText',
      (SELECT group_concat(item.value ->> '$.altText', ' ') FROM json_each(b.media) AS item)),
    'ı', 'i') AS detail
FROM bookmarks b;

-- The full-text index over that view, keyed by bookmarks.id. It is derived
-- data: the triggers below keep it equal to the view, and it can be emptied
-- and filled again from the view at any time.
--
-- unicode61 splits on anything that is not a letter or a digit and folds
-- case; remove_diacritics 2 also strips accents, so a word matches however
-- it was typed. There is no stemmer on purpose: the only one SQLite has is
-- English, and a third of the library is Turkish. Word forms are reached by
-- prefix queries instead, which suit a language that adds its endings on.
CREATE VIRTUAL TABLE bookmark_search USING fts5(
  text, author, title, quoted, detail,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO bookmark_search (rowid, text, author, title, quoted, detail)
SELECT id, text, author, title, quoted, detail FROM bookmark_search_text;

CREATE TRIGGER bookmark_search_after_insert
AFTER INSERT ON bookmarks
BEGIN
  INSERT INTO bookmark_search (rowid, text, author, title, quoted, detail)
  SELECT id, text, author, title, quoted, detail
  FROM bookmark_search_text WHERE id = NEW.id;
END;

-- Only when something searchable changed: an upsert that finds the same
-- content, as every sighting after the first usually does, leaves the index
-- as it was.
CREATE TRIGGER bookmark_search_after_update
AFTER UPDATE ON bookmarks
WHEN NEW.id IS NOT OLD.id
  OR NEW.text IS NOT OLD.text
  OR NEW.author_handle IS NOT OLD.author_handle
  OR NEW.author_name IS NOT OLD.author_name
  OR NEW.card IS NOT OLD.card
  OR NEW.article IS NOT OLD.article
  OR NEW.quoted IS NOT OLD.quoted
  OR NEW.media IS NOT OLD.media
BEGIN
  DELETE FROM bookmark_search WHERE rowid = OLD.id;
  INSERT INTO bookmark_search (rowid, text, author, title, quoted, detail)
  SELECT id, text, author, title, quoted, detail
  FROM bookmark_search_text WHERE id = NEW.id;
END;

CREATE TRIGGER bookmark_search_after_delete
AFTER DELETE ON bookmarks
BEGIN
  DELETE FROM bookmark_search WHERE rowid = OLD.id;
END;
`,
};
