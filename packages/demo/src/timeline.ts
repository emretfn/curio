/**
 * Writes invented posts as pages of the bookmarks timeline, in the shape the
 * web client's `Bookmarks` response has, so that the demo library is made the
 * way a real one is: each page stored as a raw capture and read by core's
 * own parser.
 *
 * A page here holds the fields that parser reads and little else. It is not
 * a copy of a real response and no parser is tested against it: the fixtures
 * under `packages/core/src/parsers/fixtures` are what the parsers answer to
 * (PARSE-9).
 *
 * Nothing written here is an address on a host X owns. A real response
 * carries media on X's CDN and links through X's shortener; these pages
 * carry both on names under `.invalid`, the top-level domain reserved for
 * names that must never resolve (RFC 2606). The library's media policy
 * admits X's two media hosts and nothing else, so the app offers to load
 * none of it and shows what a post says is there.
 */

/** Where a demo post's pictures, posters and avatars are said to be. Resolves nowhere. */
export const MEDIA_HOST = "media.demo.invalid";
/** Where a demo post's video files are said to be. Resolves nowhere. */
export const VIDEO_HOST = "video.demo.invalid";
/** The stand-in for the link shortener a real response's text holds. Resolves nowhere. */
export const SHORT_LINK_HOST = "go.demo.invalid";

export interface DemoAuthor {
  /** Digits, and more of them than an id of X's has. */
  id: string;
  /** Longer than X allows a handle to be, so it is nobody's. */
  handle: string;
  name: string;
  verified: boolean;
}

export interface DemoMedia {
  type: "photo" | "video" | "animated_gif";
  /** The description its author gave it, when there is one. */
  alt: string | null;
  width: number;
  height: number;
  /** A video's length. */
  durationMs?: number;
}

export interface DemoCard {
  /** Where the card leads. It is one of the links in the post's text. */
  url: string;
  title: string;
  description: string;
}

export interface DemoArticle {
  title: string;
  /** The opening lines, which are all a timeline carries of an article. */
  preview: string;
}

export interface DemoCounts {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  views: number;
}

export interface DemoPost {
  id: string;
  author: DemoAuthor;
  /** As its author wrote it, links in full. */
  text: string;
  lang: string;
  postedAt: Date;
  media: DemoMedia[];
  card: DemoCard | null;
  article: DemoArticle | null;
  /** The post it quotes, or the id of one X no longer sends. */
  quoted: DemoPost | { withheldId: string } | null;
  /** The post it answers, which a timeline names and does not hold. */
  replyTo: { postId: string; handle: string } | null;
  counts: DemoCounts;
}

export type DemoEntry =
  | { kind: "post"; post: DemoPost; sortIndex: string }
  /** A bookmark whose post X withholds: a tombstone, or nothing at all. */
  | {
      kind: "withheld";
      postId: string;
      sortIndex: string;
      sent: "tombstone" | "nothing";
    };

/** Posts longer than this are long-form: the timeline holds an excerpt and the whole text apart. */
const LONG_FORM_CODE_POINTS = 280;
const EXCERPT_CODE_POINTS = 270;

const DAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const two = (value: number) => String(value).padStart(2, "0");

/** A time as the timeline writes one: `Wed Oct 10 20:19:24 +0000 2018`. */
function timelineTime(at: Date): string {
  return `${DAYS[at.getUTCDay()]} ${MONTHS[at.getUTCMonth()]} ${two(at.getUTCDate())} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} +0000 ${at.getUTCFullYear()}`;
}

/** The three characters a timeline escapes in a post's text. */
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const codePoints = (text: string) => Array.from(text).length;

const LINK = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;

interface Link {
  url: string;
  expanded_url: string;
  display_url: string;
}

/** A link as shown: without its scheme, cut where a long one would be. */
function displayOf(url: string): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return bare.length > 28 ? `${bare.slice(0, 27)}…` : bare;
}

/**
 * The text with each link replaced by a short one, as a timeline holds it,
 * and the list that says where each short link leads.
 */
function shorten(text: string, postId: string): { text: string; urls: Link[] } {
  const urls: Link[] = [];
  const shortened = text.replace(LINK, (url) => {
    const known = urls.find((link) => link.expanded_url === url);
    if (known !== undefined) return known.url;
    const link = {
      url: `https://${SHORT_LINK_HOST}/${postId.slice(-9)}${urls.length}`,
      expanded_url: url,
      display_url: displayOf(url),
    };
    urls.push(link);
    return link.url;
  });
  return { text: shortened, urls };
}

function author({ id, handle, name, verified }: DemoAuthor) {
  return {
    __typename: "User",
    rest_id: id,
    core: { name, screen_name: handle },
    avatar: { image_url: `https://${MEDIA_HOST}/avatar/${id}.jpg` },
    is_blue_verified: verified,
  };
}

function media(item: DemoMedia, postId: string, index: number, link: string) {
  const key = `${postId.slice(-9)}${index}`;
  return {
    type: item.type,
    url: link,
    media_url_https: `https://${MEDIA_HOST}/${item.type}/${key}.jpg`,
    original_info: { width: item.width, height: item.height },
    ...(item.alt === null ? {} : { ext_alt_text: item.alt }),
    ...(item.type === "photo"
      ? {}
      : {
          video_info: {
            ...(item.durationMs === undefined
              ? {}
              : { duration_millis: item.durationMs }),
            variants: [
              {
                content_type: "video/mp4",
                bitrate: 2176000,
                url: `https://${VIDEO_HOST}/${item.type}/${key}.mp4`,
              },
            ],
          },
        }),
  };
}

function card({ url, title, description }: DemoCard, urls: readonly Link[]) {
  const short = urls.find((link) => link.expanded_url === url)?.url ?? url;
  const text = (key: string, value: string) => ({
    key,
    value: { string_value: value, type: "STRING" },
  });
  return {
    rest_id: short,
    legacy: {
      name: "summary_large_image",
      url: short,
      binding_values: [
        text("card_url", short),
        text("title", title),
        text("description", description),
        text("domain", new URL(url).hostname),
        {
          key: "thumbnail_image_original",
          value: {
            image_value: {
              url: `https://${MEDIA_HOST}/card/${encodeURIComponent(new URL(url).hostname)}.jpg`,
              width: 1200,
              height: 630,
            },
            type: "IMAGE",
          },
        },
      ],
    },
  };
}

/** The object a timeline calls a `Tweet`. */
function tweet(post: DemoPost): Record<string, unknown> {
  const whole = shorten(post.text, post.id);
  const long = codePoints(post.text) > LONG_FORM_CODE_POINTS;
  // A long-form post's own field holds an excerpt; the whole is apart.
  const shown = long
    ? shorten(
        `${Array.from(post.text).slice(0, EXCERPT_CODE_POINTS).join("")}…`,
        post.id,
      )
    : whole;
  // A reply opens with the handle it answers, and the timeline says where
  // the displayed text begins.
  const prefix = post.replyTo === null ? "" : `@${post.replyTo.handle} `;
  const displayed = escapeHtml(shown.text);
  const mediaLink =
    post.media.length === 0
      ? null
      : `https://${SHORT_LINK_HOST}/m${post.id.slice(-9)}`;
  const attached = post.media.map((item, index) =>
    media(item, post.id, index, mediaLink ?? ""),
  );
  const quoted = post.quoted;
  return {
    __typename: "Tweet",
    rest_id: post.id,
    core: { user_results: { result: author(post.author) } },
    ...(post.card === null
      ? post.article === null
        ? {}
        : // An article's post carries a card that is an id and nothing more.
          { card: { rest_id: `article-${post.id}` } }
      : { card: card(post.card, whole.urls) }),
    ...(post.article === null
      ? {}
      : {
          article: {
            article_results: {
              result: {
                rest_id: post.id,
                title: post.article.title,
                preview_text: post.article.preview,
                cover_media: {
                  media_info: {
                    original_img_url: `https://${MEDIA_HOST}/article/${post.id}.jpg`,
                  },
                },
              },
            },
          },
        }),
    ...(long
      ? {
          note_tweet: {
            is_expandable: true,
            note_tweet_results: {
              result: { text: whole.text, entity_set: { urls: whole.urls } },
            },
          },
        }
      : {}),
    legacy: {
      created_at: timelineTime(post.postedAt),
      conversation_id_str: post.replyTo?.postId ?? post.id,
      ...(post.replyTo === null
        ? {}
        : {
            in_reply_to_status_id_str: post.replyTo.postId,
            in_reply_to_screen_name: post.replyTo.handle,
          }),
      full_text:
        mediaLink === null
          ? `${prefix}${displayed}`
          : `${prefix}${displayed} ${mediaLink}`,
      display_text_range: [
        codePoints(prefix),
        codePoints(prefix) + codePoints(displayed),
      ],
      entities: {
        urls: shown.urls,
        ...(mediaLink === null ? {} : { media: attached }),
      },
      ...(mediaLink === null ? {} : { extended_entities: { media: attached } }),
      lang: post.lang,
      favorite_count: post.counts.likes,
      retweet_count: post.counts.reposts,
      reply_count: post.counts.replies,
      quote_count: post.counts.quotes,
      bookmark_count: post.counts.bookmarks,
      bookmarked: true,
      is_quote_status: quoted !== null,
      ...(quoted === null
        ? {}
        : {
            quoted_status_id_str:
              "withheldId" in quoted ? quoted.withheldId : quoted.id,
          }),
    },
    ...(quoted === null
      ? {}
      : {
          quoted_status_result:
            "withheldId" in quoted
              ? { result: { __typename: "TweetTombstone" } }
              : { result: tweet(quoted) },
        }),
    views: { count: String(post.counts.views), state: "EnabledWithCount" },
  };
}

function entry(item: DemoEntry) {
  const postId = item.kind === "post" ? item.post.id : item.postId;
  return {
    entryId: `tweet-${postId}`,
    sortIndex: item.sortIndex,
    content: {
      __typename: "TimelineTimelineItem",
      entryType: "TimelineTimelineItem",
      itemContent: {
        __typename: "TimelineTweet",
        itemType: "TimelineTweet",
        tweetDisplayType: "Tweet",
        tweet_results:
          item.kind === "post"
            ? { result: tweet(item.post) }
            : item.sent === "tombstone"
              ? { result: { __typename: "TweetTombstone" } }
              : {},
      },
    },
  };
}

function cursor(type: "Top" | "Bottom", sortIndex: string) {
  return {
    entryId: `cursor-${type.toLowerCase()}-${sortIndex}`,
    sortIndex,
    content: {
      __typename: "TimelineTimelineCursor",
      entryType: "TimelineTimelineCursor",
      cursorType: type,
      value: `demo-${type.toLowerCase()}-${sortIndex}`,
    },
  };
}

/**
 * One page of the timeline as text: its entries, newest first as given, and
 * the two cursors every page ends with. A page with no entries is the one
 * that follows the last bookmark.
 */
export function timelinePage(entries: readonly DemoEntry[]): string {
  const first = BigInt(entries[0]?.sortIndex ?? "2");
  const last = BigInt(entries.at(-1)?.sortIndex ?? "2");
  return JSON.stringify({
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [
                ...entries.map(entry),
                cursor("Top", String(first + 1n)),
                cursor("Bottom", String(last - 1n)),
              ],
            },
          ],
        },
      },
    },
  });
}

/**
 * The value a timeline orders its entries by. Its upper bits are the moment
 * the bookmark was made, which is where core reads the estimated bookmark
 * time from; `salt` keeps two made in one millisecond apart.
 */
export function sortIndexAt(at: Date, salt: number): string {
  return String((BigInt(at.getTime()) << 20n) | BigInt(salt & 0xfffff));
}
