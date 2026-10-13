# Curio capture extension

A Chrome extension (Manifest V3, loaded unpacked) that keeps a copy of the bookmark responses X's own web client receives while you browse, and hands them to the Curio app on this computer. It sends nothing to X. Why it is built this way: [docs/research/no-api-extraction.md](../../docs/research/no-api-extraction.md).

## First capture

Run commands from the repo root.

1. Install and build, once: `pnpm install`, then `pnpm extension:build`.
2. Start the app and leave it running: `pnpm app`. It serves <http://127.0.0.1:47130>.
3. Load the extension. In Chrome open `chrome://extensions`, switch on **Developer mode**, press **Load unpacked** and choose `packages/extension/dist`. Chrome lists it as "Curio capture" with the id `imbpimaegfnjdhdcfefapkaejieaahjh`. Pin its icon, a small blue cabinet, to the toolbar.
4. Pair. In a second terminal, in the repo, run `pnpm pair` and copy the token it prints. Click the extension's icon: the popup reads "Not paired yet" and lists these same steps. Paste the token and press **Pair**. The popup then reads "Paired. Nothing captured yet". The token is shown only in the terminal; the app serves it on no page.
5. Reload any x.com tab that was already open. The extension starts with the page, so a tab opened before it was loaded captures nothing.
6. Backfill. Open your bookmarks on x.com and scroll to the bottom by hand, at the pace you would read. X loads 20 bookmarks per step. The popup reads "Capturing" while you do, and "Captured" in it goes up by one each time; 3,000 bookmarks is about 150 steps and a quarter of an hour. If you use bookmark folders, open each folder and scroll it too.
7. Check. <http://127.0.0.1:47130> shows how many captures are stored, which should match "Delivered" in the popup, and how many bookmarks were parsed from them. "Captures failed" and "Entries failed" should read 0; [the app's README](../web/README.md#from-capture-to-bookmark) says what to do when they do not.

Afterwards, opening the bookmarks page now and then keeps the library current: new bookmarks are at the top, so one page load picks them up. Bookmarks you add or remove in this browser are captured as you make them, from any X page.

The app stores each response as it arrived and parses it into bookmarks at once. The stored responses are kept, so that the bookmarks can be rebuilt from them when X changes a response and the parser has to catch up.

### Reading the popup

The popup is always in one state. Its title names the state, the sentence under it says what to do next, and where there is something to press there is one button for it.

| The popup reads | What it means | What to do |
|---|---|---|
| Not paired yet | No token is saved. Captures taken meanwhile are kept in the extension. | Follow the three steps it lists: `pnpm app`, `pnpm pair`, paste the token, **Pair**. |
| Pairing… | The app is being asked to prove it holds the token you pasted. | Wait: a few moments, fifteen seconds at most. |
| Waiting for the app | A token is saved and nothing answered at the app's address. | Start the app, then press **Check again**. |
| The app did not accept this token | Something answered on the app's port without proving it holds the token: a stale token, or another program on the port. Nothing was sent to it. | Run `pnpm pair`, paste the token it prints and press **Pair**; or **Check again** once the other program is gone. |
| Paired. Nothing captured yet | The app has proved itself, and no bookmark response has been seen. | Open your bookmarks on X and scroll. Reload X tabs that were open before the extension was. |
| Capturing | A response was captured in the last few seconds. | Keep scrolling. |
| Up to date | Everything captured is in the app. | Nothing. **Open library** in the corner opens the app. |
| Sending… | Captures are on their way to the app. | Nothing. |
| *n* captures waiting for the app | The app is not running. The captures are kept in the extension and retried every minute. | Start the app. **Send now** sends them at once. |
| *n* captures not delivered | The app answered, but did not confirm that it stored a capture. They are kept and retried every minute. | Read "Last problem" below the counts, which has the app's answer. **Try again** when it is fixed. |
| The app refused *n* captures | The app would not accept them. They stay in the extension, and the rest are not held up. | Update the app and start it again, then **Send again**. |
| A response was not captured | X's page received a bookmark response that could not be kept, most often because X answered with an error. | Read "Last problem". For HTTP 429, stop scrolling for a while. |
| The extension is not answering | The popup got no status from the extension's own service worker. | Close and open the popup; if it stays, reload the extension on `chrome://extensions`. |

Under the state, once anything has been captured:

| Count | Meaning |
|---|---|
| Captured | Responses taken from X pages since the extension was installed. |
| Delivered | Captures the app has confirmed it stored. |
| Waiting | Captures held in the extension until the app takes them. |
| Refused | Captures the app would not accept. Shown only when there are any. |

"Last problem" is the service worker's own record of the most recent thing that went wrong, with its time. It is shown where it says more than the state does: an HTTP status, or which operation was not captured. It stays, under a later state, until a newer problem replaces it.

"Pair with another token" unfolds the token field again once a token is saved, for when the app's token has changed.

### When something is off

- **"Captured" does not move while you scroll your bookmarks.** Either the tab was open before the extension was loaded or reloaded (reload the tab), or X has renamed the request. This is the failure this route is prone to, and it is silent. Open DevTools on the bookmarks page, filter the Network tab by `graphql`, scroll, and note the name at the end of the request URLs. Then add it to `CAPTURED_OPERATIONS` in `src/operations.ts`, rebuild, and reload the extension.
- **"A response was not captured", with "X answered HTTP 429" under it**: X is rate limiting the page. Stop scrolling for a while.
- **"*n* captures waiting for the app"**, or **"Waiting for the app"**: the app is not running. Nothing is lost; start it.
- **"The app did not accept this token"**: the extension's token is not the app's current one, or some other program is using port 47130. Run `pnpm pair` and pair again. Nothing was sent, and nothing is lost.
- **After changing the extension's code**: `pnpm extension:build`, press the reload arrow on `chrome://extensions`, then reload your x.com tabs.

### What the popup is, and is not

The popup asks the extension's service worker for its status once a second and draws it. It asks you for one thing, the pairing token, in a field that does not show it and that is emptied once the app has accepted it. Its three buttons send the worker one message each: pair with this token, check the saved token against the app again, deliver what is waiting. It reaches nothing else: no page of X, not the app, no other host. Its one link, **Open library**, is an ordinary link to the app's address for you to follow.

Everything it shows ships inside the extension: one page, one stylesheet, one script, and its icons drawn in the page. It loads no font, image, stylesheet or script from anywhere, and `src/popup.test.ts` fails if it starts to.

It follows the browser's light or dark setting, which is all an extension page can ask about; it cannot see the theme you chose in the app. Every control is reached with Tab, in the order it is read. The field takes the keyboard when the popup opens unpaired, and Enter in it pairs. What moves is a spinner while the app is being asked, a ring around a dot while captures arrive, and a button under the pointer; with "reduce motion" set in the system, nothing moves at all and each state still says what it is in words and by its icon.

## What it does on X pages

The extension runs on every page of `https://x.com`, not only the bookmarks page. It has to: X is a single-page app, so moving from the home timeline to your bookmarks loads no new page, and a script can be attached only when a page loads. A hook added later would miss the first bookmarks request. Bookmarking a post also happens on any page.

On every `https://x.com/*` page, in the top frame, before X's scripts start:

- In the page's own JavaScript world it replaces three functions with wrappers: `XMLHttpRequest.prototype.open`, `XMLHttpRequest.prototype.send` and `window.fetch`. Each wrapper calls the browser's original with the page's arguments and returns its result.
- For each request it reads the URL. If the URL is not one of the five operations below, that is all it does: the response is never read.
- For those five it reads the response text (from a copy, for `fetch`) and the request body, and passes them to the extension with a DOM event named `x-bookmarks:hook`.
- In the extension's isolated world it listens for that event and forwards it to the extension's service worker.

It reads nothing else: no page content, cookies, tokens or other responses. It starts no request, changes no request or response, and never scrolls, clicks or navigates. Its service worker has no permission for x.com and cannot read X at all.

### What X's page could notice

The extension does not hide. Nothing in it exists only to conceal it: no stack traces are rewritten and no function pretends to be the browser's. What it does aim for is to behave as the browser's own functions do, so that X's code runs the same. The end-to-end test makes 58 kinds of request (XHR and fetch, every `responseType`, every kind of body, `Request` objects, aborts, timeouts, rate limits, dropped connections, misuse that must throw) in a browser with the extension and in one without, and requires that X receive the same requests with the same headers in the same order and the same bodies, and that the page observe the same statuses, headers, bodies, events, errors and unhandled rejections. A page that has wrapped its own `addEventListener` and `dispatchEvent`, as error-reporting scripts do, sees the same calls in both: the hook uses the browser's own copies of those functions, taken before any page script runs, so that it neither depends on a page's wrapper nor runs inside one.

The wrappers match the browser's functions in name, `length`, own properties (they have no `prototype` and cannot be constructed), property flags, the `this` and arguments they pass on, and what they return.

What still differs, and is observable by a script in the page that looks for it:

- **Source text.** `XMLHttpRequest.prototype.open.toString()`, and the same for `send` and `fetch`, returns the wrapper's source instead of `function open() { [native code] }`.
- **Stack traces.** An error thrown through a wrapper, such as calling `send()` before `open()`, carries a stack frame at `chrome-extension://imbpimaegfnjdhdcfefapkaejieaahjh/page-hook.js`. That names the extension.
- **The event.** After each allowlisted response, an event named `x-bookmarks:hook` fires on `window` with the response in it. Any script that listens for that name receives it.
- **Allowlisted `fetch` calls only.** The page receives a promise that follows the browser's, with the same response or the same rejection, one microtask later. The response body is read through a copy, which changes how it is buffered and nothing the page can read from the response.
- **Allowlisted XHR calls only.** One more `load` listener is attached, so the hook's reading of the response runs ahead of any `load` listener the page adds after `open()`.
- **Comparison with an untouched frame.** The extension runs in the top frame only, so the functions inside an `<iframe>` are the browser's own and differ from the top frame's.

The research note found no sign that X checks for any of this, and no report of account action for extensions that only read.

### What a script in the page can do to the extension

Any script running in an x.com page, X's own or another extension's, can fire the `x-bookmarks:hook` event itself. What that achieves is limited by what the rest of the extension accepts:

- It can plant a capture: a made-up response for one of the five operations, which will be stored and later parsed as if X had sent it. It can do this repeatedly and fill the queue.
- It cannot date it. The service worker dates every capture by its own clock when the capture arrives and ignores any time it is handed, so a planted capture is dated now. First-seen cannot be moved into the past or the future.
- It cannot plant anything for another operation, read anything from the extension, or change or remove a capture already taken.

The five operations, defined once in `src/operations.ts`:

| Operation | What it is |
|---|---|
| `Bookmarks` | A page of the bookmarks timeline. |
| `BookmarkFolderTimeline` | A page of one folder's bookmarks. |
| `BookmarkFoldersSlice` | The list of folders. |
| `CreateBookmark` | You bookmarked a post in this browser. Gives the exact time. |
| `DeleteBookmark` | You removed a bookmark in this browser. |

Only responses with a 2xx status are kept. Anything else from these five shows in the popup as "A response was not captured", with X's status under "Last problem", and is not stored.

On `chrome://extensions`, Chrome describes this access as reading and changing your data on x.com. That is its wording for any extension script that runs in a page.

## How captures reach the app

The service worker dates each capture, gives it a random id, stores it in the extension's own storage, and delivers it to `http://127.0.0.1:47130/api/ingest`.

The pairing token is never sent. The extension signs each request with it (HMAC-SHA-256), and the app signs each answer, tied to that request. Before a delivery sends any capture it asks the app to prove itself this way. So when the app is closed and some other program is listening on its port, that program receives one signed greeting, no capture and no secret, and its answers are not believed.

A capture is removed from the extension only when an answer with the app's proof says that this very capture is stored. If the answer is lost, the capture is sent again under the same id and the app stores it once. Captures therefore survive the app being closed, Chrome being restarted, and the service worker being stopped: an alarm, set the moment a capture is queued, starts the worker again each minute while anything is waiting.

How the app decides whom to accept is in [the web app's README](../web/README.md#who-may-write-to-the-app).

### Chrome's Local Network Access

Since Chrome 142 a public website needs the user's permission to reach localhost. This does not apply to the extension:

- Chrome's guide for the feature ([Adapting your website for new Local Network Access restrictions in Chrome](https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/edit), last updated 2026-05-18) says: "We do not currently have plans to apply LNA restrictions to extensions. Currently, extensions that have the necessary host permissions are allowed to make local network requests." The Chrome team said the same on the [chromium-extensions list](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/pUDh8RiTjJk) in November 2025, where a bug that broke this for some extensions was reported fixed in Chrome 144.
- The end-to-end test confirms it on Chromium 156: with the fake X marked as a public address, the page's own request to the app is blocked with the permission in its "prompt" state, while the extension delivers with no permission granted.

The design follows from it. Only the service worker talks to the app, because a content script's request counts as x.com's. The manifest holds a host permission for exactly `http://127.0.0.1:47130/*`. The address is the literal `127.0.0.1`, never a name that has to be resolved.

The guide says "currently". If Chrome ever applies the check to extensions, the popup will read "captures waiting for the app" while the app is running, and captures will wait in the extension rather than be lost.

## Working on it

```
pnpm extension:build   # src/*.ts -> dist/, with esbuild
pnpm test packages/extension
pnpm e2e               # the built extension in a real Chromium, against a fake X (about 90 seconds)
pnpm icons:build       # icons/icon.svg -> the PNGs beside it, and the web app's icon
```

`pnpm extension:build` empties `dist/` before it writes, so Chrome must reload the extension afterwards and should not be capturing meanwhile. `pnpm e2e` does not touch `dist/`: it builds the extension into a temporary directory (`node build.ts <directory>`) and can run while the real extension and app are in use.

- `src/operations.ts`: the allowlist. `src/hook.ts`: the wrappers, written against an injected `window` so they are tested without a browser. `src/page-hook.ts` and `src/relay.ts`: the two content scripts. `src/queue.ts`: the queue and delivery, written against injected storage and `fetch`. `src/auth.ts`: the signing both ends use. `src/background.ts`: the service worker that wires them to Chrome. `src/protocol.ts`: what the app imports.
- The popup is three files and a function. `src/popup-view.ts` is the function: `viewOf` turns the status the service worker reports into the state the popup is in, its words and its one action, and is tested state by state without a browser. `src/popup.ts` draws what it returns and decides nothing. `src/popup.html` and `src/popup.css` are the page; the colours are the app's, copied from `packages/web/src/app/globals.css`, because an extension page cannot load the app's stylesheet. A new state is a case in `viewOf` with a test, a row in the table above, and, if it needs one, an icon in the page. The service worker says what an error is about with `Status.lastError.trouble` (`src/channel.ts`), so that the popup never reads an error's prose to decide what to show.
- `icons/icon.svg` is the mark, and the source of every copy of it: a cabinet of curiosities with something bright kept in one compartment, drawn on a 16 by 16 grid with every edge on a whole unit so that the 16-pixel toolbar icon is sharp. Chrome's manifest takes PNG, so `pnpm icons:build` renders the sizes the manifest names (16, 32, 48, 128) and copies the SVG to the web app as its icon, `packages/web/src/app/icon.svg`, so that the tab and the toolbar match. The rasteriser is the end-to-end test's own Chromium, started offline with scripts off and handed the SVG as text (`packages/e2e/src/render-icons.ts`): the browser that will draw the icon is the one that renders it, and nothing new is installed. The PNGs are committed, so building the extension needs no browser, and `src/icons.test.ts` fails when they were not rendered from the SVG as it stands. The mark is drawn twice more as shapes in a page, in the popup's bar and beside the app's name; a test holds each copy to the SVG.
- `packages/e2e/src/shapes-page.js` is the list of request shapes the with-and-without comparison runs. A change to the hook that alters any request, or anything the page observes, fails it; a new observable difference has to be either removed or written into "What X's page could notice" above and into the test's `known` block.
- `manifest.json` carries a `key`. It is a public key whose only job is to fix the extension's id, so that the app can accept that one origin wherever the extension is loaded from. Its private half was discarded. The extension is not prepared for the Chrome Web Store.
- esbuild's install script is switched off in `pnpm-workspace.yaml`. It only verifies the binary that esbuild's platform package already supplies.
- The rules a change here is reviewed against are CAP-1 to CAP-11 in [CODING_STANDARDS.md](../../CODING_STANDARDS.md).
