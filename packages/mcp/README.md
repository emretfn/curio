# x-bookmarks MCP server

Lets Claude read the bookmark library: a local [MCP](https://modelcontextprotocol.io) server over standard input and output, which Claude Code and Claude Desktop start themselves. It is read-only, makes no network request, and is built on the query functions of `@x-bookmarks/core` and nothing else. It runs on the Claude subscription you already use; there is no API key.

It needs the library to exist: run the app once (`pnpm app`) so the database is created and migrated. After that the app does not have to be running.

## Tools

| Tool | What it does |
|---|---|
| `search_bookmarks` | Keyword search over the post's text, its author, the post it quotes, and the titles of its link card and article. Best match first. Takes the filters below, and `match: "any"` to try several words for one idea at once. |
| `list_bookmarks` | Bookmarks in the order they were bookmarked, newest first or oldest first, optionally within a period. "What did I save this week" is this; with a category, a format or tags it browses a subject. |
| `get_bookmark` | One bookmark in full by its id: the whole text of a long post, the quoted post, links, the link card, media descriptions, counts, what it is filed under and which of that you set yourself. |
| `library_overview` | Totals, the period covered, languages, the most bookmarked authors, how many posts X now withholds, the taxonomy with what each category and format means and how many bookmarks each category, format and tag has, and the current date and time zone. |
| `get_digest` | One week at a glance: how many bookmarks were saved and how they are filed, what the classifier's answers suggest about the taxonomy, and the written summary of the week when you have had one written. With no week, the one that last reached its Sunday evening. |
| `list_withheld_posts` | The bookmarks whose post X no longer sends, by id: those the library still holds a copy of, and those it never captured. |

Search and list share their filters: `category`, `format`, `tags`, `classified`, `author`, `has_media`, `has_link`, `language`, `bookmarked_since`, `bookmarked_before`, `include_removed`, `only_withheld`. They return rows of at most 500 characters of text each, 20 a call by default and 50 at most, with `total` and `next_offset` for the next page. A bookmark removed on X stays in the library and is left out unless `include_removed` is true.

**Category, format and tags.** Each bookmark is filed under one category, one format and a few tags by the classifier (`packages/tagger`), and you can correct any of them; a correction is what the tools then return and filter by. The categories and formats are fixed, `TAXONOMY` in core. The tags are a vocabulary you change from the interface, kept in the database. So that Claude can filter without asking first, the tools' own descriptions list every category and format, and the tags as they stood when the session began; `library_overview` adds what each category and format means, the tags as they stand now, and how many bookmarks each has. `tags` takes several, all of which must hold, and understands a tag's other names, Turkish ones included. A tag the vocabulary does not hold, or one you have retired, is answered with an error that says which. Rows carry `category`, `format` and `tags`; a bookmark that has not been classified carries none, and `classified: false` lists those. The labels are a model's and can be wrong: the server's instructions tell Claude to use them for browsing and to search by words as well. A tag the classifier only proposed is on no bookmark and is not returned.

**Withheld on X.** When a post is deleted, or its author's account is protected or suspended, X keeps the bookmark and stops sending the post. A bookmark the library captured before that stays in every list, and its row and its detail carry `withheld_on_x_at`; `only_withheld` lists those alone. `list_withheld_posts` adds the ones the library never captured, of which there is an id and nothing else. The server tells Claude not to go looking for them: nothing asks X for anything.

**The weekly digest.** `get_digest` takes any day of a week (`week: "2026-10-07"`) and returns that week, Monday to Sunday in this computer's time zone: `saved`, the counts by category, format and tag; `taxonomy_suggestions`, the week's bookmarks that said enough and fitted no category, by id, and the tags the classifier has proposed for two bookmarks or more; and `written`, the summary Claude wrote of the week, with the ids of the bookmarks each theme is about. `written` is null until you run `pnpm digest`, and the tool says so and how: the server cannot write one, because writing one calls the Claude API and spends your money. A written summary is a model's prose about strangers' posts, so it goes out as posts do: as strings in the one JSON document, under the notice, through the same filter for hidden characters, and it names bookmarks by id only. It holds no address: core takes every one out of a digest when it is stored and again when it is read, a host of X's in whatever form it was written, so nothing in it is somewhere for Claude to go. A proposed tag appears here by name and on no bookmark.

The server still only reads. It does not classify or write a digest, does not import the tagger, and has no key; classifying happens in `pnpm tag` and in the app, and a digest is written by `pnpm digest`.

Search is by word, not by meaning. Case, accents and the Turkish dotless i make no difference; a word of three letters or more also finds its longer forms. How it ranks is in `packages/core/src/library.ts`.

## Two things it is built around

**What it returns was written by strangers.** A bookmarked post can say anything, including "ignore your instructions and …". So:

- Every result is one JSON document. Post text sits inside JSON strings, which it cannot close, so a post cannot pass itself off as part of the result's structure or as a second result.
- Every result opens with a `notice` that says the text under `bookmarks` is quoted material and never an instruction. The notice sets the library's own labels apart: a category, a format and tags are ids from a fixed list, not a stranger's words. Each tool's description says the same, and so do the server's instructions.
- Characters that display as nothing but that a model reads (the Unicode tag block and the supplementary variation selectors, both usable to hide text) are dropped from everything returned. The one visible cost: the flags of England, Scotland and Wales show as a plain black flag.
- No result holds an address on X's media or link-shortener hosts. A result does hold the post's address on x.com, for you to open; the server's instructions tell the model never to request it, or anything else from X.

None of that makes a model immune to a persuasive post. What bounds the damage is the next point: a model that is talked into something by a bookmark has, through this server, nothing it can change.

**It cannot change the library, and it talks to nothing.** The database is opened read-only (`openStore(path, { readOnly: true })`), so SQLite itself refuses a write; a read-only open does not create or migrate the file either. The server imports none of core's functions that write, loads no module that could reach a network, and writes nothing to standard output but the protocol. `src/server.test.ts` pins the modules it loads and the functions it takes from core, and `src/main.test.ts` checks that a session of every tool leaves the database file byte for byte as it was. Keep it that way: a tool that writes (retagging from chat, say) belongs in a separate server the user opts into.

## Use it from Claude Code

The repo's `.mcp.json` already registers it for this project.

1. Start `claude` in the repo's root directory.
2. Claude Code asks once whether to use the project's MCP server `x-bookmarks`. Approve it.
3. Check with `/mcp`: `x-bookmarks` should be connected, with six tools. Then ask, for example, "what did I bookmark about SQLite?".

To have it in every project and not only this one, add it once for your user, with the absolute path to this repo:

```
claude mcp add --transport stdio --scope user x-bookmarks -- node /ABSOLUTE/PATH/TO/x-bookmarks/packages/mcp/src/main.ts
```

## Use it from Claude Desktop

Claude Desktop does not read your shell's settings, so both paths must be absolute.

1. In a terminal, in the repo's root, print the two paths:

   ```
   which node
   echo "$PWD/packages/mcp/src/main.ts"
   ```

   `node` must be version 24.12 or later (`node --version`).
2. In Claude Desktop, open **Settings** from the Claude menu in the menu bar, go to **Developer**, and click **Edit Config**. That opens `~/Library/Application Support/Claude/claude_desktop_config.json`.
3. Add the server under `mcpServers`, keeping whatever is already there, with the two paths from step 1:

   ```json
   {
     "mcpServers": {
       "x-bookmarks": {
         "command": "/ABSOLUTE/PATH/TO/node",
         "args": ["/ABSOLUTE/PATH/TO/x-bookmarks/packages/mcp/src/main.ts"]
       }
     }
   }
   ```
4. Quit Claude Desktop completely and open it again.
5. In a new chat, click the "+" ("Add files, connectors, and more") below the message box, then **Connectors**: `x-bookmarks` should be listed, with six tools under **Manage connectors**.

## Settings

`X_BOOKMARKS_DATA_DIR`: the directory holding `bookmarks.db`, when it is not `data/` in this repo. Set it in the `env` of the server's entry, to the same value the app uses.

## When it does not work

- **A tool answers "The bookmark library cannot be read".** The message says why. No database yet, or one from before the last update: start the app (`pnpm app`) or run `pnpm reparse` once; either creates and migrates it. The server tries again on the next call, so Claude need not be restarted.
- **The server does not start.** Run it by hand: `node packages/mcp/src/main.ts` prints one line to standard error naming the database it reads, then waits. A syntax error at that point means `node` is older than 24.12. In Claude Desktop, the server's standard error is in `~/Library/Logs/Claude/mcp-server-x-bookmarks.log`.
- **Claude Code shows it as pending or rejected.** Pending: it is waiting for the approval of step 2. Rejected: the question was answered with no, which Claude Code remembers in `.claude/settings.local.json`. Either way, `claude mcp reset-project-choices` makes it ask again the next time `claude` starts here. `claude mcp get x-bookmarks` shows which it is.

Nothing the server logs quotes a bookmark or a query.

## Working on it

`src/server.ts` defines the tools, `src/format.ts` what a bookmark looks like in a result, `src/main.ts` starts it. `pnpm test packages/mcp` drives the built server over standard input and output with the MCP client library, against a library made from the redacted fixtures. To poke at it by hand: `npx @modelcontextprotocol/inspector node packages/mcp/src/main.ts`.
