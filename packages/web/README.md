# x-bookmarks web app

The local app: a Next.js server on <http://127.0.0.1:47130>. It receives raw captures from [the extension](../extension/README.md), stores them through `@x-bookmarks/core`, and parses each one into bookmarks as it arrives. It also has a status page (`/`) and a page of pairing instructions (`/pair`). The library UI is a later phase.

```
pnpm app                                # from the repo root: build, then serve
pnpm pair                               # print the pairing token, creating it on first use
pnpm reparse                            # parse every stored capture again, and list what was not understood
pnpm --filter @x-bookmarks/web dev      # development server, same address
```

The database is `data/bookmarks.db` at the repo root and the pairing token is `data/ingest-token`. Set `X_BOOKMARKS_DATA_DIR` to keep them elsewhere. To unpair the extension, delete `ingest-token`, restart the app, and pair again.

## From capture to bookmark

A delivery is two steps, in `src/server/ingest.ts`. First the capture is stored, exactly as it arrived; the answer to the extension depends on that alone. Then every stored capture that has not been parsed is parsed, oldest first, which is the new one and any left behind by an earlier failure or by an older version of the app. A response the parser does not understand is recorded as such beside its capture; nothing is thrown at the extension, and nothing is lost. If the parsing step itself breaks, the error is logged, the capture stays, and the next delivery or `pnpm reparse` picks it up.

The status page shows the totals:

| Line | Meaning |
|---|---|
| Bookmarks | Posts in the library. |
| Captures parsed | Responses that were understood. One may still hold entries that failed. |
| Captures failed | Responses that were not understood at all. Nothing was taken from them. |
| Entries failed | Single bookmarks, inside understood responses, that were not understood and are not in the library. |
| Parts left empty | Parts of stored bookmarks that were not understood, such as a new kind of link card. The bookmark is in the library without that part. |
| Posts X withholds | Bookmarks whose post X no longer sends: deleted, or from a suspended or protected account. Not a parser problem. |
| Captures with no parser yet | Responses of an operation nothing parses yet, such as adding or removing a bookmark. Not a failure. |
| Captures waiting for a re-parse | Stored and never parsed, or parsed by an older parser. `pnpm reparse` clears them. |
| Last parsed | When a parse result was last recorded. |

**Anything above zero in "Captures failed" or "Entries failed" means X has changed a response**, or sent a kind the parser has not met. This is the failure this route is prone to. Run `pnpm reparse`: it prints each kind of mismatch once, with the path into the response where understanding stopped and what was expected there, and never a bookmark's content. Then follow "When X changes a shape" in [the parsers' README](../core/src/parsers/README.md). `pnpm reparse` can run while the app is running, and a second run changes nothing.

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
- **`AGENTS.md`** in this directory is written by `next dev`. It points at the Next documentation shipped in `node_modules/next/dist/docs/`, which is the reference for this version.

## shadcn/ui

Set up with `shadcn init --preset nova` on the Base UI primitives (`components.json`), Tailwind v4, and one component, `card`, so that the pipeline is known to work. No visual design has been done; the preset is the CLI's default and the design phase is free to replace it with `shadcn apply`.

- Add components from this directory: `pnpm dlx shadcn@latest add <name>`, then `pnpm lint:fix` from the root, because the generated files are not in the repo's formatting.
- One departure from the generated setup: the layout does not load the Geist font from Google at build time. `--font-sans` in `src/app/globals.css` is the system typeface, so building the app needs no network. Choosing a typeface belongs to the design phase.
- The repo's strict TypeScript settings (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) apply to generated components. `card` passes; if a later component does not, fix the component.
