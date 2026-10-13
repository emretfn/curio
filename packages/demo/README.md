# The demo library

A library of invented posts, so that the app can be seen full before anything of your own is captured, and the source of every screenshot in the root README.

```
pnpm demo               # build the demo library and start the app on it, at http://127.0.0.1:47131
pnpm demo --port 47200  # the same, on another port
pnpm screenshots        # take the README's screenshots again, into docs/screenshots/
pnpm diagram            # export the README's architecture diagram again, into docs/architecture/
```

`pnpm demo` needs no extension, no pairing, no API key and no network. It can run beside the real app: it keeps its library in `demo-data/` at the repo's root, builds the app into a directory of its own, and listens on its own port. The library is deleted and made again each time the demo starts, so whatever you file, correct or merge in it is yours to break. Stop it with Ctrl+C.

To ask Claude about the demo library, start the MCP server on it: `X_BOOKMARKS_DATA_DIR=demo-data node packages/mcp/src/main.ts` is the command, and [the MCP server's README](../mcp/README.md) says where it goes.

## What is in it

Some 230 bookmarks by about forty authors, saved over the six months before the moment the demo is built:

- every category and format of the taxonomy, with tags, six of which the demo's owner added to the starting vocabulary;
- tags the classifier proposed and nobody has decided on yet, some for several bookmarks, one under two spellings, one that resembles an existing tag;
- posts under "other" for both reasons: some that say too little to tell, and some that say enough and fit no category, most of those about hardware, which is how a missing category shows;
- three corrections by the owner: a category, a format and a tag removed, and a tag added;
- twenty posts in Turkish. Search for `kisayol`, typed without the dotless ı, and it finds `kısayol`, `kısayolları` and `KISAYOL`;
- link cards, quoted posts, replies, long posts, X Articles, photos, videos and a GIF;
- one bookmark removed on X and kept, one whose post X has stopped sending and whose earlier copy is kept, two whose posts were never held, and one with an exact bookmark time;
- a written digest for the week that last ended. It is a sample: its first sentence says so, the line under it names no model, and it cost nothing.

## Every post is invented

No post, name or handle is taken from, paraphrased from or modelled on a real post or a real person. The authors are pen names, never a person's full name. Every handle is sixteen characters or more, and X allows fifteen, so none of them can be an account. Every post id is twenty digits beginning with nine, which is more than an id of X's can hold, so "Open on X" on a demo post leads to no post. Every link leads to a name under `.example`, which is reserved and resolves nowhere.

## What a post with media shows

The placeholder, and nothing more: what is attached (a photo, three photos, a video and its length, a GIF) and the description its author gave it. There is no "Show media" on a demo post.

The app loads a post's media from X's two media hosts and from nowhere else, and only when asked. A demo post has no media on X, because it does not exist there. So the demo gives each picture and video an address under `.invalid`, the app's media policy refuses that address as it refuses every address that is not X's, and what is left is the placeholder. The policy was not widened for the demo, and no picture was put in the repo to stand in: the demo causes no request to any host X owns, and none to any other host either.

## How it is made

The way a real library is. `src/posts/` holds the posts, each with what a classifier would have answered for it. `src/timeline.ts` writes them as pages of the bookmarks timeline in the shape X's web client receives, twenty to a page. `src/library.ts` stores each page as a raw capture and has core's own parser read them, then writes the labels, the corrections, the owner's tags and the digest with the same functions the classifier, the screens and `pnpm digest` use. Nothing is written to a table directly, and nothing calls Claude.

Everything is placed in time from the moment of the build: the newest post was saved minutes ago, and the week the digest is of is the one that last reached its Sunday evening, which is the week `/digest` opens on.

`src/demo.test.ts` builds the library and checks that every post parsed with nothing left empty, that nothing is unclassified or waiting on the classifier, that no capture and no bookmark names a host X owns, that every handle and id is one X cannot have, and that it builds whole on awkward days: a Sunday evening, a Monday just after midnight, the night the clocks change.

The pages are not parser fixtures. They hold what the parser reads and are no copy of a real response; the fixtures under `packages/core/src/parsers/fixtures` are what the parsers are tested against. The rules are DEMO-1 to DEMO-5 in [CODING_STANDARDS.md](../../CODING_STANDARDS.md).

## The screenshots, and the diagram

`pnpm screenshots` takes every screenshot in the root README into `docs/screenshots/`, each in the light theme and in the dark, at twice the density:

- five screens of the app, 1200 by 800: the library, a search, the label filters with a category menu open, the Tags page, and the weekly digest;
- two states of the extension's popup, at its own width: not paired yet, and paired and up to date.

It builds a demo library and the extension into a temporary directory, starts the app on that library on a free port, and drives Playwright's Chromium with the extension loaded. It needs Playwright's browser once: `pnpm --filter @x-bookmarks/demo exec playwright install chromium`.

- `pnpm screenshots --no-build` reuses the app as it was last built into `.next-demo`, and takes about fifteen seconds. Use it after changing the demo's posts or the extension; leave it out after changing the app.
- `pnpm screenshots --only library` takes one shot. The names are `library`, `search`, `labels`, `tags`, `digest`, `popup-not-paired` and `popup-paired`.
- Where `pngquant` is installed the images are made smaller with it; without it they are as the browser wrote them, about twice the size.
- The dates in the images are the dates of the run, so a run on another day changes every image.

The browser is told that the app's real address, `127.0.0.1:47130`, leads to this run's app, as the end-to-end test's browser is, so the extension pairs with it as it would with the real one: with the token the app's own `pair` command prints, typed into the popup. Nothing listens on port 47130. No other name resolves, so the browser can reach nothing but this computer, and the run fails if a page asks for anything but the app.

One thing in the popup's second picture is put there by hand. The counts are written into the extension's own storage, to the number of captures the demo library holds: those captures were not taken by this extension, and the script opens no page of X's, real or fake, to take others. The pairing and everything else the popup shows is the extension's own doing.

A build cannot be made while `pnpm demo` is running, because both build into the same directory: stop the demo first, or pass `--no-build`.

`pnpm diagram` exports the architecture diagram from its source, [`docs/architecture/architecture.html`](../../docs/architecture/architecture.html), to a light and a dark PNG beside it. Edit the HTML, run the command. The source is one page for both themes, with the app's own colours and typefaces and no web font.
