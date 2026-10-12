# Parsers

A parser turns the `payload` of one raw capture into what it holds: bookmarks, or for a mutation the post that was bookmarked or un-bookmarked, and an account of everything it did not understand. It is a pure function, `CaptureParser` in `parsed.ts`: text in, a `ParsedCapture` out, with no database access. Its second argument is the capture's stored request body, which a mutation needs because its response does not name the post. `parseCapture` in `../parsing.ts` is the one caller. It looks the parser up by the capture's `(source, operation)`, upserts the bookmarks with `upsertBookmark`, records a mutation with `recordMutation`, and records the outcome.

## What exists

| Source | Operation | Parser | Written against |
|---|---|---|---|
| `x-web-client` | `Bookmarks` | `x-web-client/Bookmarks.ts`, with `post.ts` for the post itself | 76 real pages, 1,450 entries, captured 2026-10-12 |
| `x-web-client` | `BookmarkFoldersSlice` | `x-web-client/BookmarkFoldersSlice.ts` | one real response, from an account with no folders. It understands the empty list only |
| `x-web-client` | `BookmarkFolderTimeline` | none yet | no real sample |
| `x-web-client` | `CreateBookmark`, `DeleteBookmark` | `x-web-client/CreateBookmark.ts` and `DeleteBookmark.ts`, both made by `mutation.ts` | one real sample of each, captured 2026-10-12, of a post bookmarked and un-bookmarked three seconds later. They understand X's confirmation, `Done`, and nothing else |
| `x-api-v2` | any | none yet | no real sample |

A capture whose operation has no parser is recorded as `no-parser`, which is not a failure, and is parsed by the next re-parse after a parser is added to the table in `index.ts`.

## Rules for a parser

- One parser per `(source, operation)` pair, in `<source>/<operation>.ts`, with its test beside it as `<operation>.test.ts`, registered in `index.ts`.
- **Read through `shape.ts`.** Its readers carry the path they took, so a mismatch says where it is, what was expected and what was found. Do not index into the JSON directly.
- **Never guess.** A payload that matches no known shape is `{ outcome: "failed" }`, never an empty list: an empty list means "this response held no bookmarks", and X breaking a parser must not look like that. A type name, a media type or a card layout with no case for it is an `unknown-variant`, not a best effort.
- **Missing stays missing.** What a response does not hold (the rest of a thread, an article's body, where a `t.co` link leads, a post X withholds) is recorded as absent. Nothing is fetched from X to fill it in, now or later: "Requests to X" in `CODING_STANDARDS.md`.
- **Never drop.** Every timeline entry that is not a cursor comes back as a bookmark, as a post X withholds, or as a failure with its reason. One entry failing does not fail the entries beside it.
- **Two grades of field.** Identity, author, text and time make a bookmark: when one does not read, the entry fails. Everything else is read as strictly, but a part that does not read is left empty and returned as a warning, so one renamed field costs that field and not the bookmark. `readPost` shows the pattern.
- **An issue describes structure, never content**: a path, field names, type names. It must be safe to store, show on the status page and paste into a bug report. `Bookmarks.test.ts` has a test that plants a secret in every kind of mismatch and looks for it in what is reported.
- Read ids from string fields (`rest_id`, `id_str`) with `id()`, never from a numeric one. Post and user ids exceed what a JavaScript number holds.
- Raise `PARSER_VERSION` in `index.ts` whenever a parser's output for the same payload changes, then run `pnpm reparse`.

## When X changes a shape

The status page shows captures failed, entries failed and parts left empty. `pnpm reparse` lists each kind of mismatch once, with its path and how many captures it is in.

1. Add a fixture that shows the new shape (below), and a test that fails on it.
2. Teach the parser the shape. Keep the old one: captures of both are in the database, and both must keep parsing.
3. Raise `PARSER_VERSION` and run `pnpm reparse`. It replays every stored capture oldest received first. Raw captures are only read; a bookmark's first-seen time is taken from the first capture it is upserted from and is never moved afterwards; running it twice changes nothing the second time.

## What the real responses look like

Observed on the 1,450 entries of 2026-10-12. Where this differs from `docs/research/no-api-extraction.md`, this is the first-hand record.

- A page is `data.bookmark_timeline_v2.timeline.instructions[0]`, of type `TimelineAddEntries`, with 20 post entries and two cursor entries. The page after the last bookmark holds the two cursors alone.
- A post is `tweet_results.result` with `__typename` `Tweet`, or `TweetWithVisibilityResults` wrapping it as `tweet`. A post X withholds is a `TweetTombstone`, or no `result` at all; the post's id then survives only in `entryId`. For a quoted post it is also `TweetUnavailable`.
- The author is `core.user_results.result`, with name and handle under its own `core` and the picture under `avatar`. There is no user `legacy` object.
- `legacy.full_text` is HTML-escaped (`&amp;`, `&lt;`, `&gt;`). `note_tweet` text is not.
- `display_text_range` and every `indices` pair count code points, not UTF-16 units. The range leaves out the `@handles` a reply opens with and the `t.co` link to the post's own media. When the media was first posted by someone else (`source_status_id_str` on the media item), its link is inside the range, and is taken out of the text all the same.
- A long-form post has its whole text in `note_tweet.note_tweet_results.result.text`, with its own `entity_set`. The same link has a different `t.co` redirect there than in the `legacy` excerpt, or is missing from the excerpt.
- A card is `card.legacy` with a `name` and `binding_values`. Read: `summary`, `summary_large_image`, `player`. Seen and not read: `unified_card` and `<id>:broadcast`. 166 of the 381 cards are a bare `rest_id` with no `legacy`, which reads as no card; every X Article post has one of those.
- An X Article is `article.article_results.result`: title, excerpt and cover image. Its body is not in the response.
- A quoted post is `quoted_status_result.result`, a full post. When that post quotes in turn, its target is in full under `nested_quoted_tweet_results`, and only its id is kept.
- `views.count` is a string, and absent on old posts.
- A mutation answers `{"data":{"tweet_bookmark_put":"Done"}}`, or `tweet_bookmark_delete` for a removal. The post is in the request body, as `variables.tweet_id`, beside a `queryId`. What X answers when a mutation fails has not been seen, so anything but `Done` is a failed capture and marks nothing.
- `sortIndex` is a string of 19 digits. `sortIndex >> 20`, read as Unix milliseconds, behaves as the time the bookmark was made: see `estimateBookmarkedAt` in `../bookmarks.ts`.

## Fixtures

Fixtures are in `fixtures/<source>/<operation>/`, one response per file, named for the date it was captured and what it shows (`2026-10-12-long-posts.json`). The formatter skips this directory. Each `Bookmarks` fixture is a real page cut down to the entries that show one family of shapes. A mutation's fixture is two files, the response and beside it the request body as `<name>.request.json`, redacted together so that they are one capture.

A response from the bookmarks timeline is personal data, and fixtures are committed, so a fixture is never saved by hand. It is built by a script and checked by another:

```
pnpm fixtures:build    # write every fixture from the real captures, then check them
pnpm fixtures:check    # check the fixtures on disk against the real captures
```

Both read the app's database, or the one given as an argument, and print counts and paths only.

- **`redaction/fixtures.ts`** says which entries become fixtures: for each pick, the first captured entry that has a given shape. An entry is chosen by what it shows, never by which post it is. It also holds the list of shape variants, and the build prints how many captured entries have each.
- **`redaction/redact.ts`** replaces everything personal and keeps the structure. It is default-deny: every string and number is replaced unless a rule in it says the value is one of X's own constants or a text offset. The same real id, handle or link becomes the same invented one everywhere, and text keeps its length in code points, so cross-references and offsets still agree. Invented values are drawn from a seeded sequence and never computed from the real ones. The build is repeatable: the same captures give the same files, byte for byte.
- **`redaction/leaks.ts`** is the check, and does not trust the redactor: it takes every value of every real capture and fails if a fixture contains one, whole or inside a longer string. The exceptions are the strings in `SHARED_STRINGS`, which are X's own constants and are listed one by one. A new entry there is a reviewed decision.

The real database exists on one machine, so `pnpm fixtures:check` can only run there, and whoever adds or rebuilds a fixture runs it before committing. What runs everywhere, in `redaction/leaks.test.ts`, is a test that every committed fixture bears the redactor's marks, which a response saved by hand would not.

To add a fixture: add a pick to `BOOKMARKS_FIXTURES`, run `pnpm fixtures:build`, and read the new file. Adding a pick to an existing fixture changes that fixture's invented values, so prefer a new fixture. Tests should take what they compare against from the fixture itself, as `Bookmarks.test.ts` does, and not from a copied id.

Unredacted responses go under the root `data/` directory or in a `*.capture.json` file, both of which git ignores.
