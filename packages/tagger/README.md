# x-bookmarks tagger

Files each bookmark under one category, one format and a few tags, by asking Claude; and, when you ask for it, writes the summary of a week for the weekly digest. It is the only code in this repo that calls Claude, and the only code that sends anything of the library to a third party. It needs an API key, and a run costs money: about $0.00012 a bookmark as first measured, so under twenty cents for a library of 1,400, and a cent or so a week after that. A week's digest is one request more, a few cents: see "The weekly digest" below.

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
pnpm tag --status         # how the tagging stands: classified, waiting, failed, outdated, the share of "other", and whether the app may tag by itself
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

## New bookmarks: by hand, unless you let the app

**By itself the app sends nothing to the API and spends nothing.** Every request the classifier makes is one you started with `pnpm tag`, until you say otherwise. New bookmarks are stored and searchable as always and wait unclassified; `pnpm tag` classifies what is waiting, and `pnpm tag --new-tags` asks about tags added since. `pnpm tag --status` says how many are waiting.

To let the app keep up by itself, add one line to the same `.env` file, in an editor:

```
X_BOOKMARKS_APP_TAGGING=on
```

Remove the line, or set it to anything else, to turn it off again. Either way it takes effect at the app's next pass, with no restart.

- **Only you can set it.** It is a line of a file you edit by hand. Nothing in the repo writes that file; no page, route, MCP tool or argument turns the app's tagging on, and `GET /api/tagging` only reports it. A switch on a page is one any script on that page could flip.
- **Only the word `on` turns it on.** No file, no line, an empty value, `true`, `1`, or two lines that disagree: all off. It is read from the file and never from an environment.
- **A key is not a yes.** With a key in place and this line absent, the app still sends nothing. The key is what your own runs use.
- **Off means nothing is sent.** A pass counts what is waiting, which is a query of the library, and answers `off`, saying how to turn it on and which commands do the same by hand. It does not open the key, collect a batch your run left waiting, or even load the client: `src/automatic.ts` imports the client and the run only inside a pass that is allowed and has something to send, and the app loads that file alone (`@x-bookmarks/tagger/automatic`).
- **What is free still happens.** Accepting a proposed tag puts it on the bookmarks it was proposed for at once, on or off: that is a write to the database and no request. Only asking the bookmarks that merely mention the tag needs the classifier, and with the app's tagging off that is `pnpm tag --new-tags`.

With the line in place, the app asks for a pass (`tagNewBookmarks` in `src/automatic.ts`) as it starts, a minute after the last capture of a burst is stored, and once an hour. A pass:

- classifies bookmarks that have no answer yet;
- then asks about bookmarks that mention a tag added since they were classified, and can only add that tag to them (see "Adding a tag" below);
- does nothing about either while more than 150 are waiting, and says so: the first run and any backfill are yours to start;
- spends at most $0.10, and the app's passes together at most $0.30 a day;
- gives up on a bookmark the model fails on twice;
- never holds up a capture and never throws. With no key in `.env`, or with the API out of reach, the bookmarks are stored as always and stay unclassified until a pass succeeds.

`GET /api/tagging` on the app says whether tagging by the app is on, with the same message as `pnpm tag --status` and `pnpm tag --check`, and what the last pass came to.

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
- The bookmarks whose **text mentions** the tag, by its name or another way of writing it, are asked again in a small pass. The classifier is asked the usual question, and of its answer only tags the bookmark had never been offered are kept. Its category, its format, its other tags and your corrections cannot change, so nothing you have learnt to find moves. `pnpm tag --new-tags` does it; the app does it by itself within a minute, inside its usual caps, if you have turned its own tagging on (see "New bookmarks" above). It costs what classifying those bookmarks costs: about $0.00012 each, so a tag that forty bookmarks mention costs half a cent.
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

Edit `TAXONOMY` in core and raise its `version`; or edit `src/instructions.ts` or `src/input.ts` and raise `INSTRUCTIONS_VERSION`. That number is written in core (`packages/core/src/tagging.ts`) and re-exported here, because core's own counts need it: `summariseTagging` and `listClassificationCandidates` hold a classification outdated against it unless they are told another version, so every reader of the library, the app's status and the MCP server included, counts the same bookmarks as outdated that `pnpm tag --status` does. Two tests hold the fingerprint of each version and fail until the version is raised and the new fingerprint recorded. Nothing is classified again by the change alone: bookmarks classified before it are counted as outdated by `pnpm tag --status`, and `pnpm tag --retag` does them again when you choose.

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

## The weekly digest

The digest page (`/digest` in the app) shows each week of bookmarks: what was saved, counted by category, format and tag, the posts themselves, and what the classifier's answers suggest about the taxonomy. All of that is read from the library and costs nothing. `pnpm digest` adds the written part: Claude's summary of the week, its themes and which posts are worth going back to. That is one request to the Claude API for a week, it costs money, and nothing starts it but you: not the app, not a capture, not the MCP server. The app's own tagging has a switch, `X_BOOKMARKS_APP_TAGGING`, because the app would otherwise act by itself; the digest has none, because the app never writes one, on or off. `pnpm digest` is yours to run either way, as `pnpm tag` is.

It lives in this package, under `src/digest/`, because this is the one package that sends anything to Claude. It sends through the same client, `src/anthropic.ts`, to the same one host, with the same key from the same `.env` line.

```
pnpm digest --dry-run              # what would be sent and what it would cost. No request, no key, no change.
pnpm digest                        # write the digest of the week that last reached its Sunday evening
pnpm digest --week 2026-10-05      # write that week's: any day of a week names it
pnpm digest --week 2026-10-05 --again   # write it again; the earlier one stays on record
pnpm digest --list                 # the digests written so far and what each cost
```

`--max-usd <x>` sets the run's spend cap (default 0.50). `--scheduled` records the run as the schedule's.

**Which week.** A week runs Monday to Sunday in this computer's time zone, over each bookmark's bookmark time. With no `--week`, the command takes the week that last reached Sunday 18:00: from Sunday evening that is the week then ending, and on Monday morning it still is.

**What is sent.** The week's bookmarks, in one message: each as exactly what the classifier sends of a bookmark (the table above), cut shorter (1,200 characters of a post's text, 500 of a quoted post's, 300 of any title or description), with a number, its place in that message. No post id, author, time, count or address, not the week's dates, and not how a bookmark is filed. `src/digest/input.ts` calls the classifier's own `classifierInput` and reads no field of a bookmark itself; `classifierInput` refuses a limit above the classifier's. Bookmarks removed on X are left out, and so is one with nothing in it for a model to read. A week of more than 150 is summarised from its most recent 150.

**What comes back, and what is believed of it.** The answer is held by the API to a schema: an overview, themes and posts worth going back to, in which a post can only be one of the request's numbers. `readDigest` checks it again and turns each number into a post id through the run's own list; a number that is not one of the request's points at nothing. Core's `finishDigestRun` then checks every id against the bookmarks the run sent, strips hidden characters, control characters and anything written as an address, and bounds each part. So whatever a post said, the stored digest is plain prose that points only at bookmarks of that week. The page shows it as text and draws each bookmark with the library's own component; the MCP server returns it as quoted material.

**What it costs.** The model is `claude-opus-5-5`, at $4 a million input tokens and $20 a million output tokens as its prices stood on 2026-10-06 (`src/pricing.ts`). The dry run against the library as it stood on 2026-10-13 said, for the three latest weeks: 9 bookmarks, $0.03 to $0.08; 32 bookmarks, $0.05 to $0.13; 37 bookmarks, the heaviest week in three years, $0.06 to $0.16. Those are estimates from the length of the text; no digest had been written when this was. The median week holds 8 bookmarks. A run cannot spend more than its cap: the request goes only if the cap holds at the most it could cost, every byte a token and the answer at its full 8,000 tokens, which for those weeks is $0.21 to $0.30. Where a week does not fit, its oldest bookmarks are left out, and the report and the page say how many.

**What a run guarantees.**

- **Idempotent.** A week that has a digest is not written again without `--again`. A week of fewer than three bookmarks gets none. Neither needs a key or sends anything.
- **Capped**, as above. An attempt that went out and brought no answer back may have been charged: it is held against the cap at the most it could have cost, and another is made only if the cap still holds. The API being away or busy is tried three times at most.
- **One at a time.** While a run is open no other starts.
- **Recorded.** Every run is a row of `digest_runs` (migration 8): the week, the model, the version of the digest's instructions, the bookmarks sent, the tokens the API reported, the cost, the cap, and the text where one was written. A failed run records its reason as a code and what it cost.
- **Quiet.** What it prints is the week, counts, tokens and money. The digest itself is on the page and in no terminal or log.

The model always thinks, at medium effort. A refusal, an answer cut short and an answer that is no digest each end the run as failed, with their tokens paid for and nothing stored; there is no fallback to another model, which would change the price under the cap.

### On a schedule

`launchd/dev.x-bookmarks.digest.plist` is a launchd job that runs `pnpm digest --scheduled --max-usd 0.50` every Sunday at 21:00. It is a template: nothing here installs it. From the repo's root:

```
mkdir -p ~/Library/LaunchAgents
sed -e "s|__NODE__|$(command -v node)|" -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" \
  packages/tagger/launchd/dev.x-bookmarks.digest.plist > ~/Library/LaunchAgents/dev.x-bookmarks.digest.plist
plutil -lint ~/Library/LaunchAgents/dev.x-bookmarks.digest.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.x-bookmarks.digest.plist
```

To remove it:

```
launchctl bootout gui/$(id -u)/dev.x-bookmarks.digest
rm ~/Library/LaunchAgents/dev.x-bookmarks.digest.plist
```

- **It is the one thing that spends unattended with `X_BOOKMARKS_APP_TAGGING` off.** That line of `.env` is about what the app does by itself, and this job is not the app: it is a separate program that launchd starts, it does not read the line, and "off" there does not stop it. Nothing spends by itself as the repo is checked out: the app's tagging is off until you write that line, and this job does not exist until you run the commands above. Running them is how you say yes to it, and `launchctl bootout`, above, is how you say no. With neither the line nor the job, every request to the API is one you typed.
- **What it spends.** At most $0.50 a week, which is its cap; by the estimates above about $0.03 to $0.16, so some $0.15 to $0.70 a month. Nothing in a week that holds fewer than three bookmarks, and nothing twice for one week.
- **When the Mac is asleep at 21:00** launchd runs the job when it wakes, and the week it writes is still the one that ended. Switched off, that week is skipped; `pnpm digest --week <day>` writes it later.
- **What it needs.** The key in `.env`, as for `pnpm tag`. Without one the job fails and says so in `~/Library/Logs/x-bookmarks-digest.log`, which holds what the command prints and nothing of a bookmark. The path of `node` is written into the installed file: after changing Node versions with a version manager, install it again.
- **Not tried from here.** The job was written and checked as a property list, and never loaded. In particular macOS may ask, the first time it fires, whether `node` may read the folder the repo is in.

## Working on it

`src/anthropic.ts` is the client and the only file that sends; `src/api-key.ts` reads the key from `.env`, and from the same file whether the app may tag by itself; `src/input.ts` is what is sent of a bookmark; `src/instructions.ts` the prompt and the schema, built from core's taxonomy and vocabulary; `src/request.ts` the request and the reading of an answer; `src/pricing.ts` the prices, the cap's arithmetic and the estimate; `src/transport.ts` the choice of route; `src/run.ts` a run; `src/automatic.ts` the app's pass, and the one entry the app loads; `src/report.ts` what is printed; `src/cli.ts` the command.

The digest's files mirror those, under `src/digest/`: `input.ts` is what is sent of a week; `instructions.ts` the prompt, the answer's shape, the model and `DIGEST_INSTRUCTIONS_VERSION`; `request.ts` the request and the reading of an answer; `run.ts` the plan and a run; `report.ts` what is printed; `cli.ts` the command. What a digest is in the library, and the week it is of, are core's `src/digests.ts` and `src/weeks.ts`. Change the wording, the answer's shape, the limits or the model and `request.test.ts` fails until the version is raised and the new fingerprint recorded.

`pnpm test packages/tagger` runs everything against the fake. `src/boundary.test.ts` reads the repo's source and fails if a second file imports the SDK, names the API's address or the key's variable, reads a key off an environment, or loads a `.env` file into one; and if a second file names the setting for the app's own tagging, anything in the classifier writes a file, or the app's entry comes to load the client before a pass may send; and if anything but the digest's own command can start a digest, a file the app's entry reaches imports one of the digest's, or the digest's files read a field of a bookmark beyond its id. The rules are AI-1 to AI-14 and LAB-1 to LAB-11 in `CODING_STANDARDS.md`. Never run `pnpm tag` or `pnpm digest` without `--dry-run` as part of development or a test: a run spends the owner's money.
