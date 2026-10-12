# X bookmarks without the official API: extraction research

Researched 2026-10-12. Scope: one user, their own account, personal library. The official API is covered in [x-api.md](x-api.md).

Question: how feasible is it to sync a user's own X bookmarks into a local database through a browser extension or similar, without the official API, and what does that route give up?

## How this was sourced

Claims are traced to the source that owns them:

- **Project source code and repositories**, read from shallow clones made on 2026-10-12. A statement about what a tool does cites the file that does it, not the README's description of it.
- **Issue and pull-request threads** on those repositories, read through the GitHub API.
- **X's own pages**: the Terms of Service (fetched live, effective 2026-10-09) and help-center pages (read from Wayback Machine snapshots because help.x.com refused direct fetches; snapshot dates are given).
- **Browser vendor documentation**: Chrome for Developers and MDN.
- **The live response headers of x.com**, for its Content-Security-Policy.

Each claim carries one of three labels:

- **[V]** verified by me in the cited primary source.
- **[FH]** first-hand report: someone describing what their own tool, requests or account did. Read by me at the cited link, not confirmed independently.
- **[I]** inference: my own reading or arithmetic from the evidence cited beside it.

Vendor blogs, news write-ups and other people's research summaries are not used as evidence. A few claims I met only in such sources are listed under "Not verified" so they are not mistaken for findings.

No live capture was made against a logged-in X session. Anything only a live session can show is listed under "Not verified".

## Bottom line

**Recommended approach:** a small browser extension (Manifest V3) that passively reads the JSON responses X's own web client already receives on the bookmarks page (`Bookmarks`, `BookmarkFolderTimeline`, `BookmarkFoldersSlice`), forwards the raw payloads to the local app, and lets the local app do all parsing and storage. The extension sends no requests to X of its own. Backfill is done once by scrolling the bookmarks page to the bottom; after that, opening the bookmarks page now and then keeps the library current.

**How reliable:** good, with maintenance. The most used tool built this way (twitter-web-exporter) shipped a release on 2026-08-31 and had three bookmark-related parser bugs reported in the first nine months of 2026, all now closed. Passive capture is immune to the things that break "call the internal API yourself" tools (rotating query IDs, the transaction-id header, Cloudflare challenges, feature flags). It still breaks when X changes the response shape or renames the operation.

**What the user gives up versus the official API:**

- No contract. X can change or rename the internal responses without notice, and the tool silently captures nothing until the parser is fixed.
- No unattended sync. Data arrives only when a logged-in desktop browser has the bookmarks page open.
- Terms of service. X's terms prohibit scraping and non-API automation. Passive reading of what the browser already loaded is the lowest-exposure variant and I found no report of account action from it, but X does not permit it in writing.

**What is the same either way:** neither route exposes a real "bookmarked at" timestamp ([x-api.md](x-api.md), "Hard limit 2"). The digest needs first-seen time at sync in both cases. This route adds the timeline `sortIndex`, which may encode the real time (section 3).

**What the user gains:** no API fees, no documented 800-post ceiling ([x-api.md](x-api.md), "Hard limit 1"), full folder contents, and the complete tweet payload the web client gets.

---

## 1. Techniques

### 1a. Passive interception of the web client's responses (recommended)

How existing tools hook in:

- **Patch `XMLHttpRequest` in the page's own JavaScript world, at document start.** twitter-web-exporter (TWE) replaces `XMLHttpRequest.prototype.open` on `unsafeWindow`, adds a `load` listener, and runs URL-matched interceptors over `responseText`. Its bookmarks interceptor matches `/\/graphql\/.+\/Bookmarks/` and reads `data.bookmark_timeline_v2.timeline.instructions`. [V] [manager.ts](https://github.com/prinsss/twitter-web-exporter/blob/main/src/core/extensions/manager.ts), [bookmarks/api.ts](https://github.com/prinsss/twitter-web-exporter/blob/main/src/modules/bookmarks/api.ts)
- The hook must run in the page context, not the isolated content-script context. TWE detects the wrong context at runtime and logs a pointer to its open CSP issue. [V] [manager.ts](https://github.com/prinsss/twitter-web-exporter/blob/main/src/core/extensions/manager.ts), [issue #19](https://github.com/prinsss/twitter-web-exporter/issues/19)
- TWE and the TBD userscript hook only XHR. Siftly's import script patches both `window.fetch` and XHR. [V] [TBD userscript](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js), [Siftly import page](https://github.com/viperrcrypto/Siftly/blob/main/app/import/page.tsx)
- XHR-only tools were still shipping releases in August 2026, so X's client uses XHR for these calls today. Patching both is the safe choice. [I]

What Manifest V3 allows:

- A content script can be declared with `"world": "MAIN"`, which "will share the execution environment with the host page's JavaScript". Chrome warns that "the host page can access and interfere with the injected script." [V] [Chrome: content scripts manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- `chrome.webRequest` cannot read response bodies. Its events expose headers and status; request headers are visible through `onSendHeaders`. `webRequestBlocking` is "only available to policy installed extensions" as of MV3. [V] [Chrome: webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- `chrome.debugger` can instrument network traffic (the `Network` and `Fetch` protocol domains are on its allowed list) with the `debugger` permission. [V] [Chrome: debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger). Heavier than this job needs. [I]
- Firefox only: `webRequest.filterResponseData()` gives a stream filter over the response body. MV3 extensions need `webRequest`, `webRequestBlocking` and `webRequestFilterResponse`. [V] [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData)
- Userscript route: Tampermonkey 5.3+ on Chrome needs either the "Allow User Scripts" toggle (Chrome 138+) or Developer Mode. [V] [Tampermonkey FAQ Q209](https://www.tampermonkey.net/faq.php?q=Q209), [Chrome: userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts)

So the workable MV3 design is: a MAIN-world script patches XHR and fetch and passes matching response text by `window.postMessage` to an isolated-world content script, which relays it to the service worker. [I]

Limit of the technique: it sees only what the page loads. TWE's hook issues no request of its own; it only listens for `load` on requests the page made. [V] [manager.ts](https://github.com/prinsss/twitter-web-exporter/blob/main/src/core/extensions/manager.ts)

### 1b. DOM scraping of the bookmarks page

- One current extension does it: a content script at `document_idle` reads `article[data-testid="tweet"]`, `User-Name` and `tweetText`, and scrolls the page itself. It requests no x.com host permissions. [V] [manifest](https://github.com/LucasDitchun/export-bookmarks-x-twitter/blob/main/public/manifest.json), [extractor tests](https://github.com/LucasDitchun/export-bookmarks-x-twitter/blob/main/src/content/extract-bookmarks.test.ts)
- The selectors were present on 2026-09-14: `section article` and `[data-testid="cellInnerDiv"]` matched on the bookmarks, likes and profile timelines. [FH] [Cyd findings 2026-09-14, section 6](https://github.com/lockdown-systems/cyd/blob/main/docs/x-capture/findings-20260914.md)
- Weaker data than interception: the list is virtualized, long posts are cut at "Show more", videos are blob URLs, and there is no `sortIndex`, folder id, or structured quoted post. The `<time datetime>` in the DOM is the post time, not the bookmark time. [I]

Verdict: fallback only.

### 1c. Calling the internal GraphQL endpoints directly with session cookies

What it takes:

- GET `https://x.com/i/api/graphql/{queryId}/Bookmarks?variables=...&features=...` with the web client's bearer token, an `x-csrf-token` header equal to the `ct0` cookie, and the session cookies. [V] [fieldtheory-cli graphql-bookmarks.ts](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts)
- fieldtheory-cli imports cookie extractors for Chrome-family browsers and Firefox and reads the session from the browser's local cookie store. [V] [graphql-bookmarks.ts imports](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts)

What breaks:

- **Rotating query IDs.** I found five different IDs for the single `Bookmarks` operation. Four are in source code: `j5KExFXtSWj8HjRui17ydA` (TWE source comment), `Z9GWmP0kP2dajyckAaDUBw` (fieldtheory), `Fy0QMy4q_aZCpkO0PnyLYw` (tweetxvault), `iblrFnKr6PZUR-dWpfXG6g` (omniget). [V] [TWE](https://github.com/prinsss/twitter-web-exporter/blob/main/src/modules/bookmarks/api.ts), [fieldtheory](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts), [tweetxvault](https://github.com/lhl/tweetxvault/blob/main/tweetxvault/query_ids/constants.py), [omniget](https://github.com/tonhowtf/omniget/blob/main/src-tauri/omniget-core/src/core/tools/x/query_ids.rs). The fifth, `tF6KOjmZM0WGcB2Q0mfwhw`, is what X's client sent on 2026-09-14. [FH] [Cyd findings, section 0](https://github.com/lockdown-systems/cyd/blob/main/docs/x-capture/findings-20260914.md)
- Tools cope by scraping IDs out of X's JS bundles (tweetxvault, cached 24 hours; xarchive, a regex over bundles on `abs.twimg.com`) or by hardcoding and patching (fieldtheory). [V] [tweetxvault store.py](https://github.com/lhl/tweetxvault/blob/main/tweetxvault/query_ids/store.py), [xarchive query-ids.js](https://github.com/sytelus/xarchive/blob/main/lib/query-ids.js)
- **`x-client-transaction-id` and Cloudflare.** General-purpose clients have open breakage reports on both: twikit "ClientTransaction broken as of March 18 2026"; twscrape "XClIdGen creation attempt failed" (2026-09-30), "X web scripts not found ... Cloudflare challenge shell served instead of app HTML" (2026-08-25), "user_by_id blocked by CloudFlare" (2026-09-12). [FH] [twikit #408](https://github.com/d60/twikit/issues/408), [twscrape #340](https://github.com/vladkens/twscrape/issues/340), [#330](https://github.com/vladkens/twscrape/issues/330), [#337](https://github.com/vladkens/twscrape/issues/337)
- Neither fieldtheory nor tweetxvault sends a transaction id on the bookmarks read (no occurrence of the header in either codebase). [V] So that read was not enforcing it when those tools last worked. [I]
- **Request shape.** xarchive has an open report of HTTP 422 since August 2026; fieldtheory has an open 401 report. [FH] [xarchive #3](https://github.com/sytelus/xarchive/issues/3), [fieldtheory #25](https://github.com/afar1/fieldtheory-cli/issues/25)
- **Rate limits.** A rate limit is HTTP 429 with a plain-text body and `x-rate-limit-limit`, `x-rate-limit-remaining` and `x-rate-limit-reset` headers. In that capture the limit header read 50, and peripheral endpoints were limited before timeline operations. [FH] [Cyd findings, section 12](https://github.com/lockdown-systems/cyd/blob/main/docs/x-capture/findings-20260914.md)
- Pacing the tools chose: fieldtheory 600 ms between pages by default; tweetxvault 2.0 s with a 300 s cooldown after three rate limits; xarchive 2.5 to 3.75 s jittered, exponential backoff on 429, a five-minute cooldown after three in a row and a full stop after five. [V] [fieldtheory](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts), [tweetxvault config.py](https://github.com/lhl/tweetxvault/blob/main/tweetxvault/config.py), [xarchive fetcher.js](https://github.com/sytelus/xarchive/blob/main/lib/fetcher.js)
- **Account risk and credential exposure.** See section 5. The session cookies this route copies out of the browser grant full account access. [I]

Verdict: more convenient (headless, schedulable, backfill without scrolling) and clearly the more fragile and riskier route. Not recommended as the primary path.

### 1d. The official "download your data" archive

- X's help pages list what the archive includes: profile information, posts, Direct Messages, Moments, media, followers, following, address book, Lists, inferred interest and demographic information, and ad data. Bookmarks appear on neither page. [V] [accessing your X data, snapshot 2026-09-08](https://web.archive.org/web/20260908005124/https://help.x.com/en/managing-your-account/accessing-your-x-data), [how to download your X archive, snapshot 2026-10-09](https://web.archive.org/web/20261009134910/https://help.x.com/en/managing-your-account/how-to-download-your-x-archive)
- An analysis of a real archive generated 2026-03-16 records: "There is no `bookmark` / `bookmarks` dataset in `data/manifest.js` or the `data/` file list." [FH] [tweetxvault archive analysis](https://github.com/lhl/tweetxvault/blob/main/docs/ANALYSIS-archive-import.md)
- Counter-signal: birdclaw's archive importer looks for `data/bookmark.js` or `bookmarks.js`. The only such file I found is a hand-written test fixture. [V] [slices.ts](https://github.com/steipete/birdclaw/blob/main/src/lib/archive/slices.ts), [test fixture](https://github.com/steipete/birdclaw/blob/main/src/lib/archive-import.test.ts)
- The archive "may take a few days" to prepare. [V] same help page

Conclusion: treat the archive as not containing bookmarks, and too slow for a weekly digest even if it did. [I]

### 1e. Other things worth knowing

- **Capture the bookmark action itself.** Scrollmark watches outgoing requests and classifies `CreateBookmark`, `DeleteBookmark` and bookmark-to-folder mutations. [V] [interaction-events/api.ts](https://github.com/kmccleary3301/scrollmark/blob/main/src/modules/interaction-events/api.ts). For bookmarks made in the desktop browser where the extension runs, this yields an exact local timestamp. It does nothing for bookmarks made in the mobile app. [I]
- **The bookmarks page is moving.** Two projects report the web route changing from `/i/bookmarks` to `/i/history` in August 2026 while the GraphQL operation kept the name `Bookmarks`. [FH] [TBD userscript comment](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js), [xarchive #3](https://github.com/sytelus/xarchive/issues/3). On 2026-09-14 `/i/bookmarks` still issued `Bookmarks`, while `DeleteBookmark` was sent with an `/i/history` referrer and likes had moved to `/i/history/likes`. [FH] [Cyd findings, sections 0, 4d, 8](https://github.com/lockdown-systems/cyd/blob/main/docs/x-capture/findings-20260914.md). X's bookmarks help page still described a "Bookmarks" tab on 2026-09-04. [V] [snapshot](https://web.archive.org/web/20260904174205/https://help.x.com/en/using-x/bookmarks). Match on the operation name, never the page URL. [I]
- **Bookmark folders are a paid feature**, listed under the Basic tier of Premium. [V] [X Premium help page, snapshot 2026-10-10](https://web.archive.org/web/20261010222207/https://help.x.com/en/using-x/x-premium)
- **Embedded-browser tools** apply the same passive idea outside an extension: Cyd runs x.com in Electron and parses responses captured by a proxy. [V] described in its own [findings](https://github.com/lockdown-systems/cyd/blob/main/docs/x-capture/findings-20260914.md)

---

## 2. Existing open source projects

Stars, last push, license and open counts were read from the GitHub API on 2026-10-12. GitHub's open count includes pull requests. "How it gets data" is from the source files cited in section 1 unless marked.

| Project | License | Last push | Stars / open | How it gets data | Notes |
|---|---|---|---|---|---|
| [prinsss/twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) | MIT | 2026-08-31 (v1.4.3) | 2,746 / 25 | Userscript, passive XHR hook | The reference implementation. IndexedDB, export to JSON/CSV/HTML. Stores full tweet objects and `sortIndex`. No bookmark folders ([#142](https://github.com/prinsss/twitter-web-exporter/issues/142) open), no X Articles ([#143](https://github.com/prinsss/twitter-web-exporter/issues/143) open), no way to push data to another app ([#118](https://github.com/prinsss/twitter-web-exporter/issues/118) open). Declines to ship automation ([#120](https://github.com/prinsss/twitter-web-exporter/issues/120)). |
| [kmccleary3301/scrollmark](https://github.com/kmccleary3301/scrollmark) | MIT | 2026-08-25 (v1.5.0) | 53 / 2 | Userscript, passive (TWE fork) | Adds bookmark folders, bookmark add/remove event capture, local search, a raw-capture module. |
| [0x1b2c/twitter-bookmarks-downloader](https://github.com/0x1b2c/twitter-bookmarks-downloader) ("TBD") | MIT | 2026-08-21 | 22 / 2 | Userscript XHR hook; raw response POSTed to a local Go daemon | Closest to the target architecture: `localhost:41008`, auto-scroll, 30-minute reload of an idle bookmarks tab, parsing in the backend. The SQLite store and media downloader are from its README; I read the userscript, not the Go code. |
| [sytelus/xarchive](https://github.com/sytelus/xarchive) | MIT | 2026-09-05 | 107 / 6 | MV3 extension, **active** GraphQL calls | Captures auth headers with `webRequest.onSendHeaders`, discovers query IDs, includes folders, paces requests. Open breakage report since 2026-08-20 ([#3](https://github.com/sytelus/xarchive/issues/3)). |
| [afar1/fieldtheory-cli](https://github.com/afar1/fieldtheory-cli) | MIT | 2026-09-05 | 2,043 / 46 | Node CLI, **active** GraphQL with browser cookies | Folders, X Article gap-fill, hardcoded query IDs. Its history with bookmark dates is the key evidence in section 3. |
| [lhl/tweetxvault](https://github.com/lhl/tweetxvault) | Apache-2.0 | 2026-07-20 (v0.2.5) | 50 / 4 | Python CLI, **active** GraphQL with browser cookies | Automatic query-ID discovery. Keeps raw response pages (per README). |
| [viperrcrypto/Siftly](https://github.com/viperrcrypto/Siftly) | MIT | 2026-04-08 | 3,068 / 29 | Bookmarklet or console script (patches fetch and XHR), then JSON file upload | Self-hosted library with AI categorization. Six months without a push. |
| [steipete/birdclaw](https://github.com/steipete/birdclaw) | MIT | 2026-10-12 | 1,666 / 1 | Archive import plus live sync through `xurl` (official API) or a private `bird` tool (per README) | Not a no-API ingester. Reference for a local SQLite store. |
| [LucasDitchun/export-bookmarks-x-twitter](https://github.com/LucasDitchun/export-bookmarks-x-twitter) | MIT | 2026-08-13 | 11 | MV3 extension, DOM scraping | Shows the DOM route end to end. |
| [lockdown-systems/cyd](https://github.com/lockdown-systems/cyd) | GPL-3.0 | 2026-10-11 | 242 | Electron app with a capturing proxy | Its dated findings file is the best recent first-hand record of X's web API behaviour. GPL: read, do not copy. |
| [twillot-app/twillot](https://github.com/twillot-app/twillot) | none | 2025-01-21, archived | 135 | MV3 extension, active calls | Dead. Its bookmark sync loop fetches page after page with no delay between them. [V] [handlers.ts](https://github.com/twillot-app/twillot/blob/main/x-bookmarks/src/options/handlers.ts) |

Not read beyond the repository description: [alexknowshtml/smaug](https://github.com/alexknowshtml/smaug), [hfknight/x-bookmarks-sync](https://github.com/hfknight/x-bookmarks-sync).

**Build on one, borrow, or write our own?** Write our own thin extension and borrow two patterns. [I]

1. TWE's interceptor registry (MIT): the XHR patch and per-operation matchers are about 150 lines.
2. TBD's split: the browser side ships raw response text and the local app parses. A parser fix then never requires reinstalling the extension, and stored raw payloads can be re-parsed after a fix.

Forking TWE or Scrollmark wholesale is not worth it. Both are in-browser apps built around IndexedDB and manual export, which is the part a local database replaces.

---

## 3. What data is obtainable

From the `Bookmarks` response, per the fields existing parsers read. [V] [TWE tweet types](https://github.com/prinsss/twitter-web-exporter/blob/main/src/types/tweet.ts), [TWE api utils](https://github.com/prinsss/twitter-web-exporter/blob/main/src/utils/api.ts), [fieldtheory `convertTweetToRecord`](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts)

| Item | Available | Where / caveat |
|---|---|---|
| Post id, text, created time, language | Yes | `rest_id`, `legacy.full_text`, `legacy.created_at`, `legacy.lang` |
| Full text of long posts | Yes | `note_tweet.note_tweet_results.result.text`. Without it, `legacy.full_text` is a roughly 275-character preview (fieldtheory source comment). |
| Media | Yes | `legacy.extended_entities.media`: image URLs, alt text, dimensions, and `video_info.variants` with mp4 URLs and bitrates |
| Quoted post | Yes | `quoted_status_result.result`, a nested tweet object with its own author and media |
| Link URLs | Yes | `legacy.entities.urls[].expanded_url` |
| Link cards | Present, unparsed | `card` is in TWE's tweet type as `unknown`; no parser I read uses it for bookmarks |
| Author | Yes | `core.user_results.result`: id, handle, name, avatar, verification. Parsers read both `core` and the older `legacy` location. |
| Engagement counts | Yes | likes, reposts, replies, quotes, bookmark count, views |
| Thread membership | Ids only | `conversation_id_str`, `in_reply_to_status_id_str`. fieldtheory's thread-expansion request is open. [V] [#59](https://github.com/afar1/fieldtheory-cli/issues/59). The rest of a thread loads through `TweetDetail` when the post is opened, which TWE captures as a separate module. [V] [tweet-detail module](https://github.com/prinsss/twitter-web-exporter/tree/main/src/modules/tweet-detail) |
| X Articles (long-form) | Preview only | fieldtheory fetches the body with a separate `TweetResultByRestId` call carrying article field toggles. Open requests in both trackers. [V] [fieldtheory source](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts), [TWE #143](https://github.com/prinsss/twitter-web-exporter/issues/143), [fieldtheory #143](https://github.com/afar1/fieldtheory-cli/issues/143) |
| Bookmark folders | Yes, separate calls | `BookmarkFoldersSlice` lists folders. `BookmarkFolderTimeline` (variable `bookmark_collection_id`) lists a folder's posts. Captured passively only when the user opens each folder. [V] [fieldtheory source](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts), [Scrollmark bookmarks/api.ts](https://github.com/kmccleary3301/scrollmark/blob/main/src/modules/bookmarks/api.ts) |
| Deleted or restricted posts | Partly | Arrive as `TweetTombstone`, `TweetUnavailable`, or an empty result, and TWE drops them. [V] [api utils](https://github.com/prinsss/twitter-web-exporter/blob/main/src/utils/api.ts). Keep the id and the last known copy locally. [I] |

### When was a bookmark added?

No parser I read finds an explicit bookmark timestamp in the response, and fieldtheory's maintainer states the timeline "does not expose a trustworthy bookmark timestamp". [V] that no parser reads one; [FH] the maintainer's statement, [PR #72](https://github.com/afar1/fieldtheory-cli/pull/72)

What exists is `sortIndex` on every timeline entry:

- It orders the timeline; larger means nearer the top. TWE sorts by it because, per its source comment, "Twitter's API may return array items in random order". [V] [TWE api utils](https://github.com/prinsss/twitter-web-exporter/blob/main/src/utils/api.ts)
- It follows bookmark order, not post date. [FH] [fieldtheory #65](https://github.com/afar1/fieldtheory-cli/issues/65)
- **It is not a standard Twitter snowflake.** fieldtheory decoded it as one and shipped that as `bookmarkedAt` on 2026-04-06. A user then showed a post published 2026-04-08 with a decoded bookmark date of 2024-11-27, and the decode was removed on 2026-04-10. `bookmarkedAt` is now always null for these records, and an issue asking why has been open since 2026-10-07. [V] [PR #28](https://github.com/afar1/fieldtheory-cli/pull/28), [issue #65](https://github.com/afar1/fieldtheory-cli/issues/65), [PR #72](https://github.com/afar1/fieldtheory-cli/pull/72), [current source](https://github.com/afar1/fieldtheory-cli/blob/main/src/graphql-bookmarks.ts), [issue #194](https://github.com/afar1/fieldtheory-cli/issues/194)

**A different decoding fits the reported data.** [I] Reading `sortIndex >> 20` as milliseconds since the Unix epoch:

| sortIndex | Where it comes from | Snowflake decode (known wrong) | `>> 20` as Unix ms |
|---|---|---|---|
| 1861899614026727424 (reconstructed by me from the wrong date quoted in the issue, accurate to about 4 ms) | [issue #65](https://github.com/afar1/fieldtheory-cli/issues/65) | 2024-11-27T22:27:15Z | 2026-04-08T10:57:21Z |
| 1861891119789912064 | [fieldtheory regression test](https://github.com/afar1/fieldtheory-cli/blob/main/tests/graphql-bookmarks.test.ts) | 2024-11-27T21:53:29Z | 2026-04-08T08:42:20Z |

For the first row the issue also gives the post time (2026-04-08T06:30:15Z) and the sync time (2026-04-08T13:19:23Z). The alternate decode lands between them, exactly where the true bookmark time must be. This is two values from one reporter: a strong hypothesis, not a verified fact. I found no project that uses this decoding. The test at the end of this note settles it.

**Recommendation for the weekly digest.** [I]

- Store per bookmark: raw `sortIndex` (string), `first_seen_at` (set once on insert, never overwritten), `last_seen_at`, and nullable `bookmarked_at_exact` and `bookmarked_at_est`.
- `bookmarked_at_exact`: from a captured `CreateBookmark` request, when the bookmark was made in the desktop browser.
- `bookmarked_at_est`: `sortIndex >> 20`, only after the test passes, and guarded by a sanity check (not before the post's `created_at`, not after `first_seen_at`).
- "Added this week" is the first non-null of exact, estimate, `first_seen_at`. With `first_seen_at` alone the digest is accurate to the sync cadence, so the bookmarks page must be opened at least weekly.
- Mark the initial backfill batch so the first digest does not contain the whole library.
- Do not copy TWE's storage behaviour here. It rewrites the capture timestamp on every re-capture (`bulkPut` with `Date.now()`), which destroys first-seen time. [V] [database/manager.ts](https://github.com/prinsss/twitter-web-exporter/blob/main/src/core/database/manager.ts)

---

## 4. Full backfill

- X's bookmarks help page states no limit on the number of bookmarks. [V] [snapshot 2026-09-04](https://web.archive.org/web/20260904174205/https://help.x.com/en/using-x/bookmarks)
- The web client fetched 20 bookmarks per page on 2026-09-14 (pages of 20, 20, 18), and the list ended with a response holding only cursor entries. [FH] [Cyd findings, section 4c](https://github.com/lockdown-systems/cyd/blob/main/docs/x-capture/findings-20260914.md)
- Active tools treat a missing or repeated bottom cursor, or several consecutive empty pages, as the end, and do not stop on a single empty page. [V] [xarchive fetcher.js](https://github.com/sytelus/xarchive/blob/main/lib/fetcher.js)
- Time for 3,000 bookmarks: 150 pages; at one scroll every 5 seconds (TBD's interval) about 13 minutes. [I] from [TBD userscript](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js)
- **Evidence at the "few thousand" scale, by scrolling:** a TWE user's bug report from 2026-03-07 gives the steps as "Export all bookmarks (4566 of them) by scrolling down". [FH] [TWE #124](https://github.com/prinsss/twitter-web-exporter/issues/124)
- By active requests: a fieldtheory user's log shows 2,142 bookmarks synced through the same internal endpoint. [FH] [fieldtheory #183](https://github.com/afar1/fieldtheory-cli/issues/183). TWE's maintainer answers a 100,000-bookmark question with "you need to scroll through the bookmarks page for a very long time", with no mention of a ceiling. [FH] [TWE #51](https://github.com/prinsss/twitter-web-exporter/issues/51)
- One user reports the opposite pressure: "Twitter slowly deletes bookmarks once you have too many". Unconfirmed, single report. [FH] [TWE #135](https://github.com/prinsss/twitter-web-exporter/issues/135)
- During long scrolls X can answer with responses that carry no usable timeline. TBD's author treats that as rate limiting and aborts after five consecutive failures. [FH] for the behaviour, [V] for the handling, [TBD userscript](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js)
- Auto-scroll is what turns passive capture into automation. TWE leaves scrolling to the user; TBD builds it in. [V] [TWE #120](https://github.com/prinsss/twitter-web-exporter/issues/120), [TBD userscript](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js). For a one-time backfill of a few thousand, scrolling by hand for a quarter of an hour is the conservative choice. [I]
- Incremental sync afterwards: new bookmarks arrive at the top, so a page load captures them. xarchive's quick update stops once a whole page holds only known ids; TBD stops when its backend reports enough duplicates. [V] [xarchive README](https://github.com/sytelus/xarchive#readme), [TBD userscript](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js)

No primary source documents a cap on how far back the web client will scroll. Whether one exists for this account is answered by the backfill itself.

---

## 5. Risks

### Terms of service

- X Terms of Service, effective 2026-10-09: "You may not access the Services in any way other than through the currently available, published interfaces that we provide. For example, this means that, except as required by applicable law, you cannot scrape the Services without X's express written permission". Also: "crawling or scraping the Services in any form, for any purpose without our prior written consent is expressly prohibited". The terms also bar working around technical limitations and reverse engineering. Liquidated damages start above 1,000,000 posts in 24 hours, far beyond this use. [V] [x.com/en/tos](https://x.com/en/tos)
- X automation rules, under "Don't": "Use non-API-based forms of automation, such as scripting the X website. The use of these techniques may result in the permanent suspension of your account." [V] [snapshot 2026-10-01](https://web.archive.org/web/20261001071835/https://help.x.com/en/rules-and-policies/x-automation)

How the techniques sit against that text. [I]

| Technique | Reading |
|---|---|
| Passive capture while the user browses | No extra requests and no automation. The user is using the published web interface and keeping a copy of what it showed them. Lowest exposure, still not explicitly permitted. |
| Passive capture plus auto-scroll | Scripting the website. Falls under the automation "Don't". |
| Direct GraphQL calls with session cookies | Access other than through published interfaces, plus automation. Clearest violation. |

This is a reading of the text, not legal advice.

### Account restrictions: what has been reported

- **Active, non-standard requests have led to suspensions.** On 2025-11-06, users of the OldTwitter extension reported suspensions in its tracker, several citing an "inauthentic behaviour" or "authenticity" reason. The developer's working theory in that thread: "the bans in OldTwitter were caused by retweeting since its the only function that used X Pro key". A day later the developer wrote that the latest version "should be safe". [FH] [OldTwitter #1153](https://github.com/dimdenGD/OldTwitter/issues/1153)
- **Passive interception.** I found no report of a lock or suspension attributed to passive capture. Searching TWE's tracker for "suspended", "locked" and "ban" returned only parser bugs about suspended authors and the automation thread. [V] that the search found nothing; absence of reports is not proof of safety.
- TWE's maintainer keeps automation out of the tool, in their words to "minimize the risk of ToS violation and possible account ban". [FH] [TWE #120](https://github.com/prinsss/twitter-web-exporter/issues/120)
- A MAIN-world patch is visible to the page in principle (Chrome's own warning, section 1a). I found no evidence that X checks for it. [I]

### How often the internal API changes

- Bookmark-path breakages reported to TWE during 2026, all parser-level and all closed: January ([#114](https://github.com/prinsss/twitter-web-exporter/issues/114), author fields moved), March ([#124](https://github.com/prinsss/twitter-web-exporter/issues/124)), May ([#135](https://github.com/prinsss/twitter-web-exporter/issues/135), deleted posts). For the March and May reports the maintainer posted a fixed beta build the same or the next day. Other surfaces needed "adapt to API changes" releases on 2026-07-29, 2026-08-19 and 2026-08-31. [V] [CHANGELOG](https://github.com/prinsss/twitter-web-exporter/blob/main/CHANGELOG.md)
- X renamed and split whole operations in 2026 (`UserTweetsAndReplies` no longer exists; `UserOriginalsTimeline` and `UserRepliesTimeline` replace it) and removed the user `legacy` object from timeline responses. `Bookmarks` kept its name. [FH] [Cyd findings, sections 0 and 4b](https://github.com/lockdown-systems/cyd/blob/main/docs/x-capture/findings-20260914.md)
- Expect a handful of small fixes a year on the passive path, and budget for one rename of the bookmarks operation given the route change in 1e. [I]
- The failure is silent: no match means no capture. TBD logs every GraphQL operation name it saw and ignored, so a rename shows up in the console. [V] [TBD userscript](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js). Do the same, and alert when the bookmarks page loads but nothing is captured. [I]

---

## 6. Handing data from the extension to the local app

A constraint first: the page itself cannot POST to localhost. x.com's Content-Security-Policy `connect-src` lists X and partner hosts; its only "localhost" entry is `wss://localhost.x.com:*`, and there is no `http://localhost` or `127.0.0.1`. [V] response header of `https://x.com/`, fetched 2026-10-12. So the MAIN-world script must hand data to extension code, and extension code does the sending. [I]

| Option | How | For | Against |
|---|---|---|---|
| POST to a localhost server | Service worker `fetch("http://127.0.0.1:PORT/ingest")` with a host permission for that origin. [I] TBD does the userscript equivalent with `GM_xmlhttpRequest`. [V] [TBD userscript](https://github.com/0x1b2c/twitter-bookmarks-downloader/blob/main/sync-bookmarks.user.js) | Simplest to build and debug. One endpoint serves any browser. The app can answer "already have these", so the extension knows when to stop. | The app must be running, so the extension needs a local queue and retry. An open local port needs a shared token and a bind to 127.0.0.1. Chrome 142 launched a Local Network Access permission prompt for sites reaching loopback; the announcement does not mention extensions. [V] [Chrome blog](https://developer.chrome.com/blog/local-network-access) |
| Native messaging | The extension declares `nativeMessaging`; Chrome starts a host process and talks over stdin/stdout. On macOS the host manifest goes in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` and must list the exact extension id in `allowed_origins` (no wildcards). Messages to the host may be up to 64 MiB; from the host, 1 MB. [V] [Chrome: native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) | No port and no token. Chrome starts the host on demand, so nothing has to be running. | Per-browser install step for the manifest, a pinned extension id, length-prefixed stdio framing, harder to debug. [I] |
| File export and import | The extension downloads JSON; the app imports it. TWE, xarchive and Siftly work this way. [V] [TWE README](https://github.com/prinsss/twitter-web-exporter#usage), [xarchive README](https://github.com/sytelus/xarchive#readme), [Siftly import page](https://github.com/viperrcrypto/Siftly/blob/main/app/import/page.tsx) | Zero coupling, works with existing tools today, easy to inspect. | Manual. A weekly digest then depends on the user remembering to export. [I] |

Recommendation: localhost POST of raw response bodies with a token, plus an in-extension queue for when the app is down. Keep "export the queue to a file" as the fallback. Move to native messaging only if the open port becomes a concern. [I]

---

## Not verified

- **No live test.** Current response shapes, the 20-per-page figure, and whether this user's bookmarks live at `/i/bookmarks` or `/i/history` come from others' August and September 2026 observations. *Resolved in part by the first capture, 2026-10-12: the operation is `Bookmarks`, a page holds 20 posts, and the list ended with pages holding the two cursors alone. What the responses look like, field by field, and where that differs from section 3, is recorded in [packages/core/src/parsers/README.md](../../packages/core/src/parsers/README.md). The page's route is not in a capture, so that question is still open.*
- **`sortIndex >> 20` as bookmark time.** Fits two reported values. Untested on first-hand data, on folder timelines, and on very old bookmarks. *Tested 2026-10-12 on the 1,446 bookmarks of the first capture, and it held on every one. Each decoded time falls after its post's (smallest gap 10 seconds) and before the capture's (the latest 44 minutes before it). The values are strictly descending down all 76 pages. They span three years and 149 distinct weeks; first-seen is one day for all of them. They are not the post's time in disguise: in 421 of 1,445 neighbouring pairs the lower entry is the newer post. Read as a snowflake id instead, 1,199 of the 1,446 land before their post. It is stored as `estimated_bookmarked_at`, null unless it lies between the post's time and the capture's. Still untested: against a wall clock (the one bookmark made during the capture was removed three seconds later and never appeared in a page), on folder timelines, and whether re-bookmarking a post gives it a new value.*
- **How far back scrolling goes.** No primary source documents a cap, and one user reports scrolling through 4,566. A vendor blog claims the web client stops showing posts after roughly 800 to 1,000; I did not use it. *On 2026-10-12 this account scrolled to the end of its list, 1,450 entries, without meeting a cap. That says nothing about larger libraries.*
- **Whether re-bookmarking a post moves it to the top with a new `sortIndex`.** Not found anywhere.
- **Archive contents.** Concluded from X's help text and one third-party archive analysis. I did not open a real archive.
- **Chrome's Local Network Access rules for extension service workers.** Neither the announcement nor the explainer repository page I could read addresses extensions. *Resolved 2026-10-12 while building the extension: extensions with the host permission are exempt, per Chrome's own guide and an end-to-end test on Chromium 156. See "Chrome's Local Network Access" in [packages/extension/README.md](../../packages/extension/README.md).*
- **Whether `chrome.debugger` shows a warning banner while attached.** I believe it does; the API reference does not say.
- **Query-ID rotation cadence.** I verified that many IDs exist for one operation. Figures such as "every 2 to 4 weeks" appear only in other people's research notes.
- **Account freezes among Twillot users.** Asserted in another project's research notes. I verified that Twillot's loop has no delay, and found no first-hand report of a freeze in its tracker.
- **The History hub's launch date and rollout.** I met these only in news coverage; the announcement itself is an X post I could not fetch.
- **TBD's Go backend, smaug, and x-bookmarks-sync internals** were not read. An extension called Totem surfaced in search as open source; I could not find its repository.

## A short test that settles most of this

Fifteen minutes with the user's own account and browser DevTools, no code needed:

1. Open the bookmarks page with the Network tab filtered to `graphql`. Note the page URL and confirm a request named `Bookmarks` appears. This settles the route and the operation name.
2. Bookmark any post, note the wall-clock time, reload. Take the top entry's `sortIndex` and compute `sortIndex >> 20` as Unix milliseconds. If it matches the clock, the digest has a real timestamp.
3. Remove and re-add an old bookmark and reload. See whether it moves to the top with a new `sortIndex`.
4. Scroll to the very bottom. Count the entries and compare the oldest with the oldest bookmark the user remembers. This settles the backfill depth.
5. If the account has Premium, open one folder and confirm `BookmarkFolderTimeline` appears with the same entry shape.
