# x-bookmarks web app

The local app: a Next.js server on <http://127.0.0.1:47130>. It receives raw captures from [the extension](../extension/README.md), stores them through `@x-bookmarks/core`, and parses each one into bookmarks as it arrives. Its main screen (`/`) is the library: the bookmarks, newest saved first, to read, search and filter. It also has a status page (`/status`) and a page of pairing instructions (`/pair`), and it backs the library up once a day.

```
pnpm app                                # from the repo root: build, then serve
pnpm pair                               # print the pairing token, creating it on first use
pnpm reparse                            # parse every stored capture again, and list what was not understood
pnpm backup                             # take a verified snapshot of the library now
pnpm --filter @x-bookmarks/web dev      # development server, same address
```

The database is `data/bookmarks.db` at the repo root and the pairing token is `data/ingest-token`. Set `X_BOOKMARKS_DATA_DIR` to keep them elsewhere. To unpair the extension, delete `ingest-token`, restart the app, and pair again.

## The library

`/` lists the bookmarks newest saved first, by core's bookmark time, under the month each was saved in. A post is read where it stands: long text opens in place, and a quoted post, a link card and an X Article's title and opening are shown with it. The search field and the filters in the side column narrow the list, and the whole state of the screen is in the address (`/?q=words&has=media,quote&lang=tr&year=2025&author=<id>&on=withheld`), so a search survives a reload and the back button. The product speaks English; a post keeps its own language, and search ignores case and accents, with the Turkish dotted and dotless i read alike.

- **Search is core's search.** The field's text goes to `searchBookmarks` as typed, so the screen finds what the MCP server finds, folded and ranked the same way: every word must be found, a word of three letters or more also finds its longer forms, double quotes make a phrase. A search is listed best match first, under one heading in place of the months. What it found is marked in each post by core's `markMatches`, on the server; the browser holds no folding or matching code of its own.
- **Removed and withheld.** A bookmark removed on X leaves the list and stays in the library, under "Removed on X" with the time (`/?on=removed`). "Withheld by X" lists the bookmarks whose post X no longer sends: first those the library captured earlier, which stay in every list with a mark, then those it never held, of which only the id is known.

- **One module reads.** Every read the screen makes goes through `src/server/library.ts`: `listLibrary`, `getLibraryFacets`, `getLibraryStatus`. It holds no query of its own. It turns the screen's query into core's filter and calls `listBookmarks`, `searchBookmarks`, `summariseMatches`, `summariseLibrary` and `listWithheldPosts`; a question core cannot answer is added to core (READ-1), not answered there.
- **A bookmark is turned into a view on the server** (`src/lib/post-view.ts`): dates written out, links checked to be HTTP or HTTPS, media addresses passed through the media policy, a search's matches marked. The components render the view and decide nothing.
- **Only the rows near the screen are in the page** (`src/components/library/library-list.tsx`, on `@tanstack/react-virtual`). The list keeps every item it has loaded and draws a window of them, each row at the place its measured height gives it, so the page is as light at the end of the library as at its top. What a windowed list usually breaks is kept, and the end-to-end test holds each of these:
  - A row is measured as it is and again when it changes, so opening a long text or showing media moves what is below it and nothing else.
  - What a row remembers outlives it (`row-memory.tsx`): an opened text is open when its row comes back.
  - **A row showing media from X stays in the page** until the list itself goes, however far it is scrolled. Its pictures are therefore never asked for a second time, and a video in it plays on where it is, from the same element. This is the price of that guarantee: with "Load media on screen" on, every post that has been on screen stays, and the page grows as it did before.
  - The row with the keyboard's focus stays too, so scrolling away and back neither loses focus nor moves it. `J` and `K` go by the list's order, whether or not the next row is drawn yet.
  - The month in view stays under the search bar. Each post says its place among all of them (`aria-posinset`, `aria-setsize`), since a screen reader finds only the rows that are drawn.
  - A reload, or Back to the list, returns to the same place (`place.ts`): how many items were loaded, the scroll offset and the rows' measured heights are kept in the tab's session storage under the history entry's key, and the items are asked for again from this app. A visit by a link starts at the top. It needs the browser's Navigation API; without it no place is kept.
  - **The browser's own Find sees only the rows that are drawn.** The search field (`/`) searches the whole library, and the shortcuts panel says so.
- **The list** renders its first page with the screen and asks `GET /api/library` for each next page as the reader nears the end. A list by time continues from core's cursor, which keeps its place while captures arrive; a search, being ranked, is counted off by position. That route reads and never writes; like the other API routes it checks `Host` itself, sends no CORS header, and refuses a request the browser says came from another site.
- **Status travels with the library.** While all is well it is one line at the foot of the side column. When a capture or an entry was not understood, captures wait for a re-parse, or the last backup failed, a banner above the list says so on every width, and both lead to `/status`.
- **Keys:** `/` search, `J` and `K` next and previous post, `E` open or close a long post, `M` show the post's media, `O` open the post on X. With focus in a video player: Space plays and pauses, the left and right arrows move 5 seconds, up and down are volume, `<` and `>` speed, `0` to `9` jump to that tenth, `F` fills the screen. The map is `src/lib/shortcuts.ts`, and the player takes none of the list's keys, so `J` and `K` move on from inside one and there is no key for mute.
- **Room left on purpose:** tags and categories are further groups in the side column and a row under each post's text; a digest and a chat are further entries beside "All bookmarks", and a chat panel is a third column in the grid of `src/app/page.tsx`.

### Media

Photos, videos, link-card pictures and article covers are on X's media CDN. Showing one is a request to X by the browser, so it happens only when the owner asks. `CODING_STANDARDS.md` X-7 to X-11 are the rules; in short:

| Mode | What asks X's CDN for something |
|---|---|
| Default | Nothing. A placeholder says what is there: photo, video with its length, GIF, how many, and the description its author gave it. |
| "Show media" on a post | That post's pictures, once each, from `pbs.twimg.com`. A quoted post has its own control. A video's file, from `video.twimg.com`, when play is pressed. |
| "Load media on screen" on | The same as pressing "Show media", by itself, for a post whose placeholder has been at least half on screen in a visible tab for 300 ms. Off by default, kept in this browser's storage, never known to the server. |
| Avatars | Never. Initials are shown. |
| The server | Never. No proxy, no cache, no `next/image`. |

Each request is sent without cookies (`crossOrigin="anonymous"`) and without a `Referer`. It does carry an `Origin` header with the app's local address, which is what a browser sends with a request of that kind. The page's Content-Security-Policy admits pictures and video from this app and those two hosts alone. The elements are in `src/components/library/x-media-element.tsx`, the reveal in `media.tsx`, the hosts, the address check and the policy in `src/lib/x-media-policy.ts`.

**The player.** A video plays in the app's own player (`src/components/library/video-player.tsx`), not the browser's: play and pause, a timeline with the time gone and the whole, speed (1, 1.25, 1.5 and 2), mute and volume, full screen. The controls leave a playing picture alone after two and a half seconds without a pointer or a key, and come back at either; a finger's first tap brings them back, its second pauses. Volume, mute and speed are remembered in this browser. Starting one video pauses another. A GIF, which X serves as a short silent video, has no controls: it repeats without sound, and a press on it pauses and plays it. A video that does not load, or loads for eight seconds without playing, says so and offers "Try again".

The player adds no request and changes none. It holds no element and names no address: `media.tsx` hands it the video element of `x-media-element.tsx`, which exists, as before, only once play is pressed, and asks for the one address a capture gave it, core's choice of the highest-bitrate MP4. The poster is the picture "Show media" already loaded, left in place under the video. The player tells the element to play, and at "Try again" to load again; a drag along the timeline seeks once, on release, where the browser's own player seeks all the way along. Picture-in-picture is left to the browser's menu on the video. Adaptive streaming is not built: it would ask X's CDN for a playlist and then for segments as playback goes, a different pattern of requests from the single file the rules allow.

## From capture to bookmark

A delivery is two steps, in `src/server/ingest.ts`. First the capture is stored, exactly as it arrived; the answer to the extension depends on that alone. Then every stored capture that has not been parsed is parsed, oldest first, which is the new one and any left behind by an earlier failure or by an older version of the app. A response the parser does not understand is recorded as such beside its capture; nothing is thrown at the extension, and nothing is lost. If the parsing step itself breaks, the error is logged, the capture stays, and the next delivery or `pnpm reparse` picks it up.

The status page, `/status`, shows the totals:

| Line | Meaning |
|---|---|
| Bookmarks | Posts in the library. |
| Captures parsed | Responses that were understood. One may still hold entries that failed. |
| Captures failed | Responses that were not understood at all. Nothing was taken from them. |
| Entries failed | Single bookmarks, inside understood responses, that were not understood and are not in the library. |
| Parts left empty | Parts of stored bookmarks that were not understood, such as a new kind of link card. The bookmark is in the library without that part. |
| Posts X withholds | Bookmarks whose post X no longer sends: deleted, or from a suspended or protected account. Not a parser problem. |
| Captures with no parser yet | Responses of an operation nothing parses yet, such as a bookmark folder's timeline. Not a failure. |
| Captures waiting for a re-parse | Stored and never parsed, or parsed by an older parser. `pnpm reparse` clears them. |
| Last parsed | When a parse result was last recorded. |

**Anything above zero in "Captures failed" or "Entries failed" means X has changed a response**, or sent a kind the parser has not met. This is the failure this route is prone to. Run `pnpm reparse`: it prints each kind of mismatch once, with the path into the response where understanding stopped and what was expected there, and never a bookmark's content. Then follow "When X changes a shape" in [the parsers' README](../core/src/parsers/README.md). `pnpm reparse` can run while the app is running, and a second run changes nothing.

## Tagging new bookmarks

Each bookmark is filed under a category, a format and tags by the classifier in [`packages/tagger`](../tagger/README.md), which asks the Claude API. The first run and any backfill are started by hand (`pnpm tag`). After that the app keeps up by itself (`src/server/tagging.ts`):

- **When.** A pass is asked for 15 seconds after the app starts, for what arrived while it was closed or could not be tagged; a minute after the last capture of a burst is stored; and once an hour, which is how a pass that failed is tried again.
- **Never in the way of a capture.** The ingest route stores, parses, asks for a pass and answers the extension. It does not wait for the pass, and nothing a pass does reaches the answer. A pass never throws.
- **Without a key, or without the network,** a pass does nothing and the bookmarks stay as they are, stored and unclassified. No key is the state the app starts in: tagging is then off, which is not an error. The key is one line of the `.env` file at the repo's root, under `X_BOOKMARKS_ANTHROPIC_API_KEY`; the tagger's README says how to put it there.
- **The key is not in the app's environment.** Next loads `.env` files from its project directory, which is this one, `packages/web`, and not from the repo's root. This directory must hold no `.env*` file with the key in it, and a test fails if it holds one at all. The tagger reads the root file itself when a pass runs and hands the key to its client; no variable of this process ever holds it. The variable's name is this project's own for the same reason: `ANTHROPIC_API_KEY` in a process's environment takes over the billing of any Claude Code or Agent SDK work started from it. Should that variable be set in the app's environment, a pass does not use it and logs a warning, which `GET /api/tagging` carries too.
- **Small on purpose.** A pass classifies only bookmarks with no answer, leaves a backlog of more than 150 to `pnpm tag`, and spends a few cents at most. The limits are the tagger's.
- **What it sends and where** is the tagger's business and its alone: the app loads the tagger when the first pass runs, and makes no request of its own.

`GET /api/tagging` says how things stand: what the last pass came to (`no-key`, `backlog`, `nothing-to-do`, `ran`, `daily-cap` or `error`, with a message fit to show and whether it is a problem), whether one is running or due, and the library's totals: classified, waiting, failed, the share filed under "other", what has been spent. It holds no bookmark. It reads and starts nothing, checks `Host` like the other API routes, sends no CORS header and refuses a request a browser says came from another site. The same is available to a server component as `taggingStatus()`. No screen shows it yet.

The filters and counts for category, format and tags are in core's query functions (`category`, `format`, `tags` and `classified` on `listBookmarks`, `searchBookmarks` and `summariseMatches`; `labels` on every bookmark), and corrections are written with core's `correctBookmark`. `src/server/library.ts` does not use them yet.

The tag vocabulary is the owner's to change from a screen, with core's functions and nothing else: `listTags`, `listTagProposals` for the proposals worth a look, and `acceptTagProposal`, `addTag`, `dismissTagProposal`, `retireTag`, `renameTag`, `mergeTags`, `addTagAlias` and `removeTagAlias` for what the owner decides. Each carries the bookmarks with it. A route that calls `acceptTagProposal` or `addTag` should then call `scheduleTagging(0)`: the pass that follows asks the bookmarks that mention the new tag, and can add that tag to them and nothing else. The tagger's README has what each does to bookmarks.

## Backups

The raw captures cannot be collected again, so the app keeps snapshots of the whole database outside the repo.

- **When.** As the app starts, and then once an hour, it looks whether a snapshot is due (`src/instrumentation.ts`, `src/server/backups.ts`). One is due when the latest is a day old, and is then taken as soon as the library differs from it. So there is never more than one a day, a library that is not changing is not copied again, and new captures wait an hour at most once a day has passed. `pnpm backup` takes one at any time, whatever the age of the last.
- **What.** One file, `snapshot-<UTC time>.db`, a complete and consistent copy taken by SQLite while the app keeps running. Before it gets that name it is opened and checked: SQLite's integrity check, the same schema, and every raw capture equal to the database's, column for column. A file with a snapshot's name has passed.
- **Where.** `../x-bookmarks-backups`, beside the repo, readable by you alone. Set `X_BOOKMARKS_BACKUP_DIR` to keep them elsewhere; another disk or a synced folder also covers the loss of this one. (When `X_BOOKMARKS_DATA_DIR` moves the data directory, the default becomes `backups` inside it.)
- **How many.** The newest 10; `X_BOOKMARKS_BACKUP_KEEP` changes that. Only files with a snapshot's name are ever deleted, so copies you put there by hand stay.
- **When it fails.** Every screen says so until a backup succeeds: the library in a banner above the list and in its status line, the status page in red on the Backups card, each with the reason, which is also logged. The app keeps running.
- **Restoring.** Stop the app, move `data/bookmarks.db` and the `-wal` and `-shm` files beside it out of the way, copy the snapshot to `data/bookmarks.db`, start the app.

The Backups card on the status page (`src/components/backup-status-card.tsx`) shows how many snapshots there are, the time of the latest, what the last look came to, and the directory.

## Who may write to the app

**The threat.** The app is an HTTP server on this machine that writes to a personal database. Any web page open in any browser on the machine can send requests to `127.0.0.1`, and so can any program and any other user logged in to the machine. Without a defence, any of them could fill the library with forged captures, which later become forged bookmarks with forged first-seen times, or fill the disk. Other devices on the network could do the same if the server listened on every interface. And in the other direction: while the app is closed, anything can listen on its port and receive what the extension sends.

**The defences**, in the order a request meets them:

1. **Loopback only.** The start scripts bind `127.0.0.1`, so no other device can connect.
2. **`Host` must be the app's own address**: `127.0.0.1:47130` or `localhost:47130`. This defeats DNS rebinding, where a site re-points its own domain at 127.0.0.1 to be treated as the app's origin. `src/proxy.ts` checks it for pages and the API routes check it themselves.
3. **`Origin` must be the extension.** `/api/ingest` and `/api/pairing` accept one origin, `chrome-extension://imbpimaegfnjdhdcfefapkaejieaahjh`. The browser sets `Origin` and page script cannot change it, so this alone refuses every web page, including "simple" form-style posts that browsers send without asking first. The id is fixed by the `key` in the extension's manifest. A program that is not a browser can send any `Origin` it likes, which is what the next defence is for.
4. **The request must be signed with the pairing token.** The token is a 256-bit secret created on first use and kept in a file only its owner can read. `pnpm pair` prints it in the terminal, and the user pastes it once into the extension. It is never sent and never served: no page or route of the app contains it. The extension signs each request with it (HMAC-SHA-256 over the method, path, a nonce and the body's hash), and the app checks the signature, in constant time, from the headers alone.
5. **No CORS.** The app never sends an `Access-Control-Allow-*` header and refuses `OPTIONS`. The extension needs neither, because its host permission exempts it from CORS, so a page's preflight always fails and a page can never read an answer.
6. **All of that before the body is read**, by `refuseUnlessExtension` in `src/server/guard.ts`. Then the body must hash to what was signed, and be JSON of at most 16 MiB describing a capture of an allowlisted operation with a plausible time, or nothing is stored.
7. **The app proves itself in return.** Every answer to a signed request carries the app's own signature over the answer, tied to the request's nonce. The extension sends no capture until it has seen that proof, and removes a capture from its queue only on a proven answer naming that capture. So a program squatting on the port while the app is closed gets no bookmarks, learns no secret, and cannot make the extension discard anything.

Pages are also served with headers that stop other sites framing or embedding them.

**Who that keeps out, and who it does not:**

| Who | Outcome |
|---|---|
| A web page, in any browser | Kept out, by `Origin` and the missing CORS approval. In Chrome a public site is stopped earlier still, by Local Network Access. |
| Another device on the network | Kept out: the app listens on loopback only. |
| A site using DNS rebinding | Kept out, by `Host`. |
| Another extension | Kept out: its origin is not this extension's, and it does not hold the token. |
| Another user of this computer, or a program running as another user | Kept out. They can connect to the port and forge `Origin`, but cannot read the token file or the extension's storage, so they cannot sign. A program of theirs listening on the port gets nothing. |
| A program running as you | **Not kept out.** It can read `data/ingest-token` and sign as the extension. It can also read and write `data/bookmarks.db` directly, and the extension's storage in your Chrome profile, so the endpoint is not what protects the library from it. Nothing in this app can. |
| A script inside an x.com page | Cannot reach the app, but can hand the extension a made-up response for an allowlisted operation, which is then delivered and stored, dated when it arrived. See [the extension's README](../extension/README.md#what-a-script-in-the-page-can-do-to-the-extension). |

The unit tests in `src/server` cover each refusal. The end-to-end test attacks the running app from a web page in a real browser and from a program with forged headers, and puts an impostor on the app's port.

## How Next.js fits this repo

- **Core is not bundled.** The repo's packages export TypeScript source and have no build step. Next bundles such a workspace package, and does it once per server layer (pages, route handlers), so a normal import gives the process several copies of core, each with its own table of open connections; a store opened by one is rejected by another. Listing core in `serverExternalPackages` did not prevent this when tried on Next 16.4. So `src/server/core.ts` imports core with `/* turbopackIgnore: true */`, which leaves the import for Node. Node runs core's source directly, as everywhere else in the repo, and finds the native SQLite driver in core's own dependencies. Import core's functions from `src/server/core.ts`; import only types from `@x-bookmarks/core`.
- **The store is shared on `globalThis`** (`src/server/data.ts`), because Next evaluates server modules more than once.
- **Imports.** Relative imports carry `.ts`, as in the rest of the repo. Imports through the `@/` alias do not, because TypeScript rejects the extension there.
- **Typecheck** runs `next typegen` first: `next-env.d.ts` and the route types are generated, not committed.
- **The API routes are outside `src/proxy.ts`.** Next buffers the body of any request that passes through the proxy and silently cuts it at 10 MB (`experimental.proxyClientMaxBodySize`), which truncated large captures. The proxy's matcher therefore leaves `/api/` out, and those routes make the proxy's `Host` check themselves. The end-to-end test sends a 12 MB capture through the running server.
- **Production mode by default.** `pnpm app` builds and serves, so the development server's extra endpoints are not exposed during everyday use.
- **The build directory can be moved.** `X_BOOKMARKS_NEXT_DIR` names it; the default is `.next`. The end-to-end test builds into `.next-e2e`, because a rebuild of `.next` breaks an app that is serving from it. After that test `next-env.d.ts`, which is generated, points at `.next-e2e`; `pnpm typecheck` regenerates it.
- **`src/instrumentation.ts`** is Next's start hook: `register()` runs once as the server starts, and starts the backups. It does nothing during `next build`.
- **`AGENTS.md`** in this directory is written by `next dev`. It points at the Next documentation shipped in `node_modules/next/dist/docs/`, which is the reference for this version.

## shadcn/ui

Set up with `shadcn init --preset nova` on the Base UI primitives (`components.json`), Tailwind v4. The components the library uses are in `src/components/ui`; the library's own are in `src/components/library`. The preset's neutral palette is kept, with three additions in `src/app/globals.css`: a link colour, which is also the focus ring, a highlight for search matches, and a tint behind an author's initials.

- Add components from this directory: `pnpm dlx shadcn@latest add <name>`, then `pnpm lint:fix` from the root, because the generated files are not in the repo's formatting.
- Departures from the generated components: the layout does not load the Geist font from Google, at build time or in the browser, so `--font-sans` in `src/app/globals.css` is the system typeface and no page asks another host for a font; transitions name their properties instead of `all`; a pressed button scales to 0.96; and the sheet's slide is dropped for a reader who has asked for less motion.
- The repo's strict TypeScript settings (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) apply to generated components. `card` passes; if a later component does not, fix the component.
