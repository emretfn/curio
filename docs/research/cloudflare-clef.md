# Cloudflare Clef for tagging, the digest and search

Researched 2026-10-13. Scope: whether Cloudflare's Clef could be "the AI" for this library, and whether Cloudflare could be the primary search with the existing FTS5 search as the fallback. The current plan it is compared against is in `ai-layer.md`.

Question: what is "Cloudflare Clef", can it tag 1,448 short Turkish and English posts and write the weekly digest, can it search them by meaning, what does it cost, and where does the data go?

## How this was sourced

Claims are traced to the source that owns them:

- **Cloudflare's developer docs**, downloaded as raw Markdown from developers.cloudflare.com on 2026-10-13: the Workers AI model pages, pricing, limits, data usage and changelog, the AI Search docs, the Vectorize pricing page and the Data Localization compatibility table.
- **Clef's published API schemas**, `schema-input.json` and `schema-output.json` from the Clef model page.
- **Cloudflare's launch post** for Clef on blog.cloudflare.com.
- **Model cards on Hugging Face**: Cloudflare's own for Clef and Clef-flash, Qwen's for the base model, and two community conversions, named as community work where used.
- **Cloudflare's legal pages**: the Self-Serve Subscription Agreement, the Developer Platform service-specific terms (last updated 2026-09-28) and the Privacy Policy.

Three other kinds of statement appear, each labelled where it occurs:

- **Measured here**: something I ran on this machine. There are two: a latency probe of Cloudflare's API front door, and this Mac's chip and memory.
- **Inference**: my own arithmetic or reading.
- **Self-reported**: a benchmark Cloudflare ran on its own model.

Press coverage and third-party explainers were used only to find the primary pages. No Cloudflare account was created and no model was called, so nothing here is tested against the library.

## Bottom line

**Clef exists, it is new, and it is a classifier, not a general AI and not a search product.** Cloudflare released it on 2026-10-01. It answers yes/no, pick-one and rate-on-a-scale questions about an input and returns probabilities. It cannot write text.

- **Tagging: keep Claude Haiku.** Clef can pick the category and say yes or no to each tag in a fixed vocabulary. It cannot write the one-line summary or propose a new tag, and both are in the planned schema. Claude would still be needed, so Clef would be a second system doing half of one job. Its Turkish is untested: no published benchmark covers it.
- **Weekly digest: keep Claude Sonnet.** Clef cannot summarise. The Cloudflare alternative would be an open-weight chat model on Workers AI, which is a different product with weaker structured output and unverified Turkish.
- **Search by meaning: keep the local plan.** Clef does not search. Cloudflare's search product is AI Search, generally available since 2026-10-01 with billing starting 2026-11-01. Using it as the primary search means the whole library is stored at Cloudflare, every query crosses the network, its keyword side has no Turkish folding, and the MCP server could not use it under rule MCP-2. At 1,448 posts none of that buys anything the local plan lacks.
- **Cost is not the deciding factor.** Hosted Clef would tag the backfill for about $0.11 to $0.70, mostly inside the free daily allowance (inference). The current plan is about $0.12 to $0.40 from plan credits. AI Search would fit its included monthly usage until searches pass 1,000 a month.
- **The decision the owner has to make knowingly.** Hosted Clef sends every post's text to Cloudflare, a second third party after Anthropic, though Cloudflare says it is not stored or trained on. AI Search goes further: it keeps a copy of the library on Cloudflare's storage.
- **The one case where Clef wins.** Clef-flash is open-weight and a community build runs on Apple Silicon. That would give category and tags with nothing leaving the machine, at the price of no summaries, a Python dependency and third-party conversion code.

Recommendation: no change to the plan. If the owner is curious, the 50-post check at the end of this note costs nothing and would show whether Clef's Turkish labels are any good.

## 1. What Clef is

**A family of "decision models" trained by Cloudflare.** A request carries a `state` (the thing to judge, as text or JSON) and up to 64 typed `questions`. The response carries a probability for every allowed answer. Cloudflare: "Instead of generating text, it reads an input state and a set of typed questions, then returns a probability for every allowed answer" ([Workers AI changelog, 2026-10-01](https://developers.cloudflare.com/changelog/product/workers-ai/)). The model card is blunter: "There is no free-form text generation and no output parsing" ([Cloudflare/clef](https://huggingface.co/Cloudflare/clef)).

**Three question types** ([input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json), [output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json)):

| Type | Asks | Returns | Limit |
| --- | --- | --- | --- |
| `noul` | A yes/no question | The probability of yes | |
| `choice` | Pick one of the options you define, each with a description | The chosen option, a probability per option summing to 1, a confidence | 2 to 255 options |
| `score` | Rate on an ordered rubric | A probability-weighted level, a probability per level, a confidence | 2 to 10 levels |

A request holds 1 to 64 questions. The response also reports `usage.input_tokens`.

**Three hosted models**, all on Workers AI ([changelog, 2026-10-09](https://developers.cloudflare.com/changelog/product/workers-ai/), [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)):

| Model | Size | Hosted context | Price per million input tokens |
| --- | --- | --- | --- |
| `@cf/cloudflare/clef` | 27B | 64K | $0.240 |
| `@cf/cloudflare/clef-flash` | 9B | 24K | $0.038 |
| `@cf/cloudflare/clef-omni` | 30B mixture-of-experts, 3B active | 64K | $0.150 |

"Clef models do not charge for output tokens" ([Clef model page](https://developers.cloudflare.com/workers-ai/models/clef/)).

**Status and dates.** Clef and Clef-flash were released on 2026-10-01, and Clef-omni, which adds audio and video input, on 2026-10-09 ([changelog](https://developers.cloudflare.com/changelog/product/workers-ai/)). The model pages carry no Beta label, where other models' pages do, for example [EmbeddingGemma's](https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/) (inference from the absence). The fine-tuning service announced with it is not self-serve: it starts "as a hands-on partner with our forward-deployed engineer (FDE) team" ([launch post](https://blog.cloudflare.com/clef-decision-models/)).

**Open weights.** Clef and Clef-flash are on Hugging Face under Apache 2.0, post-trained from Qwen3.8-27B and Qwen3.5-9B ([Cloudflare/clef](https://huggingface.co/Cloudflare/clef), [Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash)). Cloudflare's reference code is Python with PyTorch, tested "on a single H200" GPU.

**The API is borrowed.** Clef is "fully Jev-API compatible", Jev being Typesafe AI's decision model, which the launch post says had drawn "lots of buzz" over the preceding weeks ([launch post](https://blog.cloudflare.com/clef-decision-models/)). Nothing in this project uses Jev, so the compatibility has no value here.

## 2. Could it do the AI jobs here?

### Tagging

The planned classification returns five fields in one Claude Haiku call (`ai-layer.md`, section 3.4). Against Clef:

| Planned field | Clef |
| --- | --- |
| `category`, one of a fixed list | Yes, a `choice` question. This is what the model is for |
| `content_type`, one of eight | Yes, a second `choice` |
| `tags`, one to five from a controlled vocabulary | Workable. One `noul` question per tag, so at most 62 tags per request beside the two `choice` questions. A larger vocabulary needs more than one request per post (inference from the 64-question limit) |
| `proposed_tags`, free text when nothing fits | No. It cannot write |
| `summary`, one sentence | No. It cannot write |

The summary is the field that "earns its place twice" in the plan: it feeds keyword search and it is what the digest reads. So Clef cannot replace the Haiku call. It could only take the label fields out of it.

**What Clef would add over Haiku for the labels.** A probability per label, which could drive a "needs a look" queue and the watch on the `other` share. Output that is schema-shaped by construction, since the model only scores the options it was given, so there is no refusal or truncation case to handle (inference from the architecture). Speed: a median of 152 ms for about 800 input tokens on Clef, measured by Cloudflare on its own servers ([changelog, 2026-10-09](https://developers.cloudflare.com/changelog/product/workers-ai/)). Speed does not matter for a weekly batch of 50.

**Turkish: unknown.** Neither Cloudflare's docs nor the model cards name any language. None of the benchmarks Cloudflare publishes for Clef is described as multilingual, the ones I recognise are English datasets, and all are self-reported ([Cloudflare/clef](https://huggingface.co/Cloudflare/clef)). Training used "our own internal synthetic datasets" of undisclosed language ([launch post](https://blog.cloudflare.com/clef-decision-models/)). The only signal is the base model: Qwen3.5 claims "support to 201 languages and dialects" ([Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)). Whether that survives the post-training is something only a test on real posts can show.

**Images are out of reach here.** Clef accepts up to four images, but only embedded in the request: "Remote URLs are not accepted" ([input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json)). A post's images sit on X's media CDN, and rule 9 forbids server code from fetching them. So this would be text only, the same as the Haiku plan.

**Limits.** Clef is listed under Text Generation, whose default rate limit is 300 requests a minute ([limits](https://developers.cloudflare.com/workers-ai/platform/limits/); the mapping to Clef is inference). That is the whole backfill in about five minutes. There is no prompt caching: the questions are re-sent and billed as input on every request (inference from the pricing model).

### Weekly digest

Not possible with Clef. It returns probabilities and nothing else.

"Cloudflare as the AI" for the digest would mean a chat model on Workers AI instead, such as `@cf/openai/gpt-oss-120b` at $0.35 in and $0.75 out per million tokens ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). Two cautions from Cloudflare's own docs: JSON mode is supported on a listed subset of models, and "Workers AI can't guarantee that the model responds according to the requested JSON Schema" ([JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)). How well any of those models write Turkish was not researched. At about 16,000 tokens in and 3,500 out a week the digest costs $0.07 on Sonnet (`ai-layer.md`, section 5.2), so there is no money to save.

## 3. Could it do search by meaning?

### Clef itself: no

Clef has no embeddings, no index and no query endpoint. The nearest thing is using it to re-score a short list of candidates for relevance, which is what its ranking benchmarks (ToolRet, BRIGHT) measure. That still needs something else to find the candidates, and keyword search cannot find a post that shares no words with the query. Feeding it the whole library per query does not fit either: 1,448 posts at about 250 tokens each is roughly 360,000 tokens, against a 64K context (inference).

### What Cloudflare does offer for search: AI Search

The owner's "and also for search" matches a different Cloudflare product that became generally available the same day as Clef.

**What it is.** "AI Search is a managed search service. Connect a website, an R2 bucket, or upload your own documents, and AI Search indexes your content for natural language queries" ([How AI Search works](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/)). Formerly AutoRAG. Generally available since 2026-10-01 ([release notes](https://developers.cloudflare.com/ai-search/platform/release-note/)).

**How the data gets in: it is uploaded and stored at Cloudflare.** Each post would be uploaded as a file through the Items API into the instance's "built-in storage and a built-in vector index, powered by R2 and Vectorize" ([Built-in storage](https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/), [Items REST API](https://developers.cloudflare.com/ai-search/api/items/rest-api/)). Cloudflare chunks, embeds and indexes it there. There is no mode that returns vectors for local storage.

**Hybrid ranking: yes, by default.** Vector search and BM25 keyword search run in parallel and are merged with reciprocal rank fusion, the same fusion `ai-layer.md` plans locally. A cross-encoder reranker is optional ([Hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/)).

**Turkish.**
- Meaning side: the default embedding model is `@cf/qwen/qwen3-embedding-0.6b`, with `@cf/baai/bge-m3` and `@cf/google/embeddinggemma-300m` as options ([Supported models](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/)). Their own cards claim over 100 languages each ([Qwen3-Embedding](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [bge-m3](https://huggingface.co/BAAI/bge-m3)). EmbeddingGemma is the model the local plan already chose.
- Keyword side: the tokenizer is `porter`, which is English stemming, or `trigram` ([Keyword search](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/)). Nothing documents Turkish folding. The existing local index treats `ı`, `İ`, case and accents as equal (`packages/core/src/search-text.ts`). So the keyword half of Cloudflare's hybrid would be worse for Turkish than what the project has today (inference).

**How a local app calls it.** A plain HTTPS POST with a bearer token to `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai-search/namespaces/default/instances/<INSTANCE_NAME>/search`. No Worker has to be deployed ([Search REST API](https://developers.cloudflare.com/ai-search/api/search/rest-api/)). Results come back as chunks with a score and the item's key, so the app would map keys back to bookmark ids.

**Latency.** Cloudflare publishes no query latency for AI Search. Measured here on 2026-10-13: five unauthenticated requests to `api.cloudflare.com`, answered from Cloudflare's Istanbul location, took 0.30 to 0.40 seconds each, of which the connection and TLS were about 0.05. That is the front door refusing a request, not a search, so a real query is unlikely to be faster. The local FTS5 query it would replace is a synchronous SQLite call with no network.

**Limits that matter here** ([Limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)): 100,000 files per instance on the free plan, 5 custom metadata fields per instance, and only the first 64 bytes of a string are filterable. The project's filters (author, period, removed, withheld and the rest of `BookmarkFilter`) would have to fit in five fields or be applied locally after the fact.

### The owner's idea: Cloudflare first, local FTS as the fallback

How it would work in practice (inference throughout, from the facts above and the code):

1. **A sync job.** Every new post is uploaded to AI Search, and every post removed or withheld on X is deleted or re-flagged there. The local database stays the source of truth and Cloudflare holds a second copy that can drift.
2. **Search becomes asynchronous.** `searchBookmarks` in `packages/core/src/library.ts` is a synchronous function. A network-first search needs a new async function with a timeout of a few hundred milliseconds, falling back to the existing one on timeout, error or no connection.
3. **Two rankings.** Online, results come from Cloudflare's hybrid ranking with English keyword rules. Offline or on a slow network, the same query returns the local BM25 ranking. The same search would give different results on different days, and the UI would need to say which engine answered.
4. **Excerpts and highlights stay local.** The marked excerpts come from `search-text.ts`, so each remote hit still needs a local lookup.
5. **The MCP server cannot take part.** `CODING_STANDARDS.md` MCP-2: "The server makes no network request and loads no module that could", because "it reads the whole library, and must have nowhere to send it." Claude would keep searching the local index while the web UI searched Cloudflare, unless that rule were changed in the open.
6. **Offline.** Search by meaning disappears and keyword search remains. With the local plan, both work offline.
7. **Query quota.** Each search is a billable query after the first 1,000 a month. If the search box queries as the user types, that allowance goes quickly.

### A middle path: Cloudflare embeds, vectors stay local

Workers AI serves embedding models over the same REST API and returns the vectors in the response ([EmbeddingGemma model page](https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/)). The app could send post text, get vectors back, and store them in `sqlite-vec` as planned. Cloudflare says of Workers AI that content "may be stored by Cloudflare if you specifically use a storage service" ([Data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)), and this path uses none.

It still sends every post and every query to Cloudflare, and a meaning search still needs the network to embed the query. Its only gain over the plan is not running an embedding model locally. That is worth remembering only if packaging Transformers.js inside the Next server turns out to be painful, which `ai-layer.md` lists as unchecked.

## 4. Cost and account setup

**Workers AI billing.** Priced in "Neurons" at $0.011 per 1,000, with "a total of 10,000 Neurons per day at no charge" on both the Free and Paid plans. On the Free plan, going over means "further operations will fail with an error" until 00:00 UTC, not a charge. Workers Paid is a $5 monthly minimum ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). Clef is not among the models the pricing page lists as needing a paid plan.

**Clef for tagging (inference).** Assume 2,000 input tokens per post: 250 for the post, as `ai-layer.md` assumes, and about 1,750 for a 12-option category question, an 8-option content-type question and about 60 tag questions. The real figure is `usage.input_tokens` in any response.

| | Backfill, 1,448 posts | Each week, 50 posts |
| --- | --- | --- |
| Tokens | 2.9M | 0.1M |
| Clef-flash | 10,000 Neurons, about one day's free allowance. $0.11 if billed | 350 Neurons, free |
| Clef | 63,000 Neurons: about a week on the free allowance, or $0.70 of usage on Workers Paid with its $5 monthly minimum | 2,200 Neurons, free |
| Claude Haiku 5.5, the current plan | $0.12 to $0.40, scaled from `ai-layer.md` section 3.2, and it returns the summary too | About $0.01 |

Per input token Clef ($0.24) costs more than Haiku 5.5 ($0.10, per `ai-layer.md`). It comes out similar only because it bills no output.

**AI Search.** "AI Search billing begins on November 1, 2026." Every account gets 5 million ingestion tokens, 10 GB-month of storage, 1,000 semantic queries and 1,000 full-text queries a month. Beyond that: $0.75 per million ingestion tokens and $0.75 per 1,000 semantic, vector or hybrid queries. Embedding and reranking are included ([Limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)). This library is about 0.4 million tokens to ingest, so only the query count could ever cost anything (inference).

**Embeddings only.** `bge-m3` and `qwen3-embedding-0.6b` are $0.012 per million tokens ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). The whole library is under half a cent and inside the free allowance (inference). EmbeddingGemma is in beta there with no price on the pricing page.

**Setup for any of these.** A Cloudflare account, the account id, and an API token: "Workers AI - Read" and "Workers AI - Edit" for models, "AI Search:Edit" and "AI Search:Run" for search ([Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/), [Search REST API](https://developers.cloudflare.com/ai-search/api/search/rest-api/)). Calls are plain HTTPS from Node. No Worker, no Wrangler. The token would live beside the Anthropic key, outside git under rule 6.

## 5. Privacy and terms

**Hosted Clef and Workers AI.**
- Inputs and outputs are "Customer Content". "Cloudflare does not use your Customer Content to (1) train any AI models made available on Workers AI or (2) improve any Cloudflare or third-party services", and does not make it available to other customers ([Data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)).
- For Clef specifically: "our guarantee that we don't read, store, or train on your requests or responses", unless the fine-tuning product is used ([launch post](https://blog.cloudflare.com/clef-decision-models/)).
- The binding terms are a little looser than the docs. They say "Unless otherwise agreed, Cloudflare does not use any Customer Content to train generative AI tools", and that Cloudflare "does not reference or use any Customer Content except as needed to provide and improve the Services" ([Developer Platform service-specific terms](https://www.cloudflare.com/service-specific-terms-developer-platform/), Workers AI and AI Gateway section). "Improve" appears in the terms and is ruled out in the docs.
- Models are provided "AS IS" as third-party products under those terms. The data usage page still says "Cloudflare neither creates nor trains the AI models made available on Workers AI", which Clef has made out of date.
- Avoid AI Gateway for this. Requests routed through a gateway "can be logged" ([changelog, 2026-08-07](https://developers.cloudflare.com/changelog/product/workers-ai/)). A plain `/ai/run` call names no gateway.

**AI Search.** The posts are stored, not just processed: in R2 and Vectorize behind the instance, until deleted through the Items API. After an account ends, "Cloudflare has no obligation to retain the Customer Content you upload to the Developer Platform" ([service-specific terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)). The terms also note that the platform "can be used to host content" and that stored content Cloudflare judges infringing or harmful "may be blocked or removed".

**Where.** Not controllable. Inference runs "on GPUs across Cloudflare's network, running close to your users" ([changelog, 2026-10-01](https://developers.cloudflare.com/changelog/product/workers-ai/)), and Cloudflare's region-pinning feature, Regional Services, is marked unsupported for Workers AI, AI Search and Vectorize ([Data Localization compatibility](https://developers.cloudflare.com/data-localization/compatibility/)). Where an AI Search instance's built-in storage sits is not documented in the pages read.

**Other people's posts.** The Self-Serve Subscription Agreement, section 2.5: "You must obtain all necessary rights, releases and permissions to provide Customer Content to Cloudflare", and the customer warrants that the content "does not infringe, violate, or misappropriate any third-party right, including any copyright ... privacy right" ([terms](https://www.cloudflare.com/terms/)). The customer also grants Cloudflare a licence to store and process the content "to the extent necessary to provide the Services". My reading, not legal advice: sending a post through a classifier that does not keep it is a small step from what the Anthropic plan already does. Parking a standing copy of 1,448 strangers' posts on a hosting service is a larger one, and it is the owner who makes that warranty.

**Running Clef locally sends nothing.** A community conversion, `mlx-community/clef-flash-4bit`, runs Clef-flash on Apple Silicon: a 6.2 GB download, 16 GB of RAM minimum, 0.31 seconds for a 1,000-token request on an M5 Max, with a local server that speaks the same API on 127.0.0.1 ([model card](https://huggingface.co/mlx-community/clef-flash-4bit)). This Mac is an M2 Pro with 32 GB (measured here), which meets the stated minimum, though the card warns base chips are "several times slower". The costs: it is Python in a TypeScript project, the card itself says it "ships Python ... that you import and run. Read it before use", and it is not Cloudflare's own release. A llama.cpp build exists too, and its card says it requires a specific llama.cpp pull request, whose status I did not check ([ggml-org/Clef-Flash-GGUF](https://huggingface.co/ggml-org/Clef-Flash-GGUF)).

## 6. Comparison with the current plan

### Tagging and digest

| | Current plan: Haiku tags, Sonnet digest | Hosted Clef for labels |
| --- | --- | --- |
| Category and fixed tags | Yes | Yes, with a probability each |
| Summary, proposed tags, digest | Yes | No. Claude still needed |
| Turkish | Not benchmarked in `ai-layer.md` either, but a general multilingual model | Unknown. No published benchmark covers it |
| Calls per post | One | One for Clef, plus the Claude call for the summary |
| Cost | Cents, from plan credits | Cents or free |
| Third parties that see post text | Anthropic | Anthropic and Cloudflare |
| New setup | API key | Cloudflare account and token as well |

Gain: per-label probabilities and guaranteed-shape output. Give up: nothing if added beside Claude, but then it is two pipelines, two prompts to keep in step with the taxonomy, and two vendors. **Recommendation: keep the current plan.** Revisit only if the summary is dropped from the design, or if the owner wants labels with no post leaving the machine and accepts the local Python build.

### Search by meaning

| | Current plan: local EmbeddingGemma, `sqlite-vec`, fused with FTS5 | AI Search first, local FTS fallback |
| --- | --- | --- |
| Where the library lives | One local SQLite file | That file, and a copy at Cloudflare |
| Works offline | Keyword and meaning | Keyword only |
| Turkish keyword matching | Folded, already built | English stemmer or trigrams |
| Latency | Local | A network round trip of some tenths of a second per query |
| MCP server | Same search as the UI | Local only, or MCP-2 has to change |
| Filters | SQL over the real columns | Five metadata fields, or filtered locally afterwards |
| Moving parts | An embedding model and a vector column | An upload-and-delete sync, a token, a timeout and fallback path, two rankings |
| Cost | None | None until 1,000 searches a month, then $0.75 per 1,000 |

Gain: no local embedding model to package, and an optional reranker. Give up: local-first, offline meaning search, Turkish keyword quality, one consistent ranking, and the rule that the library has nowhere to go. A managed search service earns its keep at millions of documents or many users. This is 1,448 posts and one user, where `ai-layer.md` estimates a brute-force scan at a few milliseconds. **Recommendation: keep the current plan.** If the local model proves hard to ship, the fallback to consider is the middle path in section 3, hosted embeddings with local vectors, not AI Search.

## Not verified

- **Anything live.** No account was created and no request was authenticated. Clef's behaviour on these posts, its real token counts and its real latency are unknown.
- **Clef's Turkish.** No source names it. The 201-language claim belongs to the base model before Cloudflare's training.
- **Every Clef benchmark.** They are Cloudflare's own runs. I did not look for independent reproductions.
- **Whether Clef is on the Workers Free plan.** Inferred from its absence from the paid-only list and from its model page. Also inferred: its 300 requests a minute, from the Text Generation heading.
- **Whether a Cloudflare free account needs a payment card.** The REST guide asks only for an account. I found no first-party statement either way.
- **What happens to AI Search on a free account past the included queries**: blocked, or billed. The page says only that usage beyond the included amounts is billed.
- **AI Search query latency**, and where its built-in storage is located.
- **AI Search keyword handling of Turkish letters.** The docs list two tokenizers and say nothing about Unicode folding. "Worse than the local index" is an inference from that silence.
- **The token estimate for Clef tagging.** 2,000 per post is assumed, and so is every cost built on it. The tag-per-question design is mine, not a documented pattern.
- **The latency probe** was five requests to one unauthenticated endpoint from one network on one evening.
- **The local MLX build.** Not downloaded or run. Its speed on an M2 Pro, its accuracy after 4-bit conversion, and the contents of its Python file are unchecked.
- **Workers AI chat models in Turkish**, for a Cloudflare-hosted digest. Not researched, because the comparison did not turn on it.
- **Typesafe's Jev.** Described only as Cloudflare describes it.
- **Anthropic's handling of the same text.** Not re-researched here. This note says only that the current plan already sends posts to Anthropic.

## A short test that settles most of this

About half an hour, free (inference). It sends 50 posts to Cloudflare, so it needs the owner's yes first. The local variant in step 5 does not.

1. Take the same 50 posts set aside for the Haiku spot check in `ai-layer.md` section 3.1, with a fair share of Turkish ones, and the draft category list.
2. Create a Cloudflare account and a Workers AI token. Note whether it asks for a card.
3. Send each post to `@cf/cloudflare/clef-flash` and to `@cf/cloudflare/clef` with one `choice` question holding the categories and their definitions. That is about 100 requests, well inside one day's free Neurons.
4. Compare with Haiku's labels and the owner's own judgement, Turkish and English separately. Read `usage.input_tokens` to replace the 2,000-token guess, and look at whether low `confidence` lines up with the wrong answers.
5. To test with nothing leaving the machine instead, run the same requests against the MLX build's local server after reading its Python file.

If Clef's Turkish labels are clearly worse than Haiku's, the question is closed. If they match, the plan still stands, because the summary and the digest need Claude either way.
