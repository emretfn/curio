# AI layer for the X bookmarks library: research and design options

Researched 2026-10-12 against live docs. Every product, pricing, or API claim carries a link to the primary source that owns it (the vendor's own docs, repository, model card, or spec), not to a write-up of it. Anything marked **(inference)** is my own reasoning or arithmetic, and anything marked **(unverified)** could not be confirmed in a primary source. Section 7 collects all of those in one place.

Scope assumed: one user, macOS, a local database of a few thousand bookmarks growing by about 50 a week, TypeScript throughout. The web UI and ingestion are out of scope.

---

## 1. Recommendation

**Build one shared tool layer over a single SQLite file, expose it first as a local MCP server, and add everything else in thin layers on top.**

| Concern | Choice |
| --- | --- |
| Storage | One SQLite file via `better-sqlite3`, WAL mode |
| Keyword search | SQLite FTS5 over post text, author, tags, and an LLM-written one-line summary |
| Meaning search | Local embeddings (EmbeddingGemma 300m through Transformers.js), stored in the same SQLite file, fused with FTS results. Added in phase 4, not at the start |
| Talking to Claude | A local stdio MCP server (`@modelcontextprotocol/server`) registered in Claude Code and Claude Desktop. Runs on the existing Claude subscription, no API key |
| In-app chat | Optional last phase. Claude Agent SDK in the web app's server, pointed at the same MCP server |
| Tagging | Claude Haiku 5.5 with structured outputs. Batch API for the backfill, plain synchronous calls for the weekly trickle. Needs an API key |
| Taxonomy | Fixed category list (one per bookmark) plus a controlled tag vocabulary with a "proposed tag" escape hatch and an alias table |
| Weekly digest | An idempotent script in the project, triggered weekly by launchd with a catch-up check on app start. Output stored in a `digests` table, shown in the web app, readable through the MCP server |

**MCP or Agent SDK or both:** MCP first. It is roughly a day of work, needs no chat UI, costs nothing beyond the subscription, and answers "what did I save about X" from the tools the user already works in. The Agent SDK is worth adding only if chat inside the web app turns out to matter, and by then it reuses the same tools, so "both" costs one streaming route and a chat panel rather than a second integration.

**Cost (estimates, see 3.2):** backfill of 5,000 bookmarks on Haiku 5.5 is roughly $0.40 to $1.40. Steady state is about $0.01 a week for tagging plus $0.07 to $0.13 a week for the digest, so well under $1 a month. Embeddings are free locally. Chat through MCP adds no per-token cost because it draws on the subscription.

**One thing to check before starting:** which Claude plan the user is on. Max and Team plans now include monthly API credits ($100 on Max 5x, $200 on Max 20x) that would cover all of the API-key work here. Pro does not, so a Pro user needs to buy a small amount of API credit ([API credits for Max and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)).

---

## 2. MCP server, Agent SDK in the app, or both

### 2.1 What each one is

**Local MCP server.** A small Node process that speaks MCP over stdio and exposes tools such as `search_bookmarks`. Claude Code and Claude Desktop launch it and call its tools. The current TypeScript SDK is v2, published as `@modelcontextprotocol/server`, with `McpServer`, `registerTool`, and `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. The older `@modelcontextprotocol/sdk` v1.x line still gets fixes for at least six months after the v2 release ([typescript-sdk README](https://github.com/modelcontextprotocol/typescript-sdk), [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server)).

**Claude Agent SDK.** Claude Code packaged as a library. `query()` spawns a `claude` CLI subprocess that runs the agent loop, and the app streams messages from it ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)). Custom tools are supplied as MCP servers, either in-process with `createSdkMcpServer()` and `tool()`, or as an external stdio/HTTP server in `options.mcpServers` ([Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), [MCP in the SDK](https://code.claude.com/docs/en/agent-sdk/mcp)).

### 2.2 What each gives and costs

| | Local MCP server | Agent SDK in the web app |
| --- | --- | --- |
| Where the user talks to Claude | Claude Code, Claude Desktop, any MCP client | A chat panel inside the bookmarks app |
| What it is good at | Bookmarks become one more tool in normal work: "find that thread on Y and summarise it into my notes" | Answers sit next to the library: result cards, deep links, filters applied from chat |
| Build cost **(inference)** | About 100 to 200 lines: tool definitions plus two registration steps | A streaming route, a chat UI, session handling, and credential handling, on top of the tool layer |
| Runtime weight | One short-lived Node process started by the client | A `claude` subprocess per conversation. Docs suggest 1 GiB RAM, 5 GiB disk, 1 CPU per agent as a starting point, and describe it as a long-lived process, not a stateless API wrapper ([Hosting](https://code.claude.com/docs/en/agent-sdk/hosting)) |
| Reach | Local clients only. A locally added server is not available to cloud routines or claude.ai connectors ([Routines: Connectors](https://code.claude.com/docs/en/routines)) | Wherever the web app's server runs. Not suited to serverless hosting because of the subprocess model **(inference from the Hosting page)** |
| Billing | Subscription | Subscription or API key, see 2.3 |

Registration for the MCP server, both documented:

```bash
# Claude Code, available in every project
claude mcp add --transport stdio --scope user bookmarks -- node /ABS/PATH/dist/mcp/server.js
```

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json
{ "mcpServers": { "bookmarks": { "command": "node", "args": ["/ABS/PATH/dist/mcp/server.js"] } } }
```

Sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server).

Two details that shape the tool design:

- A stdio server must never write to stdout, because that corrupts the JSON-RPC stream. Log with `console.error` ([Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server)).
- Claude Code warns when a tool result exceeds 10,000 tokens and caps it at 25,000 by default (`MAX_MCP_OUTPUT_TOKENS`) ([Claude Code MCP](https://code.claude.com/docs/en/mcp)). So `search_bookmarks` should return compact rows (id, author, date, snippet, tags) with a default limit around 20, and `get_bookmark` should return the full record.

### 2.3 Auth and billing, as verified on 2026-10-12

This area changed twice in 2026, and third-party posts about it are now wrong, so the table below quotes only Anthropic's own pages.

| Workload | Credential | What it draws on |
| --- | --- | --- |
| Claude Code or Claude Desktop calling the local MCP server | claude.ai login | Plan usage limits, which are shared across Claude and Claude Code ([Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)) |
| Agent SDK or `claude -p`, signed in with the Claude plan | Subscription OAuth from `/login`, or a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Plan usage limits. "`claude -p` and Agent SDK usage still draw from your plan's usage limits and don't use your API credits" ([Monthly API credits for Max and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans), [Use the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-agent-sdk-with-your-claude-plan)) |
| Agent SDK or `claude -p` with `ANTHROPIC_API_KEY` | Console API key | Per-token API billing. On Max and Team, the monthly API credits are spent first ([API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)) |
| Messages API and Message Batches API (tagging, digest) | Console API key | Per-token API billing, same credits apply. These are Claude Platform products and usage "is never charged to your Claude plan" ([API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)) |

Monthly API credits, announced 2026-10-07:

- Max 5x $100, Max 20x $200, Team $20 per Standard seat and $100 per Premium seat pooled up to $500. "Free, Pro, and Enterprise plans aren't eligible."
- Claimed by linking a Claude Console organization under Settings > Billing on claude.ai. No payment method needed. New subscribers can claim after 7 days.
- They cover the Claude API (including Message Batches), Managed Agents, the Agent SDK, and the playground. They do not cover Claude Code or extra usage in the apps.
- No rollover. When they run out and there are no purchased credits, API requests stop until the next grant.

Source for all four points: [API credits for Max and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) and the [Help Center article](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans). The Help Center notes the rollout is staged over a few days, so the option may not be visible yet.

The separate "Agent SDK credit" announced in June 2026 does not exist. The June change was paused, and the Help Center now says of that credit: "That credit isn't available" ([15036540](https://support.claude.com/en/articles/15036540-use-the-agent-sdk-with-your-claude-plan), [17154008](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)). Blog posts describing a $20/$100/$200 Agent SDK credit are describing the paused plan.

**Is it allowed to run the Agent SDK on a subscription in a self-built app?** What the docs say:

- "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods" ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).
- OAuth authentication "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." Developers building products "should use API key authentication", and Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users" ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK" ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- `claude setup-token` exists for "CI pipelines, scripts, or other environments where interactive browser login isn't available", and the token "authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan" ([Authentication](https://code.claude.com/docs/en/authentication)).

My reading **(inference, not legal advice)**: the prohibition is aimed at products that offer claude.ai login to other people or route other people's requests through a plan. A personal tool on the subscriber's own machine, used only by the subscriber, is the individual Agent SDK usage the plan limits are described as covering, and the Help Center says outright that such usage draws on plan limits. It stops being fine the moment the app is shared, deployed for others, or given its own login flow. At that point it must use an API key. The Agent SDK's own setup docs only document the API-key path, so if this matters, the legal page points to sales for edge cases.

Practical consequences for this project:

1. **Credential precedence can silently switch billing.** `ANTHROPIC_API_KEY` outranks both `CLAUDE_CODE_OAUTH_TOKEN` and the `/login` credential, and in `-p` mode "the key is always used when present" ([Authentication precedence](https://code.claude.com/docs/en/authentication)). The tagging worker needs an API key, so if that key sits in the web app's environment, an in-app agent would bill the API instead of the subscription. Fix **(inference)**: keep the worker's key under a different variable name and pass it explicitly to the Anthropic client, or strip it from the SDK's `options.env`, which replaces the subprocess environment ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)).
2. **`--bare` is planned to become the default for `claude -p`**, and bare mode never reads OAuth credentials, the keychain, or `CLAUDE_CODE_OAUTH_TOKEN` ([Run Claude Code programmatically](https://code.claude.com/docs/en/headless), [Authentication](https://code.claude.com/docs/en/authentication)). Any scheduled job that relies on `claude -p` with a subscription login may need a flag change when that ships. No date is given.
3. **SDK cost figures are estimates.** `total_cost_usd` is computed client-side from a bundled price table ([Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).

### 2.4 How they compose

Put the logic in plain functions and treat both integrations as adapters:

```
src/core/         search.ts, bookmarks.ts, taxonomy.ts, digests.ts   (pure functions over SQLite)
src/mcp/server.ts registerTool(...) wrappers around core             (stdio MCP server)
web app           imports core directly for the UI and the search box
in-app agent      Agent SDK query() with the same MCP server attached
```

The in-app agent can attach the tools in either documented way:

- **Same stdio server**, which means one set of tool definitions for every client:

  ```ts
  query({
    prompt,
    options: {
      mcpServers: { bookmarks: { command: "node", args: ["/ABS/PATH/dist/mcp/server.js"] } },
      allowedTools: ["mcp__bookmarks__*"],
      tools: [],            // remove built-in file and shell tools
      settingSources: [],   // do not load ~/.claude settings or CLAUDE.md
      maxTurns: 12,
    },
  })
  ```

- **In-process** with `createSdkMcpServer({ name, tools: [tool(...)] })`, which avoids the extra process but declares the tool schemas a second time (handlers still shared).

Option facts, all from the [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) and [MCP](https://code.claude.com/docs/en/agent-sdk/mcp) pages: MCP tools are named `mcp__<server>__<tool>` and need an `allowedTools` entry to run without a prompt. `tools: []` removes all built-ins. `systemPrompt` defaults to a minimal prompt, not Claude Code's. `settingSources` defaults to loading user, project, and local settings, so without `settingSources: []` the user's global `CLAUDE.md` would be loaded into the bookmarks agent. `resume` continues a session, and `includePartialMessages` gives token streaming.

Suggested tool surface **(inference)**, read-only at first:

| Tool | Purpose |
| --- | --- |
| `search_bookmarks({ query, mode, category, tags, author, since, until, limit })` | Compact ranked rows. `mode` is `keyword`, later also `semantic` and `hybrid` |
| `get_bookmark({ id })` | Full text, links, media URLs, tags, summary |
| `list_recent({ since, limit })` | "What did I add this week" |
| `list_taxonomy()` | Categories and tags with counts, so the model filters with real values |
| `get_digest({ week })` | Stored weekly digest |

A lighter alternative for in-app chat exists if API billing is acceptable: the Anthropic client SDK's tool runner drives a tool loop over functions you define, with no subprocess and no Claude Code binary ([Agent SDK overview, comparison table](https://code.claude.com/docs/en/agent-sdk/overview)). It needs an API key. Of the two, only the Agent SDK can run on the subscription login, which is the main reason to prefer it here.

---

## 3. Classification pipeline

### 3.1 Model

**Claude Haiku 5.5 (`claude-haiku-5-5`).** Anthropic's model table describes it as "For high-volume, latency-sensitive tasks such as classification, extraction, and routing", at $0.10 per million input tokens and $0.50 per million output tokens for prompts up to 100,000 tokens ([Models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Sonnet 5.5 is $2 / $10 and Opus 5.5 is $4 / $20, so 20 and 40 times the price for a task that is short-text labelling against a fixed list.

Settings that matter:

- Haiku 5.5 uses adaptive thinking by default with default effort `medium` ([Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)). The migration guide says to "use effort as the lever": at a lower level the model thinks less and "can skip thinking entirely on simpler requests". For labelling, set `output_config: { effort: "low" }` ([Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)).
- "Thinking tokens count toward `max_tokens`, so a request with a small `max_tokens` can stop with `stop_reason: "max_tokens"` after a `thinking` block and before any text" (same guide). Leave room, about 1,024 **(inference for the number)**, and read content blocks by `type`, not by position.
- Haiku 5.5 "runs safety classifiers that can decline a request, and it has no server-side fallback", so handle `stop_reason: "refusal"` (same guide). Leave such items `unclassified` and retry them on Sonnet 5.5 **(inference)**.
- The same text counts as roughly 30% more tokens on Haiku 5.5 than on Haiku 4.5 (same guide), so older rules of thumb for tweet length undercount.
- Run a 50-item spot check before the backfill. If Haiku's labels are not good enough, the fix is usually clearer category definitions, and Sonnet 5.5 is the step up.

### 3.2 Cost

All figures here are **(inference)**: arithmetic on the published prices with assumed token counts. Measure real counts on a sample with the `usage` field before trusting them.

Assumptions per bookmark: 1,500 tokens of stable system prompt (instructions, category definitions, tag vocabulary, a few examples), 250 tokens of bookmark content (text, author, link titles), 200 output tokens (JSON plus a little thinking at low effort). That is 1,750 input and 200 output per item.

Backfill of 5,000 bookmarks (8.75M input, 1.0M output). For 3,000, multiply by 0.6.

| Model | Synchronous, no caching | Batch | Batch plus caching |
| --- | --- | --- | --- |
| Haiku 5.5 | $1.38 | $0.69 | about $0.42 |
| Sonnet 5.5 | $27.50 | $13.75 | about $8 |
| Opus 5.5 | $55.00 | $27.50 | about $16 |

Ongoing, 50 bookmarks a week on Haiku 5.5, synchronous: about $0.007 to $0.014 a week, so under $1 a year.

Prices used: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) (base, batch, and cache multipliers). The "batch plus caching" column assumes a 90% cache hit rate on the system prompt with 1-hour cache writes.

### 3.3 Batch processing and prompt caching

Both apply. At this scale they are a nice-to-have, not a necessity, because the uncached synchronous backfill on Haiku is already about a dollar.

**Batch API**

- 50% off input and output ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)).
- A batch holds up to 100,000 requests or 256 MB, so the whole backfill fits in one. Most batches finish within an hour, the limit is 24 hours, and results stay available for 29 days ([Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)).
- Results come back in any order, so use the bookmark id as `custom_id`.
- Use it for the backfill and for any later re-tagging run. For the weekly 50, synchronous calls are simpler and the saving is a fraction of a cent.

**Prompt caching**

- The minimum cacheable prefix on Haiku 5.5 is 512 tokens. Shorter prefixes are silently not cached ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). A system prompt holding the taxonomy clears that.
- Cache reads cost 0.1x base input on Haiku 5.5, 5-minute writes 1.25x, 1-hour writes 2x, and these multipliers stack with the batch discount ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)).
- Inside a batch, cache hits are best-effort, typically 30% to 98%, and the docs suggest the 1-hour cache duration for batches ([Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)).
- Layout: instructions and taxonomy in `system` with a cache breakpoint, the single bookmark in the user message. Any change to the taxonomy text invalidates the cache, which costs nothing meaningful here.

### 3.4 Structured output

Use structured outputs so every response parses and the category is always a legal value.

- Request shape: `output_config: { format: { type: "json_schema", schema } }`. The older `output_format` parameter is deprecated. Haiku 5.5 is supported ([Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).
- TypeScript: `zodOutputFormat()` from `@anthropic-ai/sdk/helpers/zod` with `client.messages.parse()`, which returns a typed `parsed_output` (same source).
- Schema limits that affect tag design: `enum` is supported, objects need `additionalProperties: false`, arrays support `minItems` of only 0 or 1 and no `maxItems`, and string length constraints are unsupported. The SDK helpers move unsupported constraints into descriptions and validate on the client (same source). So "one to five tags" has to be stated in the prompt and enforced in code.
- A new schema adds compile latency on first use, compiled grammars are cached for 24 hours, and changing the schema invalidates the prompt cache for that thread (same source).
- With `stop_reason` of `refusal` or `max_tokens` the output may not match the schema, so check `stop_reason` before reading (same source).
- Structured outputs work inside a batch. The feature compatibility list says they work with "Batch processing: Process structured outputs at scale with 50% discount", and are incompatible with citations and message prefilling ([Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).

Suggested shape **(inference)**:

```ts
const Classification = z.object({
  category: z.enum(CATEGORIES),        // exactly one, from the fixed list
  tags: z.array(z.string()),           // 1 to 5, from the vocabulary; validated in code
  proposed_tags: z.array(z.string()),  // 0 to 2, only when nothing in the vocabulary fits
  summary: z.string(),                 // one sentence; indexed for search and reused by the digest
  content_type: z.enum(["thread", "link", "tool", "paper", "opinion", "news", "how-to", "other"]),
});
```

The `summary` field earns its place twice: it gives keyword search words the original post never used, and it lets the weekly digest read 50 short summaries instead of 50 raw posts.

### 3.5 Keeping the taxonomy stable

This section is design advice **(inference)**, not sourced fact.

**Fixed list or free tags.** Pure free tagging drifts: "llm", "LLMs", and "large-language-models" all appear, and filters stop working. A pure fixed list cannot express the long tail. Use both layers:

- **Category**: exactly one per bookmark, from a fixed list of roughly 8 to 15, enforced by the schema enum. Include `other`.
- **Tags**: one to five per bookmark from a controlled vocabulary kept in a `tags` table and injected into the system prompt. Lowercase kebab-case.
- **Proposed tags**: when nothing fits, the model puts a suggestion in `proposed_tags`. These are stored but not shown as real tags until promoted.

**Bootstrapping.** Do not invent the list up front. Once the MCP server exists, ask Claude in Claude Code to read a few hundred bookmarks and propose categories and a starter vocabulary, edit the result by hand, and freeze it as version 1. That runs on the subscription.

**Letting it evolve without re-tagging everything**

1. Store provenance with each classification: `model`, `prompt_version`, `taxonomy_version`, `created_at`, and the raw JSON. That makes "which rows were tagged under the old list" a SQL query.
2. Keep a `tag_aliases` table (alias to canonical). Renames and merges become one row and need no model call.
3. Promote proposed tags on a schedule. The weekly digest job can list proposed tags seen three or more times, and the user accepts or maps them to an existing tag.
4. Re-run narrowly. Splitting a category means re-classifying only that category's rows. Adding a category means re-classifying `other` plus the nearest neighbours. Adding a tag needs nothing, or a targeted pass over the couple of hundred rows a search for that concept returns.
5. Never overwrite manual edits. Mark user-set tags with `source = 'user'` and skip them in re-runs.
6. Watch one number: the share of bookmarks landing in `other`. When it passes about 10%, the category list needs a new entry.

A full re-tag of 5,000 items costs about fifty cents on Haiku, so money is not the reason to avoid it. The reason is churn: tags the user has learned to filter by would shift underneath them. Version the taxonomy and change it deliberately.

Search should not depend on the taxonomy being right. Tags are for browsing and filtering. Recall comes from full-text and embeddings.

---

## 4. Search

### 4.1 The three options

| | FTS5 only | FTS5 plus vectors | Agent-driven retrieval, no embeddings |
| --- | --- | --- | --- |
| Finds exact words, handles, names | Yes | Yes | Yes |
| Finds by meaning when no words overlap | No, except through tags and summaries | Yes | Mostly. The model tries several phrasings and filters |
| Works in the web app's search box | Yes, instantly | Yes, instantly | No. Every search would need a model call taking seconds |
| Extra moving parts | None | An embedding model, a vector column, a re-embed script | None beyond the MCP tools |
| Cost | None | None locally | Subscription usage per question |

**FTS5 alone** goes further than it sounds when the index also covers the tags and the one-line summary from section 3.4, because those add the vocabulary the original post lacked **(inference)**. FTS5 provides BM25 ranking with per-column weights, `snippet()` and `highlight()`, prefix queries, and column filters. External-content tables with triggers keep it in sync with the main table. The `trigram` tokenizer enables substring matching, and the `porter` stemmer is English-oriented ([SQLite FTS5](https://www.sqlite.org/fts5.html)). If the library is not English-only, skip `porter` and use `unicode61` with diacritic removal, optionally with a second trigram index for partial-word matches **(inference)**.

**Agent-driven retrieval** is what the MCP server gives on day one. Claude expands the query itself, calls `search_bookmarks` several times with different terms and filters, and reads the results. For conversational questions this is often as good as vector search at this scale **(inference)**. It cannot power the search box.

**FTS5 plus vectors** is the only option that satisfies "search by meaning in a web app" without a model call per search, so embeddings are worth adding. They are also cheap enough that cost is not a factor.

### 4.2 Recommended setup

- **Driver**: `better-sqlite3`. Its bundled SQLite build has FTS5 enabled ([better-sqlite3 compilation docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md)). Node's built-in `node:sqlite` is a release candidate as of v25.7.0 and supports extension loading, but its docs do not say whether FTS5 is compiled in ([Node.js SQLite](https://nodejs.org/api/sqlite.html)), so it is the riskier pick today.
- **Concurrency**: WAL mode. The web app, the MCP server, and the workers are separate processes on one machine. In WAL mode "readers do not block writers and a writer does not block readers", with one writer at a time ([SQLite WAL](https://www.sqlite.org/wal.html)).
- **Keyword index**: one FTS5 table over text, author handle and name, tags, and summary, with BM25 weights favouring tags and summary **(inference)**.
- **Vectors**: one embedding per bookmark stored in the same database. Two reasonable ways to query them:
  - [`sqlite-vec`](https://github.com/asg017/sqlite-vec), a small SQLite extension with `vec0` virtual tables, KNN through `MATCH ... ORDER BY distance LIMIT k`, and cosine distance by column option ([KNN docs](https://alexgarcia.xyz/sqlite-vec/features/knn.html)). It loads into `better-sqlite3` with `sqliteVec.load(db)` ([JS docs](https://alexgarcia.xyz/sqlite-vec/js.html)). It is pre-v1 and warns to "expect breaking changes" ([README](https://github.com/asg017/sqlite-vec)).
  - A plain BLOB column and a cosine loop in TypeScript. At 5,000 vectors of 768 dimensions that is about 4 million multiply-adds per query, which is a few milliseconds, and it has no dependency at all **(inference, not benchmarked)**.

  Start with `sqlite-vec` for the convenience of KNN in SQL, and keep the BLOB loop in mind as the fallback if the extension causes packaging trouble. No approximate-nearest-neighbour index is needed at this size.
- **Hybrid ranking**: run the FTS query and the vector query, then merge the two ranked lists with reciprocal rank fusion, which is about fifteen lines of TypeScript **(inference)**.

### 4.3 Embedding model

Anthropic's docs confirm it: "Anthropic does not offer its own embedding model", and they point to Voyage AI ([Embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings)).

| Option | Facts | Fit |
| --- | --- | --- |
| **EmbeddingGemma 300m, local** (recommended) | 300M parameters, 768 dimensions truncatable to 512/256/128, 2K input context, trained on 100+ languages, released under Google's Gemma terms, uses `task: search result \| query: ...` and `title: none \| text: ...` prompt formats ([Google model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card)). The ONNX build for Transformers.js accepts `fp32`, `q8`, or `q4` and does not support fp16 ([ONNX model card](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX)). Runs in Node through Transformers.js (`@huggingface/transformers`, ONNX Runtime) with models cached on disk ([Transformers.js Node tutorial](https://huggingface.co/docs/transformers.js/tutorials/node)), or through Ollama, which lists `embeddinggemma` among its recommended embedding models and returns L2-normalized vectors from `/api/embed` ([Ollama embeddings](https://docs.ollama.com/capabilities/embeddings)) | No account, no key, works offline, multilingual. Transformers.js keeps it in-process. Ollama is the alternative if a shared local daemon is preferred |
| **`voyage-4-lite`, hosted** | $0.02 per million tokens with the first 200 million tokens free ([Voyage pricing](https://www.mongodb.com/docs/voyageai/management/billing/)). 1,024 dimensions by default, 32,000-token context ([Voyage text embedding models](https://www.mongodb.com/docs/voyageai/models/text-embeddings/)) | Whole library is about 1.25M tokens, so about $0.03 and inside the free allowance **(inference)**. Costs a MongoDB Atlas account, an API key, and a network call for every search-box query |
| `voyage-4-nano`, local | Open weights under Apache 2.0, Python usage only on the card, with no Transformers.js or ONNX mention ([model card](https://huggingface.co/voyageai/voyage-4-nano)). Sources disagree on its default dimension: the model card says 2,048, Voyage's own docs table says 512 ([Voyage text embedding models](https://www.mongodb.com/docs/voyageai/models/text-embeddings/)) | Awkward in a TypeScript-only stack today |

Whichever model is chosen embeds both documents and queries, so switching models later means re-embedding the library. At this size that is a few minutes of local compute **(inference)**. Record the model name and dimension alongside the vectors.

Load the embedding model lazily in the MCP server so that keyword-only questions do not pay the model start-up time **(inference)**.

---

## 5. Weekly digest

### 5.1 Scheduling options

| Option | Runs where | Sees the local database | Needs | Verdict |
| --- | --- | --- | --- | --- |
| Claude Code cloud routines (`/schedule`) | Anthropic's cloud, against a fresh clone of a GitHub repo | No. Locally added MCP servers are not available to routines | Subscription. Research preview. Minimum interval one hour | Wrong tool for a local-first database ([Routines](https://code.claude.com/docs/en/routines)) |
| Claude Code Desktop local scheduled task | The user's machine | Yes, with local files and MCP config | Desktop app open and computer awake. One catch-up run for a time missed in the last seven days | Workable no-code alternative on the subscription ([Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)) |
| `/loop` and the in-session cron tools | An open Claude Code session | Yes | Session must stay open. Recurring tasks expire after seven days | Not for durable schedules ([Scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)) |
| launchd (`StartCalendarInterval`) | The user's machine | Yes | Nothing running. If the Mac is asleep at the scheduled time the job runs on wake. If it is off, the run is skipped until the next scheduled time | Reliable trigger for a script ([Apple: Scheduling Timed Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html)) |
| In-app job | The web app's server process | Yes | The app must be running at the time | Good as a catch-up, weak as the only trigger |

### 5.2 Recommendation

Make the digest a function, not a schedule. `ensureDigest(week)` checks whether a digest row exists for that ISO week and, if not, gathers the week's bookmarks and generates one. Then trigger it from two places **(inference)**:

1. A launchd agent that runs the project's digest script once a week (for example Monday 08:00).
2. A call on web app start, and at the end of each ingestion run, which covers weeks when the Mac was off.

Because the function is idempotent, extra triggers are harmless.

Generation is one Messages API call. Compute the facts in SQL (count, categories, top authors, proposed tags awaiting review) and give the model the week's summaries and tags, asking it for themes, a few highlights, and items worth revisiting. On Opus 5.5, the model the docs recommend starting with for most workloads ([Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)), that is roughly 16,000 input and 3,500 output tokens, or about $0.13 a week. On Sonnet 5.5 it is about $0.07 **(inference)**.

If avoiding an API key entirely matters more than determinism, the Desktop local scheduled task is the substitute: a saved prompt that uses the bookmarks MCP tools and a `save_digest` write tool, running on the subscription. It depends on the Desktop app being open.

### 5.3 Where the output goes

- A `digests` table: week key, markdown body, the bookmark ids it covered, model, created time. This is the source of truth.
- A `/digests` page in the web app that renders it, with each item linking to the bookmark.
- The `get_digest` MCP tool, so "what did I save last week" works from Claude Code and Claude Desktop.
- Optionally a markdown file per week in a `digests/` folder for use outside the app.

Email, Slack, and push delivery are left out. A macOS notification from the script is a cheap nudge if one is wanted.

---

## 6. Stack and build order

### 6.1 Stack

- **Runtime**: Node and TypeScript, one repo. Core logic in plain functions with no framework dependency.
- **Database**: one SQLite file, `better-sqlite3`, WAL mode. Tables: `bookmarks` (from ingestion), `classifications`, `tags`, `tag_aliases`, `embeddings`, `digests`, plus an FTS5 index.
- **Claude access**: `@modelcontextprotocol/server` for the MCP server. `@anthropic-ai/sdk` for tagging and the digest. `@anthropic-ai/claude-agent-sdk` only if in-app chat is built.
- **Models**: Haiku 5.5 for tagging, Opus 5.5 for the digest, whatever the user's Claude client runs for chat.
- **Embeddings**: EmbeddingGemma 300m through Transformers.js, `sqlite-vec` for KNN.
- **Scheduling**: launchd plus catch-up on start.

### 6.2 Phases

Each phase leaves something usable on its own.

| Phase | Build | Usable result | Needs |
| --- | --- | --- | --- |
| 1 | Core query functions, FTS5 index, MCP server with `search_bookmarks`, `get_bookmark`, `list_recent`. Register in Claude Code and Claude Desktop | Ask Claude about the bookmarks, and keyword search for the web app | Subscription only |
| 2 | Taxonomy bootstrap (in Claude Code, through the MCP server), classifier with structured outputs, batch backfill, synchronous tagging on ingest, tags and summaries added to FTS, `list_taxonomy` tool, filters on search | Every bookmark has a category, tags, and a summary. Browsing and filtering work. Search improves | API key, about $1 |
| 3 | `ensureDigest`, launchd agent, `digests` table, `get_digest` tool | Weekly summary appears in the app and is readable from Claude | API key, cents a week |
| 4 | Embedding script, vector storage, hybrid ranking, `mode` parameter on search | "By meaning" search in the search box and through the tools | Nothing new |
| 5 (optional) | Agent SDK route and chat panel reusing the MCP server | Chat inside the web app | Subscription login or API key |

Phase 4 before phase 3 is equally valid if meaning search matters more than the digest. Neither depends on the other.

### 6.3 Deliberately left out

- **A hosted or separate vector database, ANN indexes, and rerankers.** A few thousand vectors do not need them.
- **RAG frameworks and orchestration libraries.** The whole pipeline is a handful of functions.
- **Claude Managed Agents and cloud routines.** They run in Anthropic's cloud and cannot reach a local SQLite file without extra infrastructure. Managed Agents also bills session runtime on top of tokens ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)).
- **A remote HTTP MCP server with OAuth.** Local stdio is enough for one user on one machine.
- **Subagents and multi-agent setups.** One agent with five tools.
- **Image understanding and fetching linked pages.** Tag from the post text and link metadata first. Add vision later only if image-only posts turn out to be a real gap.
- **A job queue.** A script and a status column in SQLite.
- **Automatic taxonomy changes.** The model proposes, the user approves.
- **Write tools in the MCP server at the start.** Read-only until there is a concrete need, such as retagging from chat.
- **A formal evaluation harness.** A 50-item spot check before the backfill is proportionate.
- **Multi-user auth and deployment.** Also the point at which subscription credentials stop being appropriate (section 2.3).

---

## 7. Inferences and things I could not verify

1. **All cost figures are estimates.** Token counts per bookmark, system prompt size, thinking tokens at low effort, and the extra system prompt that structured outputs inject are assumed, not measured.
2. **The user's Claude plan is unknown.** Max and Team get monthly API credits. Pro does not and must buy API credit. I did not check the minimum Console credit purchase.
3. **API credit rollout is staged** and may not be visible on the account yet. New subscribers wait 7 days.
4. **Subscription use in a personal Agent SDK app is my reading of the policy text**, not an explicit statement about self-built single-user apps. The docs confirm that Agent SDK usage signed in with a plan draws on plan limits, and they prohibit offering claude.ai login to others.
5. **How the SDK's bundled binary finds the subscription login is not spelled out in the Agent SDK docs**, which document only API-key setup. The authentication page covers `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` as the explicit route for scripts. I did not test whether an existing Claude Code login is picked up automatically.
6. **`--bare` becoming the default for `claude -p`** has no date, and its effect on SDK `query()` calls is not stated.
7. **`voyage-4-nano` default dimension**: the Hugging Face model card says 2,048 and Voyage's docs table says 512. Not resolved, and not on the recommended path.
8. **Whether Haiku 5.5 thinking can be switched off outright** was not checked against a primary source. The recommendation only relies on lowering effort, which the migration guide confirms.
9. **`sqlite-vec` performance** is not documented. Its performance guide is a stub, and I found no statement on whether `vec0` KNN is brute-force. The TypeScript brute-force estimate is arithmetic, not a benchmark.
10. **Transformers.js inside a Next.js server** (bundler configuration for the native ONNX runtime), the model download size, and local embedding latency were not checked.
11. **`node:sqlite` and FTS5**: not documented either way, which is why `better-sqlite3` is recommended.
12. **launchd details**: the Apple page confirms run-on-wake and skip-when-off. It does not cover the `~/Library/LaunchAgents` location or how several missed runs are coalesced.
13. **MCP SDK v2 details** come from the repository README and the official tutorial. I did not check Node or Zod version requirements.
14. **Routines are a research preview** and their limits may change.
15. **Build-effort figures** (a day, 100 to 200 lines) are my estimates.

---

## 8. Sources

Anthropic, Claude Code and Agent SDK
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/quickstart
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/custom-tools
- https://code.claude.com/docs/en/agent-sdk/mcp
- https://code.claude.com/docs/en/agent-sdk/hosting
- https://code.claude.com/docs/en/agent-sdk/cost-tracking
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/routines
- https://code.claude.com/docs/en/desktop-scheduled-tasks
- https://code.claude.com/docs/en/scheduled-tasks

Anthropic, Claude Platform
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
- https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- https://platform.claude.com/docs/en/build-with-claude/batch-processing
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/build-with-claude/embeddings

Anthropic, Help Center
- https://support.claude.com/en/articles/15036540-use-the-agent-sdk-with-your-claude-plan
- https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan

MCP
- https://modelcontextprotocol.io/docs/develop/build-server
- https://github.com/modelcontextprotocol/typescript-sdk

Storage and search
- https://www.sqlite.org/fts5.html
- https://www.sqlite.org/wal.html
- https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md
- https://nodejs.org/api/sqlite.html
- https://github.com/asg017/sqlite-vec
- https://alexgarcia.xyz/sqlite-vec/js.html
- https://alexgarcia.xyz/sqlite-vec/features/knn.html

Embeddings
- https://ai.google.dev/gemma/docs/embeddinggemma/model_card
- https://www.mongodb.com/docs/voyageai/models/text-embeddings/
- https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX
- https://huggingface.co/docs/transformers.js/tutorials/node
- https://docs.ollama.com/capabilities/embeddings
- https://www.mongodb.com/docs/voyageai/management/billing/
- https://huggingface.co/voyageai/voyage-4-nano

Scheduling
- https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html
