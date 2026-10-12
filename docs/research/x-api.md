# Official X API for a personal bookmarks library

Researched 2026-10-12. Scope: the official X API only. The no-API (browser extension) route is covered in a separate note.

Question: can one person sync, classify, search and get a weekly digest of their own X bookmarks through the official API, and what does it cost? Working numbers: 2,000 existing bookmarks, about 50 new ones a week.

## How this was sourced

Claims are traced to the source that owns them:

- **X's documentation**, read as raw Markdown from docs.x.com.
- **X's OpenAPI spec**, version 2.170, downloaded from https://api.x.com/2/openapi.json on 2026-10-12.
- **The Developer Agreement and Developer Policy** on docs.x.com.
- **Posts by X staff** on the official developer forum, devcommunity.x.com. Staff posts are named as such.

Two other kinds of statement appear, and each is labelled where it occurs:

- **First-hand report**: a developer describing the responses their own requests got. No X confirmation unless stated.
- **Inference**: my own arithmetic or reading.

Third-party pricing guides and blog round-ups are not used.

No live API calls were made. Anything only a real request can show is listed under "Not verified".

## Bottom line

**Viable for keeping up with new bookmarks. Not viable for backfilling the existing 2,000.**

- **Monthly cost: about $0.25 to $0.50 for posts alone, about $1 to $3 with author names.** Your own bookmarks cost $0.001 per post. Each author object pulled in through an expansion is a separate $0.010 read. A careless design (daily polling with author expansion on every call) could reach about $30 a month. (Inference from X's published rates and a staff statement on expansions.)
- **Backfill cost: under $10 for what the API will actually return.** A one-time $20 credit for adding a first card would cover it.
- **Hard limit 1, history depth.** X's launch announcement set the ceiling at "up to 800 of your most recent" bookmarks, and no current page restates or lifts it. In August 2026 a developer got only 199 before pagination stopped; X staff could not say whether that is a bug or a window. Expect to reach somewhere between 199 and 800 of the 2,000.
- **Hard limit 2, no bookmark date.** The response has no "bookmarked at" field, only the post's creation date. A weekly digest must rely on the sync job recording when it first saw each post.
- **Hard limit 3, folders.** Folder names are available. Folder contents come back as post IDs only, and developers report a cap of 20 IDs per folder with pagination rejected.
- **Access is easy, but paid.** Signup is self-serve at console.x.com. There is no free plan; X staff confirmed the Free, Basic and Pro plans are deprecated.
- **Terms.** Local storage is allowed if posts later deleted or protected on X are removed. Training or fine-tuning a foundation model on the content is prohibited. LLM classification is not mentioned.

Recommendation: the API can serve ongoing sync cheaply, but the existing library has to come from somewhere else. Before committing, run the short test at the end of this note.

## 1. Access tiers and pricing

### Plans

| Claim | Source |
| :- | :- |
| The X API uses pay-per-usage pricing: "No subscriptions—pay only for what you use." Credits are bought upfront in the Developer Console and deducted per request. | https://docs.x.com/x-api/getting-started/pricing |
| "No contracts, subscriptions, or minimum spend." Months with zero usage cost nothing. | https://docs.x.com/x-api/getting-started/pricing , https://docs.x.com/x-api/fundamentals/post-cap |
| Pay-per-use launched on 2026-02-06 together with the new console at console.x.com. Only "Public Utility Apps" keep free access. Recently active Legacy Free users got a one-time $10 voucher. | X staff, https://devcommunity.x.com/t/announcing-the-launch-of-x-api-pay-per-use-pricing/256476 |
| "Legacy packages like Free, Basic, and Pro have been deprecated." (2026-02-13, answering "How do I get a free plan to test?") | X staff, https://devcommunity.x.com/t/no-free-plan/257026 |
| Legacy Basic subscribers are migrated to pay-per-use automatically after 2026-06-01. | X staff, https://devcommunity.x.com/t/important-update-legacy-x-api-basic-plans-are-moving-to-pay-per-use-ppu/266305 |
| Legacy Pro subscribers are migrated automatically after 2026-09-01. | X staff, https://devcommunity.x.com/t/important-update-legacy-x-api-pro-plans-are-moving-to-pay-per-use-ppu/273255 |
| The Developer Agreement (last updated 2026-04-27) still names "Pay-Per-Use, Basic, and Pro plans" and describes them as "designed for hobbyists, commercial prototyping, initial development". | https://docs.x.com/developer-terms/agreement (section III.L) |

So pay-per-use is the only plan a new individual developer can get. (Inference from the rows above.)

### Rates

| Claim | Source |
| :- | :- |
| Owned Reads, "requests made by your own developer app for your own data", cost $0.001 per resource. `GET /2/users/{id}/bookmarks` qualifies. | https://docs.x.com/x-api/getting-started/pricing#owned-reads |
| The condition: `{id}` matches the authenticated user "and that user is the owner of the developer app". | https://docs.x.com/x-api/getting-started/pricing#owned-reads |
| Owned Reads pricing started on 2026-04-20. | X staff, https://devcommunity.x.com/t/x-api-pricing-update-owned-reads-now-0-001-other-changes-effective-april-20-2026/263025 |
| Standard reads: Posts $0.005, Users $0.010, "charged per resource returned in the response". | https://docs.x.com/x-api/getting-started/pricing |
| Expanded objects are billed too. "`expansions=author_id` ... returns the user in `includes.users`. That user is a User: Read on top of the post." "Expanded objects in includes count. Don't request expansions you won't use." (2026-08-31) | X staff, https://devcommunity.x.com/t/billing-of-requests-that-involve-expansions/274753 |
| Requesting the `author_id` field alone "only adds the author ID on the post object. That's still one Post: Read." | X staff, same thread |
| The same author across many posts in one response "usually appears once (one User Read for that response)". Looking up posts by ID with `GET /2/tweets` is billed at the standard $0.005, not the owned rate. (2026-09-07) | X staff, https://devcommunity.x.com/t/do-tweet-expansions-add-user-read-charges-on-top-of-post-read-when-looking-up-my-own-posts-by-id/275286 |
| Deduplication: a resource is charged once per 24-hour UTC day, as a "soft guarantee". The next day it is charged again. | https://docs.x.com/x-api/getting-started/pricing#deduplication |
| "Only successful responses that return data are billed." | https://docs.x.com/x-api/fundamentals/post-cap |
| A spending limit per billing cycle can be set; requests are blocked once it is reached. | https://docs.x.com/x-api/getting-started/pricing#spending-limits |
| Free credits: a one-time $20 for saving a first eligible credit or debit card (prepaid cards do not qualify) and a match of the first auto-recharge up to $50. They expire after 3 months. The rollout began 2026-10-02 and is not yet enabled for every account. | https://docs.x.com/x-api/getting-started/free-credits |
| The minimum auto-recharge is $5. | https://docs.x.com/x-api/getting-started/free-credits |

The rate card has no line for media objects. (Observation from the pricing page; whether expanded media is billed is not stated.)

### Cost for this use case

Everything in this subsection is inference from the rates above. Two assumptions are untested: that authors expanded on the bookmarks endpoint cost $0.010 like any other user read, and that quoted posts in `includes` cost $0.005.

The endpoint has no "since" parameter, so every poll returns a page and every post on it is billed again on a new UTC day.

Ongoing, at about 217 new bookmarks a month:

| Design | Billed per month | Cost per month |
| :- | :- | :- |
| Posts only, weekly poll, stop at the first known post | 217 to 433 posts | $0.22 to $0.43 |
| Same, plus each new author fetched once and cached locally | up to 217 authors more | up to $2.60 in total |
| Same, plus quoted posts with their authors (assuming 1 in 5 bookmarks quotes) | about 43 posts and 43 authors more | about $0.65 more |
| Author expansion on every weekly poll of 100 | 433 posts, up to 433 authors | about $4.80 |
| Author expansion on every daily poll of 100 | 3,000 posts, up to 3,000 authors | about $33 |

One-time backfill, authors included:

| Posts the API returns | Cost |
| :- | :- |
| 199 | up to $2.20 |
| 800 | up to $8.80 |
| 2,000 (if it were possible) | up to $22 |

## 2. Bookmarks endpoints

### Endpoints, limits, history depth

| Claim | Source |
| :- | :- |
| Endpoints: `GET /2/users/{id}/bookmarks`, `POST /2/users/{id}/bookmarks`, `DELETE /2/users/{id}/bookmarks/{tweet_id}`, `GET /2/users/{id}/bookmarks/folders`, `GET /2/users/{id}/bookmarks/folders/{folder_id}`. | https://api.x.com/2/openapi.json , https://docs.x.com/x-api/posts/bookmarks/introduction |
| No plan requirement is documented for them. | https://docs.x.com/x-api/posts/bookmarks/introduction |
| Rate limits per user per 15 minutes: 180 for `GET bookmarks`, 50 for each folder endpoint, 50 for POST and DELETE. | https://docs.x.com/x-api/fundamentals/rate-limits |
| `max_results` is 1 to 100. Paging uses `pagination_token` and `meta.next_token`. | https://api.x.com/2/openapi.json |
| "With the Bookmarks lookup endpoint, you will be able to get back up to 800 of your most recent bookmarked Tweets." (2022-03-24) | Twitter staff launch announcement, https://devcommunity.x.com/t/build-with-bookmarks-on-the-twitter-api-v2/168804 , linked from https://docs.x.com/changelog |
| No current docs page or spec description states a cap. The live integration guide is cut off mid-sentence before its rate-limits section. | https://docs.x.com/x-api/posts/bookmarks/integrate , https://api.x.com/2/openapi.json |
| Pagination stopping after 2 to 3 pages at `max_results=100` is an acknowledged bug: "We're looking into this bug. As a workaround, reduce the number of max_results". The reporter replied that 90 worked. (2026-02-18) | X staff, https://devcommunity.x.com/t/bookmarks-api-v2-stops-paginating-after-3-pages-no-next-token-returned/257339 |
| A controlled test on 2026-08-26 returned 100 posts, then 99 with no `next_token`, 199 in total, repeatably. Folder lookups exposed 66 older bookmark IDs missing from those 199. | First-hand report, https://devcommunity.x.com/t/bookmarks-endpoint-stops-pagination-after-199-results-despite-older-folder-memberships/274280 |
| Staff reply to that report: "The ~199 cutoff ... is not how the docs describe bookmark lookup. I'll check whether the top-level endpoint is windowed. Folder-scoped bookmark lookups are the workaround for older items in the meantime." No follow-up had been posted by 2026-10-12. | X staff, same thread |
| The same symptoms (95 or 199 results, then no token) were reported in 2023 with no staff answer in the thread. | First-hand reports, https://devcommunity.x.com/t/missing-most-of-my-bookmarks-when-i-try-to-load-them-through-the-api/190643 |

Reading of the above (inference): 800 is the documented ceiling and has never been raised. The reachable number in practice has been as low as 199, and X does not currently know why. For 2,000 bookmarks, plan on the API reaching well under half.

### Folders

| Claim | Source |
| :- | :- |
| The folder list returns each folder's `id` and `name` only. | https://api.x.com/2/openapi.json (`GetUsersBookmarkFoldersResponseData`) |
| Folder contents are post IDs only: "The Posts in this bookmark folder, by ID." The operation takes no field or expansion parameters. | https://api.x.com/2/openapi.json (`GetUsersBookmarksByFolderIdResponse`) |
| The spec lists `max_results` and `pagination_token` as parameters of the folder-contents operation, but its response schema has no `meta` or `next_token`. | https://api.x.com/2/openapi.json |
| The live API rejects `max_results` and `pagination_token` with "The query parameter [max_results] is not one of [id,folder_id]" and returns exactly 20 IDs. Reported 2026-03-01 and again 2026-06-04; neither thread has a staff reply. | First-hand reports, https://devcommunity.x.com/t/bookmark-folder-limits-api-downloads-to-20-not-100-and-no-pagination/258508 , https://devcommunity.x.com/t/bookmark-folder-endpoint-returns-only-20-ids-and-rejects-pagination-parameters/267427 |
| Field and expansion parameters on the folder endpoint are rejected with the same error. | First-hand report with the raw error, https://github.com/theosera/obsidian-ai-pipeline/issues/37 |
| The main bookmarks list does not say which folder a post is in. | https://api.x.com/2/openapi.json (no folder field on `Post`) |

Consequence (inference): folder membership can only be rebuilt by joining folder ID lists against the main list, and only for the 20 IDs each folder returns. The staff-suggested workaround for older bookmarks runs into that same 20-ID cap.

### What comes back

| Content | What the API gives | Source |
| :- | :- | :- |
| Long posts | `note_tweet`: "Contains the full text of a Post for long-form Posts (>280 characters)." It must be requested. The current spec calls it `note_post`: "The full content of the Post, including text beyond 280 characters." | https://docs.x.com/x-api/fundamentals/data-dictionary , https://api.x.com/2/openapi.json |
| Media | The `attachments.media_keys` expansion with `media.fields` gives `url`, `preview_image_url`, `variants` (video files with bit rate and content type), `alt_text`, `type`, `duration_ms`, `width`, `height`. | https://docs.x.com/x-api/fundamentals/data-dictionary , https://api.x.com/2/openapi.json |
| Quoted posts | The post lists what it references with a type (`quoted`, `replied_to`, `retweeted`) and an ID. An expansion puts the referenced post in `includes`. | https://docs.x.com/x-api/fundamentals/data-dictionary , https://api.x.com/2/openapi.json |
| Author | The `author_id` expansion with `user.fields` (username, name, profile image, verified, description and more). | https://api.x.com/2/openapi.json |
| Links | `entities.urls` with `expanded_url` and `unwound_url`. | https://docs.x.com/x-api/fundamentals/data-dictionary |
| Link cards | `card_uri`, a bare string. No field for a card's title, description or image is documented. | https://api.x.com/2/openapi.json |
| Thread context | Not included. The post carries `conversation_id`; the documented way to get the rest of a thread is a search on `conversation_id`. | https://docs.x.com/x-api/fundamentals/conversation-id |
| Articles | An `article` field: "Use this to get the text and entities of an Article." The spec types it as a bare object with no sub-fields, next to `article_title` and the expansions `article.cover_media` and `article.media_entities`. | https://docs.x.com/x-api/fundamentals/data-dictionary , https://api.x.com/2/openapi.json |
| Order | Newest saved first. | First-hand report, https://github.com/aviz85/claude-skills-library/blob/main/skills/x-bookmarks-fetcher/README.md ; consistent with "most recent" in the launch announcement |

A thread search is a standard read at $0.005 per post, not an owned read. (Inference from the Owned Reads list, which contains no search endpoint.)

### Parameter names changed between July and October 2026

| Claim | Source |
| :- | :- |
| Spec version 2.159 defines the bookmarks parameter as `tweet.fields`. | https://github.com/xdevplatform/xdk/blob/84c26540df30c0b798e50e34151c56d5d262ba1c/latest-openapi.json (X's SDK repository, latest commit 2026-07-25) |
| Spec version 2.170 defines it as `post.fields`, with the field `note_post` and the expansion `referenced_posts`. | https://api.x.com/2/openapi.json |
| The official quickstart and data dictionary still show `tweet.fields`, `note_tweet` and `referenced_tweets.id`. | https://docs.x.com/x-api/posts/bookmarks/quickstart/bookmarks-lookup , https://docs.x.com/x-api/fundamentals/data-dictionary |
| X staff used `tweet.fields=author_id` in an answer on 2026-08-31. | https://devcommunity.x.com/t/billing-of-requests-that-involve-expansions/274753 |
| The changelog has no entry for the rename. | https://docs.x.com/changelog |

Which names the live API accepts today is untested. Code written from older examples may need both tried.

## 3. Auth and signup

| Claim | Source |
| :- | :- |
| Bookmarks need a user access token from the OAuth 2.0 Authorization Code flow with PKCE. Scopes: `bookmark.read`, `tweet.read`, `users.read`. | https://docs.x.com/x-api/posts/bookmarks/quickstart/bookmarks-lookup , https://api.x.com/2/openapi.json |
| The authentication mapping guide marks bookmarks as PKCE only; OAuth 1.0a and app-only are blank. The 2022 launch announcement says the same. | https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping , https://devcommunity.x.com/t/build-with-bookmarks-on-the-twitter-api-v2/168804 |
| The spec also lists a second scheme, `UserToken` (HTTP OAuth), on the bookmark operations. This conflicts with the mapping guide. | https://api.x.com/2/openapi.json |
| Access tokens last two hours. A refresh token is issued only if the `offline.access` scope is requested. | https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code |
| The authorization code must be exchanged within 30 seconds. | https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code |
| The callback URL must exactly match one registered on the app. | https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code |
| The current docs do not state a refresh token lifetime or rotation rule. | https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code , https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token |
| "Refresh tokens are only valid for six months." (2022-07-06) | Twitter staff, https://devcommunity.x.com/t/173613/2 |
| "The refresh token is for one-time use only, and it's invalidated once exchanged for a new pair of tokens." (2022-01-05) | Twitter forum reply, https://devcommunity.x.com/t/164525/2 |
| A local callback such as `http://127.0.0.1:8765/` works for a personal script. | First-hand report (working code, February 2026), https://gist.github.com/peterc/7f3d55d46c02f662e5a5e08e070954be |
| Signup: sign in at console.x.com with your X account, accept the Developer Agreement and Policy, describe how you will use the API, create an app with a name, description and use case, then save the credentials, which are shown once. | https://docs.x.com/x-api/getting-started/getting-access |
| That page describes no manual review or waiting period. The bookmarks quickstart still asks for "a developer account with an approved App". | https://docs.x.com/x-api/getting-started/getting-access , https://docs.x.com/x-api/posts/bookmarks/quickstart/bookmarks-lookup |

For a single-user tool (inference): one browser consent, then a stored refresh token that the sync job replaces on every run. Because refresh tokens are single-use, a refresh that fails halfway can strand the job until you consent again in the browser, so the new token should be saved before anything else happens.

## 4. When was a bookmark added?

| Claim | Source |
| :- | :- |
| The bookmarks response has no bookmark timestamp. The only timestamp `Post` carries for the post itself is `created_at`, when it was written. `meta` holds only `next_token`, `previous_token` and `result_count`. The string `bookmarked_at` appears nowhere in the spec. | https://api.x.com/2/openapi.json (`GetUsersBookmarksResponse`, `Post`) |
| A developer who built a bookmarks fetcher reports the same: results come in save order, newest first, with no timestamp. | First-hand report, https://github.com/aviz85/claude-skills-library/blob/main/skills/x-bookmarks-fetcher/README.md |

Consequences (inference):

- A weekly digest works if the sync job stamps each post with the time it first saw it. The stamp is as precise as the sync interval.
- Posts from the initial backfill get no added date, only their relative order.
- The post's `created_at` is a poor substitute: an old post bookmarked today would be missed.
- More frequent syncs give better dates but cost more, because each day's poll is billed again. A daily poll of one small page without expansions is the cheap end of that trade-off.

## 5. Terms of use

| Claim | Source |
| :- | :- |
| The licence lets you "conduct analysis of the X Content, as explicitly approved by X" and "copy a reasonable amount of and display the X Content". | https://docs.x.com/developer-terms/agreement (section II.A) |
| "If you store X Content offline, you must keep it up to date with the current state of that content on X." Deleted or modified content must be deleted or modified "as soon as reasonably possible, or within 24 hours after receiving a request". | https://docs.x.com/developer-terms/policy ("Content compliance") |
| The same duty applies when content "gains protected status" or is suspended or withheld. | https://docs.x.com/developer-terms/agreement (section IV.B) |
| On termination you must permanently delete all Licensed Material, and X can ask for evidence within ten business days. | https://docs.x.com/developer-terms/agreement (section VII.I) |
| You may not "use the X API or X Content to fine-tune or train a foundation or frontier model". | https://docs.x.com/developer-terms/agreement (section III.A(k)) , https://docs.x.com/developer-terms/restricted-use-cases |
| You may not "distribute, redistribute, syndicate ... or otherwise transfer or provide access to" the Licensed Material to a third party except as expressly permitted. Sharing with third parties is limited to IDs, with small allowances for full objects. | https://docs.x.com/developer-terms/agreement (section III.A(d)) , https://docs.x.com/developer-terms/policy ("Content redistribution") |
| Neither document has an exception for service providers or processors. | https://docs.x.com/developer-terms/agreement , https://docs.x.com/developer-terms/policy (searched for the terms; none found) |
| Never derive or infer sensitive characteristics about X users, such as health, political affiliation, ethnicity or religion. | https://docs.x.com/developer-terms/restricted-use-cases |
| Protected-account content may not be shared with people not authorised to see it. | https://docs.x.com/developer-terms/policy ("Consent & permissions") |

My reading (inference, not legal advice):

- A private local library of your own bookmarks is within the terms. The practical duty is a periodic re-check that drops posts which were deleted or went protected. Nothing notifies you, so the re-check costs extra reads.
- Classifying posts with an LLM is inference, not training, so the model-training clause does not cover it. The terms say nothing about LLM inference.
- Sending post text to a hosted LLM is still a transfer of X Content to a third party, and the terms have no service-provider exception. A local model avoids the question. With a hosted model, choose one that does not train on API inputs.
- Classify what posts are about, not who their authors are.
- Describe the real use case when creating the app, since the analysis licence is tied to what X approved.

## Not verified

- **Live behaviour.** No requests were made. How many bookmarks this account can actually page through is unknown.
- **Whether the 199 cutoff is a bug or a deliberate window.** X staff had not answered by 2026-10-12.
- **The rate for authors and quoted posts expanded on the bookmarks endpoint.** Staff confirmed expansions are billed on post lookup at standard rates. Nobody has said whether the owned rate applies to objects expanded on an owned endpoint. Whether media objects and folder ID reads are billed is also unstated.
- **Which parameter names the live API accepts**: `tweet.fields` and `note_tweet`, or `post.fields` and `note_post`.
- **Whether OAuth 1.0a tokens work** on the bookmark endpoints. The spec and the mapping guide disagree.
- **Refresh token lifetime today.** The only statements are forum posts from 2022.
- **Console prices.** The Console needs a login. Rates come from the docs pricing page, which names the Console as authoritative.
- **Minimum one-time credit purchase**, and whether the $20 card credit is enabled for a new account yet.
- **How long signup takes and whether a verified phone number is required.** X's docs describe no review step; I found no first-party statement on timing.
- **What the `article` field contains**, and whether link-card titles and descriptions are returned anywhere.
- **The search window for rebuilding threads**, and whether full-archive search is available on pay-per-use.
- **Result order.** Newest-first rests on one developer's report and the wording of the launch announcement.

## A short test that settles most of this

About ten minutes and well under a dollar (inference):

1. Sign up at console.x.com, add a card, and see whether the $20 credit arrives. Set a spending limit of a few dollars.
2. Request one page of 5 bookmarks with post fields only. Try `tweet.fields` first, then `post.fields` if it is rejected.
3. Repeat with the author expansion, then open the Console's usage view. It shows whether the authors were billed and at which rate.
4. Page through everything at `max_results=50` and count. That count is this account's real history depth.
5. Call the folder list and one folder's contents to see whether more than 20 IDs come back.
