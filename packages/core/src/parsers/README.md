# Parsers

Empty on purpose. A parser needs real captured responses to be written against, and none exist yet.

A parser turns the `payload` of one raw capture into `BookmarkSighting`s. It is a pure function: text in, sightings out, with no database access. The caller stores the capture with `insertRawCapture`, runs the parser, and passes each sighting to `upsertBookmark` with that capture's id.

- One parser per `(source, operation)` pair, in `<source>/<operation>.ts` here, with its test beside it as `<operation>.test.ts`.
- Fixtures go in `fixtures/<source>/<operation>/`, one response per file, named for the date it was captured and what it shows (`2026-10-14-long-post.json`). The formatter skips this directory so fixtures stay as X sent them.
- When X changes a response shape, add a fixture of the new shape and keep the old ones. Captures of both shapes are in the database and both must keep parsing.
- A payload that matches no known shape is an error the caller can see, never an empty list. An empty list means "this response held no bookmarks", and X breaking a parser must not look like that.
- Read ids from string fields (`rest_id`, `id_str`), never from a numeric one. Post and user ids exceed what a JavaScript number holds.
- To re-parse after a fix, replay captures oldest received first. First-seen is taken from the first capture a bookmark is upserted from and is never moved afterwards.

Fixtures are committed, and a response from the bookmarks timeline is personal data. Cut each fixture down to the entries its test needs and remove the account owner's ids and handle before saving it here. Unredacted responses go under the root `data/` directory or in a `*.capture.json` file, both of which git ignores.
