# x-bookmarks

A personal, local-first library of one person's own X bookmarks: capture them, keep them in one SQLite file, tag and search them, write a weekly digest, and let Claude query them through a local MCP server.

Built so far: `packages/core`, which owns the database; the capture path, a Chrome extension that copies the bookmark responses X's web client receives and hands them, raw, to a local Next.js app that stores them; and parsing, which turns each stored response into bookmark records as it arrives and can be re-run over every stored response when X changes a shape; the read side, which is keyword search and the query functions in core, a read-only MCP server over them (`packages/mcp`), and bookmarks removed on X kept and marked; the library UI, the app's main screen, which lists, searches and filters through the same query functions; automatic backups; and tagging underneath the UI: a taxonomy, a classifier that files each bookmark under one category, one format and a few tags by asking Claude (`packages/tagger`), and those as filters and counts in core and in the MCP server. The screens for browsing by them and for correcting them, and the digest, are later phases. The user chose the extension route; core still accepts the official X API as a source, and nothing for that route is built.

## Commands

Run from the repo root. All three pass before work is done.

```
pnpm install
pnpm typecheck
pnpm lint          # Biome: lint, format and import order. pnpm lint:fix applies the safe fixes.
pnpm test          # Vitest. One file: pnpm test packages/core/src/bookmarks.test.ts
```

When you change the extension, the ingest endpoint, what crosses between them, what the app does as it starts (the backups, the tagging passes), or the library UI and what it has the browser load, also run the end-to-end test. It loads the built extension in Playwright's Chromium against a fake X served from the test itself, compares every shape of request with and without the extension loaded, and drives the library screen, recording what the browser asks the fake's media hosts for. It takes about two minutes, and needs, once, `pnpm --filter @x-bookmarks/e2e exec playwright install chromium`. It is safe to run while the app is in use: it builds into directories of its own, keeps its data in a temporary directory and runs its app on a free port.

```
pnpm e2e
pnpm app               # build and start the local app on http://127.0.0.1:47130
pnpm pair              # print the pairing token to paste into the extension
pnpm extension:build   # compile the extension into packages/extension/dist, the directory Chrome loads
pnpm reparse           # parse every stored raw capture again; run after changing a parser
pnpm backup            # take a verified snapshot of the library now; the app takes one a day by itself
pnpm tag --dry-run     # what the classifier would send and cost; no request, no key, no change
pnpm tag               # classify what is unclassified. It calls the Claude API and spends the owner's money: only the owner runs it
pnpm fixtures:build    # rebuild the redacted parser fixtures from the real captures, and check them
pnpm fixtures:check    # check that no fixture holds anything from the real captures
```

## Layout

- `packages/core`: the only package that touches SQLite. Its public API is whatever `src/index.ts` exports.
- `packages/core/src/migrations`: the schema, as numbered migrations applied by `openStore`.
- `packages/core/src/parsers`: the response parsers, their fixtures, and the script that redacts real captures into fixtures. Its README says how a parser is written, what the real responses look like, and what to do when X changes one. Read it before touching a parser or a fixture.
- `packages/core/src/parsing.ts`: runs a parser over a stored capture, upserts the bookmarks and records the outcome. `src/post.ts` and `src/bookmarks.ts` define the bookmark record.
- `packages/core/src/library.ts`: the read API every feature is built on: `searchBookmarks`, `listBookmarks`, `summariseLibrary`, with `getBookmark` for one, `summariseMatches` for the counts beside a screen's filters and `listWithheldPosts` for the posts X no longer sends. `src/search-text.ts` reads a typed query and marks what a search found in a text; migration 5 holds the full-text index. `src/backup.ts` takes and verifies snapshots.
- `packages/core/src/taxonomy.ts`: the taxonomy, as data: the categories, the rules between them and the formats, with a version. The one place any of them is written. `src/vocabulary.ts` is the tag vocabulary, which lives in the database because the owner changes it from the interface: reading it, and every change to it (add, accept a proposal, retire, rename, merge, alias, dismiss), each carrying the bookmarks with it. `src/proposals.ts` lists the tags the classifier proposed, grouped and thresholded for review. `src/labels.ts` writes what a bookmark is filed under, the classifier's answer and the owner's corrections apart; `src/tagging.ts` holds what the classifier needs of the library: its candidates, its failures, the record of each run. Migrations 6 and 7 hold the tables.
- `packages/tagger`: the classifier, and the only code in the repo that calls Claude or sends anything of the library to a third party. `src/anthropic.ts` is the one file that sends, to `api.anthropic.com` alone; `src/input.ts` is the whole list of what is sent of a bookmark; `src/instructions.ts` builds the prompt and the output schema from core's taxonomy and from the vocabulary as it stands when a run begins; `src/run.ts` is a run; `src/automatic.ts` is the pass the app makes by itself. `pnpm tag` runs it. Its README has the commands in order, the key file, the cost and what a run guarantees. Read it, and the AI rules in `CODING_STANDARDS.md`, before touching it.
- `packages/mcp`: the MCP server Claude Code and Claude Desktop start, registered for this project in `.mcp.json`. Read-only, no network. Its README has the tools, the setup steps and what it is built around.
- `packages/extension`: the Manifest V3 capture extension. Its one export, `src/protocol.ts`, is the contract with the app: the operation allowlist, the extension id, the app's address, the shape of a capture. Its README is the user's guide to running a capture and states what the extension touches on X.
- `packages/web`: the Next.js app (App Router, shadcn/ui). Today it is the library UI at `/`, which lists, searches and filters the bookmarks; the ingest endpoint, which stores and then parses; a status page at `/status` with the capture and parse totals and the backups; and a pairing page. The list draws only the rows near the screen (`src/components/library/library-list.tsx`, on TanStack Virtual), so a test or a script reads it by scrolling, not from the page as it stands. `src/server/library.ts` is the UI's one data module, a translation onto core's query functions with no query of its own; `src/lib/x-media-policy.ts` and `src/components/library/x-media-element.tsx` hold the one exception of rule 9; `src/components/library/video-player.tsx` is the app's own video player, which drives that element and adds no request. `src/server/tagging.ts` asks the tagger for a pass over new bookmarks as the app starts, after a capture and hourly, and `GET /api/tagging` says how the tagging stands. Its README holds how the library screen is built, the media modes, the ingest threat model, the tagging passes and how Next fits this repo. Next 16 differs from older versions: read the guide under `packages/web/node_modules/next/dist/docs/` before writing Next code.
- `packages/e2e`: the end-to-end test.
- `lint/`: Biome plugins.
- `docs/research`: why the project is shaped this way.
- A new package goes in `packages/<name>` and depends on `"@x-bookmarks/core": "workspace:*"`.

Library packages have no build step. They export their TypeScript source and Node 24 runs it directly, so relative imports carry the `.ts` extension and only erasable syntax compiles (`enum` and constructor parameter properties are rejected). The two programs that a platform has to compile are the exceptions: the extension (esbuild, because Chrome cannot run TypeScript) and the web app (Next). In the web app, core's functions come from `src/server/core.ts`, which has Node load core at run time; a direct import would have Next bundle a second copy of core that rejects stores opened by the first.

## Vocabulary

- **Store**: an open database, from `openStore(path)`. Every core function takes one.
- **Raw capture**: one response from X, stored verbatim with its source, operation and received time, and with the request body when the request had one.
- **Allowlist**: the GraphQL operations the extension keeps, `CAPTURED_OPERATIONS`. Every other request X's page makes is left unread.
- **Capture key**: the id the extension gives a capture when it queues it. The app stores a key once, so the extension can re-send freely.
- **Pairing token**: the secret in `data/ingest-token`, printed by `pnpm pair` and pasted once into the extension. It is never sent: the extension signs its requests with it and the app proves its answers with it.
- **Sighting**: one bookmark as parsed out of one raw capture. `upsertBookmark` takes a sighting.
- **First-seen**: the received time of the capture a bookmark was first upserted from. X exposes no "bookmarked at" time, so "added this week" means first-seen this week.
- **Estimated bookmark time**: `estimatedBookmarkedAt`, read out of the timeline's `sortIndex` and stored beside first-seen, never in it. On 1,446 real bookmarks it fell after the post and before the capture every time, in timeline order, across three years, while first-seen is the day of the backfill for all of them. It rests on that observation, not on anything X promises.
- **Observed bookmark time**: `observedBookmarkedAt`, when X confirmed a `CreateBookmark` the extension captured. Exact, and present only for bookmarks made in the browser while capturing.
- **Bookmark time**: `bookmarkedAt`, what "when was this saved" means everywhere: the later of the observed and the estimated time, or first-seen when there is neither. Lists are ordered by it and periods are taken over it.
- **Removed on X**: a bookmark whose removal X confirmed in a captured `DeleteBookmark`, with nothing later showing it bookmarked again. It stays in the library with `removedOnXAt` set, and queries leave it out unless asked. A bookmark removed where the extension was not capturing is not known to be removed.
- **Withheld on X**: a bookmark whose post X no longer sends, because it was deleted or its author's account is protected or suspended: the timeline lists the entry with nothing in it but the id. One the library captured earlier stays, with `withheldOnXAt` set while no later capture holds it again; one it never held is known by id alone, from `listWithheldPosts`.
- **Snapshot**: one verified copy of the whole database, in the backups directory outside the repo (`X_BOOKMARKS_BACKUP_DIR`, by default `../x-bookmarks-backups`).
- **Taxonomy**: the categories (a bookmark has exactly one) and the formats (exactly one, whatever the category), `TAXONOMY` in core, fixed in that file. It has a version, raised by any change to it.
- **Vocabulary**: the tags a bookmark can have (none to a few), with the aliases each is also known by. It is in the database, not in the code: the owner adds, retires, renames and merges tags from the interface. It has a version of its own, raised by each change, and migration 7 wrote the set it starts as.
- **Behind the vocabulary**: a bookmark classified before a tag joined the vocabulary, and so never asked about it. It is not outdated. If its text mentions the tag, a `new-tags` run asks about it and can add that tag and nothing else.
- **Classification**: the classifier's answer for one bookmark: a category, a format, tags, and any tags it proposed, stored with the taxonomy version, the instructions version, the vocabulary version and the model that produced it. A bookmark with none is unclassified; one whose taxonomy or instructions version is older than the current one is outdated.
- **Correction**: the owner's own category, format or word on a tag for a bookmark. Stored apart from the classification and read before it, so no run of the classifier, a re-tagging included, can undo it.
- **Labels**: what a bookmark is filed under, `Bookmark.labels`: each part the owner's correction where there is one and the classification's otherwise.
- **Proposal**: a tag the classifier suggested that the vocabulary does not hold. It is on no bookmark. The owner decides, through core: a new tag, another way of writing an existing tag, or no tag at all. Accepting one puts the tag on the bookmarks it was proposed for.
- **Too little text**: a bookmark whose stored text does not say what it is about, such as a bare link or a few words beside media the classifier cannot see. It is filed under the category "other", marked as such, apart from a bookmark that says enough and fits no category. The share of the second kind is the taxonomy's health.
- **Instructions version**: the version of everything the tagger tells and asks the model, `INSTRUCTIONS_VERSION`, beside the taxonomy's own.
- **Tagging run**: one run of the classifier, recorded with what it set out to do, the tokens the API reported and what they cost. Only one is open at a time. A **pass** is the small run the app starts by itself.
- **Parse outcome**: what became of a capture when it was last parsed: `parsed`, `failed` (not understood, nothing taken from it) or `no-parser` (nothing parses that operation yet, which is not a failure). A capture with no outcome is pending.
- **Parse issue**: one thing a parse could not turn into a bookmark, or could only partly: a failed capture, a failed entry, a post X withholds, or a warning for a part left empty. It records a path and type names, never content.

## Rules

1. **The database is reached through `@x-bookmarks/core` only.** When you need a query core lacks, add a typed function to core and export it. Lint fails on a SQLite driver import anywhere else.
2. **Raw captures are write-once.** Store every response with `insertRawCapture` before parsing it, and pass the response text exactly as it arrived. Parsers get re-run over these rows when X changes its response shapes.
3. **First-seen is set once.** `upsertBookmark` copies it from the capture and no input carries it. Write bookmarks through `upsertBookmark`.
4. **The schema changes by adding a migration.** An applied migration is immutable: `openStore` refuses a database whose applied migrations differ from the code.
5. **Fix the convention first.** When a rule, a lint check or core's API blocks what you are doing, change the rule, the check or the API in the open and say why. A one-off workaround around any of them is a defect.
6. **Bookmark data stays out of git.** Database files live under `data/`. `.gitignore` covers them, unredacted captures and env files; committed fixtures are redacted first.
7. **Toward X, the extension is a passive reader.** The user's account is what is at risk: accounts have been suspended for extensions that sent their own requests to X, and none are reported for reading what the page already loaded. The extension sends X nothing, changes nothing X's page sends or receives, and never scrolls, clicks or navigates. It keeps only allowlisted responses and does no parsing. It is a faithful wrapper, not a hidden one: nothing is added only to conceal it.
8. **Only the paired extension writes to the app, and the extension hands captures only to the app.** Every route that accepts data calls `refuseUnlessExtension` before reading the body, the app listens on 127.0.0.1 only, no response carries a CORS header, and the token appears on no page. The extension sends a capture only after the app has proved it holds the token.
9. **Nothing here ever requests anything from X.** No code, agent or person working on this repo sends a request to a host X owns (`x.com`, `twitter.com`, `t.co`, `twimg.com` and their subdomains): no fetching a post, resolving a `t.co` link, downloading media, or calling the oEmbed or syndication endpoints, logged in or not. The user's account is the asset at risk; accounts have been suspended over extensions that sent their own requests. What a capture lacks stays missing. Only the user, by hand in their own browser, visits X; tests use the fake X in `packages/e2e`. One exception, decided by the user: the library UI may have the user's own browser load a post's media from X's media CDN when the user asks for it on that post, or, with a setting that is off by default, for the posts currently on screen. Never avatars, never in bulk or ahead of need, never from server code. The X rules in `CODING_STANDARDS.md` hold the checkable form, checked by `packages/core/src/no-requests-to-x.test.ts`.

10. **Features read the library through core's query functions, and the MCP server only reads.** `searchBookmarks`, `listBookmarks`, `getBookmark` and `summariseLibrary` are the one read API; a feature that needs another query adds it there. The MCP server opens the database read-only, imports nothing that writes, makes no network request, and returns bookmark text as quoted data under a notice, because that text was written by strangers.

11. **One package sends the library anywhere, to one host, and only these fields.** `packages/tagger` is the only code that calls Claude; its `src/anthropic.ts` sends to `api.anthropic.com` and nowhere else; and what it sends of a bookmark is the post's text, language, reply flag, media kinds and descriptions, link card, article title and opening, and the same of the quoted post, with no id, author, time, count or stored address. Nothing is fetched to add to it, from X or anywhere. The API key is one line of the git-ignored `.env` at the repo's root, under `X_BOOKMARKS_ANTHROPIC_API_KEY`, a name of this project's own, and the tagger reads it from that file alone: it is never taken from or put into an environment, and never named `ANTHROPIC_API_KEY`, which would silently bill the owner's Claude Code work to the API wherever it was set. No test, and no agent, makes a real call or runs `pnpm tag` without `--dry-run`: a run spends the owner's money and is the owner's to start. The AI rules in `CODING_STANDARDS.md` hold the checkable form.

12. **The taxonomy is in one file, the vocabulary is in the database, and the owner's corrections are never overwritten.** Every category and format is in `packages/core/src/taxonomy.ts` and nowhere else; a change to it raises its version. Every tag and alias is in the database and nowhere else, and is changed only through the functions of `packages/core/src/vocabulary.ts`: no source file lists a tag. The classifier writes its answers through `recordClassification`, the owner's corrections are written through `correctBookmark`, the two have tables of their own, and what a bookmark is filed under is read with the owner's word first. A tag outside the vocabulary is never put on a bookmark, and adding a tag never moves a bookmark: it can only add that tag.

`CODING_STANDARDS.md` holds the checkable form of these rules with their reasons. Read it before changing `packages/core`, `biome.json`, a tsconfig or `.gitignore`, and before reviewing a diff.

## Research

Read the note that covers your task before deciding anything it covers. Each one labels what is verified, reported and inferred.

- `docs/research/no-api-extraction.md`: capturing through a browser extension, the shape of X's web responses as other tools read them, the handoff from extension to local app, terms-of-service risk. It was written before any capture; `packages/core/src/parsers/README.md` records what the real responses turned out to look like, and wins where they differ.
- `docs/research/x-api.md`: the official API route, its cost, its history and folder limits, auth, storage terms.
- `docs/research/ai-layer.md`: search (FTS5, embeddings), tagging and taxonomy, the MCP server, the weekly digest, the phase order. It was written before tagging was built; `packages/tagger/README.md` records what was built, and wins where they differ.
