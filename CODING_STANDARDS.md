# Coding standards

Rules a reviewer checks a diff against. Each has an id to cite and the reason it exists. `pnpm typecheck`, `pnpm lint` and `pnpm test` enforce part of this; the rules below are the part a reviewer has to look for, plus the ways the automated checks can be sidestepped.

## Database boundary

- **DB-1** Only files under `packages/core` import a SQLite driver (`better-sqlite3`, `node:sqlite`, or any other listed in `biome.json`). *Why: the invariants below live in core's functions and schema. A second connection skips the functions.*
- **DB-2** `better-sqlite3` is a dependency of `packages/core/package.json` and of no other package. *Why: pnpm then refuses to resolve it elsewhere, a second lock behind the lint rule.*
- **DB-3** Other packages import core as `@x-bookmarks/core`, never by subpath or relative path. *Why: its internal modules hold the connection.*
- **DB-4** Nothing exported from `packages/core/src/index.ts` returns a connection or statement, or accepts SQL text. `connectionOf` is not exported there. *Why: either would reopen DB-1 through the front door.*
- **DB-5** The diff adds no `biome-ignore` for `noRestrictedImports` or `noCommonJs`, no override relaxing them beyond the existing `packages/core/**` one, no `.cjs` or `.cts` file, and no `createRequire` or `process.getBuiltinModule` outside core. *Why: these are the routes around DB-1 that lint cannot see.*

## Raw captures

- **RAW-1** The `payload` given to `insertRawCapture` is the response text as received: not parsed and re-serialised, trimmed, or filtered. *Why: re-serialising rounds integers above 2^53, and anything dropped is gone when a parser later needs it.*
- **RAW-2** A response is stored with `insertRawCapture` before anything is parsed from it, including responses no parser handles yet. *Why: X changes its response shapes a few times a year and the breakage is silent; stored captures are how the gap is recovered.*
- **RAW-3** No code or migration updates or deletes `raw_captures` rows, and the `raw_captures_no_update` and `raw_captures_no_delete` triggers stay. *Why: every parsed row must be reproducible from its capture.*
- **RAW-4** `source` is a member of `CAPTURE_SOURCES`. A new capture route is added to that list in the same diff. *Why: parsers are chosen by `(source, operation)`; a misspelt source is a capture no parser will ever read.*

## First-seen

- **SEEN-1** No function parameter or input type, in core or outside it, carries a first-seen time. It is copied from the capture's `received_at` inside `upsertBookmark`. *Why: X exposes no bookmark time, so the weekly digest rests on this value. A caller-supplied time would be the parser's run time, which is wrong on every re-parse.*
- **SEEN-2** Rows in `bookmarks` are written by `upsertBookmark` only. No `INSERT OR REPLACE`, `REPLACE INTO`, or delete-then-insert touches the table. *Why: REPLACE deletes and re-inserts the row, which resets first-seen without firing the update trigger.*
- **SEEN-3** The `bookmarks_first_seen_is_immutable` trigger stays. A migration that rebuilds `bookmarks` copies `first_seen_at` and `first_seen_capture_id` unchanged and recreates the trigger. *Why: it is the last guard if SEEN-2 is missed.*
- **SEEN-4** "Added in this period" is computed from `first_seen_at`, never `posted_at` or `last_seen_at`. *Why: an old post bookmarked today has an old `posted_at`, and `last_seen_at` moves on every sync.*

## Schema and migrations

- **MIG-1** A schema change is a new file `packages/core/src/migrations/NNNN-name.ts`, numbered one above the last and added to the end of the list in `migrations/index.ts`. No `CREATE`, `ALTER` or `DROP` runs from anywhere else. *Why: `openStore` is the single place a database is brought up to date.*
- **MIG-2** A migration that already exists on the main branch is not edited, renamed or removed. *Why: its checksum is recorded in every database it ran on, and `openStore` refuses a database whose applied migrations differ from the code.*
- **MIG-3** Migration SQL contains no `BEGIN`, `COMMIT` or `ROLLBACK`. *Why: each migration runs inside one transaction so that a failure leaves the database untouched.*
- **MIG-4** New tables are `STRICT`. *Why: without it SQLite stores a string in an integer column without complaint.*
- **MIG-5** A timestamp column is an `INTEGER` holding Unix epoch milliseconds, named `*_at`, with `CHECK (col > 1000000000000)`. Core's public types expose it as `Date`. *Why: one unit and one type make comparisons in SQL correct, and the check rejects seconds passed by mistake.*
- **MIG-6** X ids (posts, users) are `TEXT` columns holding decimal digits, and `string` in TypeScript. *Why: they exceed 2^53 and lose digits as JavaScript numbers.*

## TypeScript

- **TS-1** No `any`, `@ts-ignore` or `@ts-nocheck`. `@ts-expect-error` appears only in tests, with the reason after it. *Why: the typed API of core is what keeps callers correct.*
- **TS-2** The diff does not loosen `tsconfig.base.json` or `biome.json` to make itself pass. A change to either is its own explained change (GEN-1). *Why: a relaxed check is relaxed for every later diff.*
- **TS-3** A package's `exports` points at its TypeScript source and the package has no build script. *Why: Node 24 runs the source directly, so there is one copy of the code and no stale build output.*

## Tests

- **TEST-1** Database behaviour is tested against a real temporary file from `tempDatabasePath()` or `openTempStore()`, not `:memory:` and not a mock. *Why: WAL mode, reopening and the triggers only behave as in production on a file.*
- **TEST-2** A new export from core, and a new migration, arrive with tests in the same diff. A parser arrives with at least one fixture it is tested against.
- **TEST-3** A test file sits beside the file it tests, as `name.test.ts`.

## Privacy

- **PRIV-1** The diff contains no database file, no unredacted captured response, no `.env` file, and no token or cookie value. *Why: the library is one person's private reading history, and X session cookies grant full account access.*
- **PRIV-2** A fixture is cut down to the entries its test needs and has the account owner's ids and handle removed. *Why: fixtures are committed.*
- **PRIV-3** No entry is removed from `.gitignore`.

## Dependencies

- **DEP-1** A dependency is added to the package that imports it. The root `package.json` holds tooling only.
- **DEP-2** Nothing is added to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. When pnpm holds back a release as too new, pin the previous one. *Why: the delay is a guard against freshly published malicious releases.*

## General

- **GEN-1** No one-off workaround. When a rule here, a lint check, or core's API stands in the way, the diff changes that rule, check or API openly and gives the reason, in this file where a rule changes. *Why: later work is done by agents that know only what the repo tells them. A quiet exception teaches the next one that the rule is optional.*
