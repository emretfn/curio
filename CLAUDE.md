# x-bookmarks

A personal, local-first library of one person's own X bookmarks: capture them, keep them in one SQLite file, tag and search them, write a weekly digest, and let Claude query them through a local MCP server.

Built so far: the workspace and `packages/core`, which owns the database. Capture, parsing, search, tagging, the digest, the MCP server and the web app are later phases. The capture route (browser extension or official X API) is undecided, so core serves both; build route-specific code only when your brief names the route.

## Commands

Run from the repo root. All three pass before work is done.

```
pnpm install
pnpm typecheck
pnpm lint          # Biome: lint, format and import order. pnpm lint:fix applies the safe fixes.
pnpm test          # Vitest. One file: pnpm test packages/core/src/bookmarks.test.ts
```

## Layout

- `packages/core`: the only package that touches SQLite. Its public API is whatever `src/index.ts` exports.
- `packages/core/src/migrations`: the schema, as numbered migrations applied by `openStore`.
- `packages/core/src/parsers`: where response parsers and their fixtures go. Read its README before writing one.
- `docs/research`: why the project is shaped this way.
- A new package goes in `packages/<name>` and depends on `"@x-bookmarks/core": "workspace:*"`.

There is no build step. Packages export their TypeScript source and Node 24 runs it directly, so relative imports carry the `.ts` extension and only erasable syntax compiles (`enum` and constructor parameter properties are rejected).

## Vocabulary

- **Store**: an open database, from `openStore(path)`. Every core function takes one.
- **Raw capture**: one response from X, stored verbatim with its source, operation and received time.
- **Sighting**: one bookmark as parsed out of one raw capture. `upsertBookmark` takes a sighting.
- **First-seen**: the received time of the capture a bookmark was first upserted from. X exposes no "bookmarked at" time, so "added this week" means first-seen this week.

## Rules

1. **The database is reached through `@x-bookmarks/core` only.** When you need a query core lacks, add a typed function to core and export it. Lint fails on a SQLite driver import anywhere else.
2. **Raw captures are write-once.** Store every response with `insertRawCapture` before parsing it, and pass the response text exactly as it arrived. Parsers get re-run over these rows when X changes its response shapes.
3. **First-seen is set once.** `upsertBookmark` copies it from the capture and no input carries it. Write bookmarks through `upsertBookmark`.
4. **The schema changes by adding a migration.** An applied migration is immutable: `openStore` refuses a database whose applied migrations differ from the code.
5. **Fix the convention first.** When a rule, a lint check or core's API blocks what you are doing, change the rule, the check or the API in the open and say why. A one-off workaround around any of them is a defect.
6. **Bookmark data stays out of git.** Database files live under `data/`. `.gitignore` covers them, unredacted captures and env files; committed fixtures are redacted first.

`CODING_STANDARDS.md` holds the checkable form of these rules with their reasons. Read it before changing `packages/core`, `biome.json`, a tsconfig or `.gitignore`, and before reviewing a diff.

## Research

Read the note that covers your task before deciding anything it covers. Each one labels what is verified, reported and inferred.

- `docs/research/no-api-extraction.md`: capturing through a browser extension, the shape of X's web responses, why first-seen stands in for bookmark time, the handoff from extension to local app, terms-of-service risk.
- `docs/research/x-api.md`: the official API route, its cost, its history and folder limits, auth, storage terms.
- `docs/research/ai-layer.md`: search (FTS5, embeddings), tagging and taxonomy, the MCP server, the weekly digest, the phase order.
