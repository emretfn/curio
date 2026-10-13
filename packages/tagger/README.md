# x-bookmarks tagger

Files each bookmark under one category, one format and a few tags, by asking Claude. It is the only code in this repo that calls Claude, and the only code that sends anything of the library to a third party. It needs an API key, and a run costs money: about $0.00012 a bookmark as first measured, so under twenty cents for a library of 1,400, and a cent or so a week after that.

What it files under is not here. The categories and formats are `TAXONOMY` in `packages/core/src/taxonomy.ts`, fixed in that file. The tags are the vocabulary, which you change from the interface and which lives in the database (`packages/core/src/vocabulary.ts`). The instructions the model gets are built from both, as they stand when a run begins.

## Before the first run

1. **Create an API key** in the [Claude Console](https://platform.claude.com/), in a workspace of its own with a spend limit. The limit is the outer guard; the caps below are the inner one.
2. **Put it in `.env`** at the repo's root, which git ignores:

   ```
   cp .env.example .env
   chmod 600 .env
   ```

   Then open `.env` in an editor and paste the key after `X_BOOKMARKS_ANTHROPIC_API_KEY=`.
3. **Keep the name.** The variable is not called `ANTHROPIC_API_KEY`, and must not be. Under that name a key takes precedence over a Claude Code subscription login wherever it is in the environment, so Claude Code, `claude -p` or an Agent SDK process would bill the API instead of your plan, without saying so. The classifier reads its own variable from the file and hands the key to the client; it reads no environment for it and sets none. If `ANTHROPIC_API_KEY` is set anyway, in your shell or in `.env`, the classifier does not use it and tells you.
4. `pnpm tag --check` confirms the key is in place and the file is safe. It makes no request.

The command refuses to run, and says what to do, when `.env` is missing, gives the variable no value, holds something that is not shaped like an API key, or can be read or written by another user of this computer. That last is a refusal and not a warning: the app tags new bookmarks by itself, with no terminal to show a warning in, and the fix is the `chmod` above.

Nothing loads `.env` into a process's environment. Next.js loads `.env` files from its own project directory, `packages/web`, which holds none, and not from the repo's root; so the app's process has the key in no variable, and reads it from the file only when a tagging pass runs. A test, or anything else that sets `X_BOOKMARKS_DATA_DIR`, looks for `.env` inside that directory and never finds yours.

## The commands, in order

```
pnpm tag --dry-run        # what a run would send and cost. No request, no key, no change.
pnpm tag --sample 50      # classify 50 bookmarks drawn from across the library
pnpm tag --status         # how the tagging stands: classified, waiting, failed, the share of "other"
pnpm tag                  # classify everything not classified yet
pnpm tag --retag          # classify again what an older taxonomy or older instructions classified
pnpm tag --new-tags       # ask about bookmarks that mention a tag added since they were classified
pnpm tag --tags           # the vocabulary: every tag, how many bookmarks have it, its other names
pnpm tag --proposals      # tags the classifier suggested, for 2 bookmarks or more, alike ones together
```

Look at the sample before the backfill: ask Claude, through the MCP server, to list the classified bookmarks with their category and tags, and read whether you agree. If the labels are off, the usual fix is a clearer definition or rule in the taxonomy; then `pnpm tag --retag` does the sample again under the new wording.

Options: `--limit <n>` takes at most that many; `--max-usd <x>` sets the run's spend cap (default 2); `--batch` sends the run as one batch; `--wait <minutes>` is how long to wait for a batch (default 60); `--retry-failed` asks again about bookmarks the model failed on twice; `--every-bookmark`, with `--new-tags`, asks every bookmark classified before a tag was added, mention or none; `--proposals 1` lists every proposal.

A run prints counts, ids of the taxonomy, token counts and money. It never prints a bookmark.

## What is sent, and where

Every request goes to `https://api.anthropic.com` and nowhere else (`src/anthropic.ts`): the address is written into the client, the environment cannot change it, a request to any other host is refused before it is made, and redirects are off.

Of a bookmark, a request carries what `src/input.ts` lists and nothing else:

| Sent | Not sent |
|---|---|
| The post's text, the first 4,000 characters of a long one | The post's id and address |
| X's language code for it | Who wrote it: id, handle, name, avatar |
| Whether it is a reply | When it was posted or bookmarked |
| For each picture or video: its kind, and the description its author gave it | The pictures and videos themselves, and their addresses |
| The link card's title, description and site | Where the card and the links lead |
| The X Article's title and opening lines | Likes, reposts, views and the other counts |
| The same parts of the post it quotes, 1,500 characters of its text | Who is quoted, and who is replied to |

The text is sent as its author wrote it, so a handle or a link typed into the text is part of it. Nothing is fetched to add to any of this, from X or anywhere else: a thread's other posts, the post a reply answers, an article's body and the media are not in the library, and the model is told they are absent.

Alongside goes the system prompt, which is the same for every post and holds nothing of any, and the schema the answer must fit.

## What a run guarantees

- **Resumable.** Each answer is stored as it arrives. A run that stops, for any reason, has lost nothing; the next takes up the rest. A batch's id is stored before the wait for it, so an interrupted run collects that batch instead of paying for another.
- **Idempotent.** A classified bookmark is not chosen again. Running `pnpm tag` twice sends nothing the second time.
- **Capped.** A run cannot spend more than its cap. Each request is admitted only if the cap holds even at the most that request could cost: every byte a token, every token at its dearest rate, the answer at full length (`mostOf` in `src/pricing.ts`). The true cost is several times lower, so the cap is conservative by design. A batch cannot be stopped once sent, so only requests that fit under the cap on those terms go into it. An attempt that times out may have been charged without anyone being told, so each such attempt is held against the cap too, and the report counts them. One thing the cap cannot cover: a batch is submitted once, and if the answer to that one submission is lost, a batch may exist that the run does not know of. The run says so, and the Console lists it.
- **One at a time.** While a run is open no other starts, so two runs cannot pay for the same bookmark. A run left open by a process that died is set aside after ten minutes without progress.
- **It leaves your corrections alone.** See below.

What it used is reported from the token counts the API returns, priced with the table in `src/pricing.ts`. The invoice is the authority.

## Direct and batch

A request reaches the model one of two ways, chosen in `src/transport.ts`:

- **Direct**, the default: one request, one answer, four at a time, with the instructions read from the prompt cache after the first request. When the rate limit outlasts the client's own retries the run waits a minute and goes on, so a long run finishes unattended.
- **Batch**, with `--batch`: all requests handed over together through the Message Batches API, at half the listed price, with no rate limit, answered within the hour as a rule. `pnpm tag` waits for it; if you stop waiting, run `pnpm tag` again later and it collects the results.

Direct is the default because it is the cheaper of the two as they are sent here, and it is the one that has been run. The first sample, 50 bookmarks on 2026-10-13, measured it: 13,209 uncached input tokens, 158,784 read from the cache, 5,624 output tokens, $0.0061. The instructions are nine tenths of a request, and read from the cache they cost a tenth of the input price: about $0.00012 a bookmark. A batch's requests are processed side by side, where a cache is hit only when it happens to be, so they are sent without one and pay half price on every token: about $0.0002 a bookmark. Half price loses to a tenth.

Both carry the same request, with the same output schema. Anthropic's documentation says structured outputs work in batches; that had not been tried from here when this was written. If a batch comes back with every request rejected, the run says so and marks no bookmark as failed.

## New bookmarks

Once the library has been classified, new bookmarks need no command. The app asks for a pass (`tagNewBookmarks` in `src/automatic.ts`) as it starts, a minute after the last capture of a burst is stored, and once an hour. A pass:

- classifies bookmarks that have no answer yet;
- then asks about bookmarks that mention a tag added since they were classified, and can only add that tag to them (see "Adding a tag" below);
- does nothing about either while more than 150 are waiting, and says so: the first run and any backfill are yours to start;
- spends at most $0.10, and the app's passes together at most $0.30 a day;
- gives up on a bookmark the model fails on twice;
- never holds up a capture and never throws. With no key in `.env`, or with the API out of reach, the bookmarks are stored as always and stay unclassified until a pass succeeds.

`GET /api/tagging` on the app says what the last pass came to.

## Corrections and re-runs

The classifier's answer and your corrections are stored apart. What a bookmark is filed under is your correction where there is one, and the classifier's answer otherwise. So:

- A correction to a category or a format stands through every later run, `--retag` included.
- A correction to a tag is about that tag: one you added stays on, one you removed stays off, and the other tags follow the classifier.
- A re-tagging replaces the classifier's answer and never reads or writes a correction.

## The vocabulary, and how it grows

The tags a bookmark can have are a vocabulary that you change while the app runs. Nothing is edited: every change is a function of core, which a screen calls, and the bookmarks follow at once without the classifier.

| You | Core | What happens to bookmarks |
|---|---|---|
| accept a proposed tag | `acceptTagProposal(store, proposal, { as, variants })` | The tag joins the vocabulary and is put on every bookmark it was proposed for, under any of the names accepted with it. Those names become other ways of writing it. Accepted `as` an existing tag, the proposal becomes another name for that tag instead. |
| add a tag of your own | `addTag(store, name, { aliases })` | It joins the vocabulary. Bookmarks it happened to be proposed for get it. |
| dismiss a proposal | `dismissTagProposal(store, proposal)` | It leaves the list on every bookmark, and the same text is dropped whenever the classifier suggests it again. |
| retire a tag | `retireTag(store, tag)` | No bookmark has it any more, in any list, filter or count; the classifier is not offered it and cannot propose it. Nothing is deleted: adding it again brings it back on the bookmarks that had it. |
| rename a tag | `renameTag(store, from, to)` | The same bookmarks have it under the new name, your corrections included. The old name stays as another way of writing it. |
| make one tag another name for a second | `mergeTags(store, from, into)` | Bookmarks that had the first have the second; what you said of the first on a bookmark is said of the second. The first leaves the vocabulary and stays as an alias. |
| name another way of writing a tag | `addTagAlias(store, alias, tag)` | Filters understand it, and the classifier's suggestion of it becomes the tag. `removeTagAlias(store, alias)` takes it back; bookmarks that got the tag through it keep it. |

`listTags(store)` is the vocabulary with a count and the other names of each tag; `pnpm tag --tags` prints it. Each change that alters what the classifier is told raises the vocabulary's version, and each classification records the version it was made against.

### Adding a tag, and the bookmarks classified before it

A bookmark classified before a tag existed was never asked about it. Three things could follow, and this is the one chosen:

- The bookmarks the tag was **proposed for** get it at once, for nothing.
- The bookmarks whose **text mentions** the tag, by its name or another way of writing it, are asked again in a small pass. The classifier is asked the usual question, and of its answer only tags the bookmark had never been offered are kept. Its category, its format, its other tags and your corrections cannot change, so nothing you have learnt to find moves. The app does this by itself within a minute, inside its usual caps; `pnpm tag --new-tags` does it on demand. It costs what classifying those bookmarks costs: about $0.00012 each, so a tag that forty bookmarks mention costs half a cent.
- The **rest** are left alone. They are not outdated, and `--retag` does not take them. `pnpm tag --new-tags --every-bookmark` asks all of them, which is the price of classifying the library once more, about $0.17 for 1,400: worth doing after a batch of new tags, not after each.

Retiring, renaming and merging need no pass at all.

### Proposals

The classifier may suggest a tag the vocabulary does not hold. A suggestion is recorded as a proposal with the bookmark it was made for, and is on no bookmark. The first 50 bookmarks produced 21, each made once, so a full library produces hundreds. `listTagProposals(store, { minBookmarks, proposedSince, limit, offset })` is built for reading them:

- **Counted and thresholded.** Each comes with the number of bookmarks it was proposed for; `minBookmarks` leaves out the ones made too seldom, and says how many that was.
- **Grouped.** Names that look like one subject are one entry, with each name and its own count: the same letters with and without a hyphen, or a shared word that few other names hold. A group counts the bookmarks any of its names was proposed for, so two one-off spellings of one subject reach a threshold of two together.
- **Compared with the vocabulary.** `similarTags` names the tags a group resembles, as a hint that it may be another way of writing one of them.
- **Dated.** `lastProposedAt`, and `proposedSince` for a week's review.

The grouping compares names, not meanings, and changes nothing. A screen offers it; you decide. `listBookmarks(store, { proposedTag })` shows which bookmarks a proposal was made for.

To keep the same subject from arriving under new names, each run tells the model the names already proposed and asks it to reuse them.

## Why a bookmark is under "other", and what a later phase can do with it

A bookmark lands under "other" for one of two reasons, and they mean opposite things. *Too little text*: the stored text does not say what the post is about, which is a fact about the post. *None of the above*: the post says enough and no category fits, which is a fact about the taxonomy. The model reports which it is (`too_little_text` in its answer), the answer is stored, and core keeps the two apart everywhere "other" is counted:

- `summariseLibrary(store).other` and `summariseTagging(store).other`: both counts, and each as a share of the filed bookmarks. `pnpm tag --status` prints them.
- `summariseMatches(store, { bookmarkedSince, bookmarkedBefore })`: the same for a period, as `tooLittleText` beside the count of "other" in `categories`.
- `listBookmarks(store, { category: "other", tooLittleText: false, bookmarkedSince })`: the bookmarks of a period that had text enough and fitted nowhere. This is the list a weekly review reads to suggest a new category.

Proposals are kept with the bookmarks they were made for, so a review can act on one without classifying anything again:

- `listTagProposals(store, { minBookmarks, proposedSince })`: each proposed subject with how many bookmarks it was proposed for, near-duplicates grouped, and the tags it resembles.
- `listBookmarks(store, { proposedTag })`: which bookmarks those are.
- Accepting one is `acceptTagProposal(store, proposal)`, as a new tag or, with `as`, as another name for an existing one; either puts the tag on exactly those bookmarks. Skipping one for good is `dismissTagProposal(store, proposal)`.

A different question from the model's judgement is whether a post has little text at all, which can be worked out from the stored fields alone: `substanceOf` in `src/input.ts` does, and the dry run counts those posts as "thin". It is not stored, because it can be worked out again at any time.

## Changing the categories, the formats or the instructions

Edit `TAXONOMY` in core and raise its `version`; or edit `src/instructions.ts` or `src/input.ts` and raise `INSTRUCTIONS_VERSION`. Two tests hold the fingerprint of each version and fail until the version is raised and the new fingerprint recorded. Nothing is classified again by the change alone: bookmarks classified before it are counted as outdated by `pnpm tag --status`, and `pnpm tag --retag` does them again when you choose.

The instructions are at version 2. Version 1 classified the first 50 bookmarks; version 2 takes its tags from the vocabulary in the database, tells the model which proposals have already been made, and asks for a tool's plain name. So those 50 are outdated: `pnpm tag --retag` does them again for less than a cent, or they can stay as they are.

## A post that gives orders

Posts are written by strangers, and one may say "ignore your instructions". What stands in its way:

- The answer is held by the API to a schema in which the category and the format can only be values of the taxonomy, and the tags only tags of the vocabulary. This is the main defence: whatever a post says, the worst answer is a wrong label from the list.
- The instructions are the system prompt; the post is a JSON object in the user message, where its text is a string it cannot end. The prompt says the object is material to classify and never instruction.
- The model has no tools. It can answer, and do nothing else.
- The one free text in an answer, a proposed tag, is kept only if it is shaped like a tag, at most two a post, and is never put on a bookmark.
- Characters that hide text from a human reader are removed before sending.
- The answer is checked again on arrival, and nothing of it is printed, logged or executed.

A wrong label is still possible, from a persuasive post or an honest mistake. That is what corrections are for.

## What a real run has shown, and what none has yet

The first sample, 50 bookmarks sent one at a time, came back whole: 50 classified, none failed. So the request as built is accepted, the answer keeps to the schema, and the prompt cache is read. Still to be shown by a real run:

- that the Message Batches API accepts the same request, which matters only if you ask for `--batch`;
- that the instructions of version 2 do as well as version 1 did, which the next sample shows;
- how good the labels are, which is yours to judge.

## Working on it

`src/anthropic.ts` is the client and the only file that sends; `src/api-key.ts` reads the key from `.env`; `src/input.ts` is what is sent of a bookmark; `src/instructions.ts` the prompt and the schema, built from core's taxonomy and vocabulary; `src/request.ts` the request and the reading of an answer; `src/pricing.ts` the prices, the cap's arithmetic and the estimate; `src/transport.ts` the choice of route; `src/run.ts` a run; `src/automatic.ts` the app's pass; `src/report.ts` what is printed; `src/cli.ts` the command.

`pnpm test packages/tagger` runs everything against the fake. `src/boundary.test.ts` reads the repo's source and fails if a second file imports the SDK, names the API's address or the key's variable, reads a key off an environment, or loads a `.env` file into one. The rules are AI-1 to AI-10 and LAB-1 to LAB-11 in `CODING_STANDARDS.md`. Never run `pnpm tag` without `--dry-run` as part of development or a test: a run spends the owner's money.
