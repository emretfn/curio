/**
 * The check that a fixture holds nothing from the real captures: no value of
 * a real response may appear in a fixture, whole or as part of a longer
 * string, unless it is one of X's own constants listed in `SHARED_STRINGS`.
 *
 * It does not trust the redactor: it knows nothing of the redactor's rules,
 * and compares what was captured with what would be committed.
 */

/**
 * Every string that may appear both in a real response and in a fixture.
 * These are names from X's schema, the same in everyone's responses. Adding
 * to this list is a reviewed decision: a string here is no longer checked.
 */
export const SHARED_STRINGS: ReadonlySet<string> = new Set([
  // Type names.
  "User",
  "Tweet",
  "TweetWithVisibilityResults",
  "TweetUnavailable",
  "TweetTombstone",
  "TextTombstone",
  "TimelineTimelineItem",
  "TimelineTimelineCursor",
  "TimelineTweet",
  "TimelineAddEntries",
  "TimelineUrl",
  "ApiImage",
  "CtaLimitedActionPrompt",
  // Enumerated values.
  "Top",
  "Bottom",
  "photo",
  "video",
  "animated_gif",
  "video/mp4",
  "application/x-mpegURL",
  "fit",
  "crop",
  "Available",
  "Enabled",
  "EnabledWithCount",
  "None",
  "none",
  "regular",
  "Circle",
  "Square",
  "Business",
  "Creator",
  "BusinessLabel",
  "Badge",
  "DeepLink",
  "ExternalUrl",
  "IconBriefcaseStroke",
  "Bold",
  "Italic",
  "Reply",
  "SeeConversation",
  "BirdwatchEyeOff",
  "BirdwatchV1Icon",
  "Default",
  "C2paClient",
  "user",
  // What X answers to a bookmark mutation.
  "Done",
  // Card layouts, binding types and binding names.
  "summary",
  "summary_large_image",
  "player",
  "unified_card",
  "STRING",
  "BOOLEAN",
  "IMAGE",
  "IMAGE_COLOR",
  "USER",
  "publisher_id",
  "card_url",
  "vanity_url",
  "title",
  "description",
  "domain",
  "site",
  "creator",
  "thumbnail_image",
  "thumbnail_image_small",
  "thumbnail_image_large",
  "thumbnail_image_x_large",
  "thumbnail_image_original",
  "thumbnail_image_color",
  "thumbnail_image_alt_text",
  "summary_photo_image",
  "summary_photo_image_small",
  "summary_photo_image_large",
  "summary_photo_image_x_large",
  "summary_photo_image_original",
  "summary_photo_image_color",
  "summary_photo_image_alt_text",
  "photo_image_full_size",
  "photo_image_full_size_small",
  "photo_image_full_size_large",
  "photo_image_full_size_x_large",
  "photo_image_full_size_original",
  "photo_image_full_size_color",
  "photo_image_full_size_alt_text",
  "player_url",
  "player_width",
  "player_height",
  "player_image",
  "player_image_small",
  "player_image_large",
  "player_image_x_large",
  "player_image_original",
  "player_image_color",
  "app_name",
  "app_is_free",
  "app_star_rating",
  "app_num_ratings",
  "app_price_amount",
  "app_price_currency",
  "broadcast_id",
  "broadcast_url",
  "broadcast_title",
  "broadcast_state",
  "broadcast_source",
  "broadcast_orientation",
  "broadcast_is_high_latency",
  "broadcast_width",
  "broadcast_height",
  "broadcast_media_id",
  "broadcast_media_key",
  "broadcast_thumbnail",
  "broadcast_thumbnail_small",
  "broadcast_thumbnail_large",
  "broadcast_thumbnail_x_large",
  "broadcast_thumbnail_original",
  "broadcast_thumbnail_color",
  "broadcaster_twitter_id",
  "broadcaster_username",
  "broadcaster_display_name",
  // The language every fixture claims.
  "en",
  // Hosts and fixed path parts of X's own URLs, which are searched for as
  // parts of a real link.
  "pbs.twimg.com",
  "video.twimg.com",
  "twitter.com",
  "profile_images",
  "profile_banners",
  "ext_tw_video",
  "ext_tw_video_thumb",
  "amplify_video",
  "amplify_video_thumb",
  "tweet_video",
  "tweet_video_thumb",
  "card_img",
]);

/** The shortest real value searched for inside longer fixture strings. Shorter ones are compared whole. */
const SHORTEST_PART = 8;

export interface Leak {
  fixture: string;
  /** Where in the fixture the real value sits, as a JSON path. The value itself is not repeated. */
  path: string;
  /** Whether a fixture value is a real value, or contains one. */
  how: "is a real value" | "contains a real value";
}

/** One of X's own sites with nothing after it, such as `https://twitter.com`: what many profiles give as their website. */
const X_ORIGIN = /^https?:\/\/(www\.)?(x|twitter)\.com\/?$/;

/**
 * Whether a value may be the same in a capture and a fixture: one of the
 * listed constants, the bare address of X itself, or a number of up to three
 * digits, which the redactor keeps as it is and which identifies nothing.
 */
function isShared(value: string): boolean {
  return (
    value === "" ||
    SHARED_STRINGS.has(value) ||
    X_ORIGIN.test(value) ||
    /^[0-9]{1,3}$/.test(value)
  );
}

/** Calls `visit` with every string in a JSON value, and every long number as its digits. */
function eachValue(
  json: unknown,
  path: string,
  visit: (value: string, path: string) => void,
): void {
  if (typeof json === "string") visit(json, path);
  else if (typeof json === "number") {
    if (Number.isInteger(json) && Math.abs(json) >= 10 ** (SHORTEST_PART - 1)) {
      visit(String(Math.abs(json)), path);
    }
  } else if (Array.isArray(json)) {
    json.forEach(
      (item, index) => void eachValue(item, `${path}[${index}]`, visit),
    );
  } else if (typeof json === "object" && json !== null) {
    for (const [name, value] of Object.entries(json)) {
      eachValue(value, `${path}.${name}`, visit);
    }
  }
}

/**
 * The parts of a real value that identify it on their own and could survive
 * inside a longer string: ids, link tokens, hosts and handles.
 */
function partsOf(value: string): string[] {
  const parts: string[] = value.match(/[0-9]{8,}|@[A-Za-z0-9_]{4,15}/g) ?? [];
  for (const link of value.match(/https?:\/\/[^\s"<>]+/g) ?? []) {
    try {
      const { hostname, pathname } = new URL(link);
      parts.push(hostname, ...pathname.split("/"));
    } catch {
      // Not a link after all; the whole value is still searched for.
    }
  }
  return parts;
}

/**
 * Compares real captured text with fixtures. `real` holds response bodies,
 * and anything else captured with them (request URLs and bodies); text that
 * is not JSON is taken as one value.
 */
export function findLeaks(
  real: Iterable<string>,
  fixtures: readonly { name: string; text: string }[],
): Leak[] {
  const whole = new Set<string>();
  const parts = new Set<string>();
  const take = (value: string) => {
    if (isShared(value)) return;
    whole.add(value);
    for (const part of [value, ...partsOf(value)]) {
      if (part.length >= SHORTEST_PART && !isShared(part)) parts.add(part);
    }
  };
  for (const text of real) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      take(text);
      continue;
    }
    eachValue(json, "$", take);
  }

  const leaks: Leak[] = [];
  for (const fixture of fixtures) {
    const values: { value: string; path: string }[] = [];
    eachValue(JSON.parse(fixture.text), "$", (value, path) => {
      values.push({ value, path });
      if (whole.has(value)) {
        leaks.push({ fixture: fixture.name, path, how: "is a real value" });
      }
    });
    // One search per real part over the whole fixture; the value that holds
    // a hit is looked for only when there is one.
    const haystack = values.map(({ value }) => value).join("\n");
    for (const part of parts) {
      if (!haystack.includes(part)) continue;
      for (const { value, path } of values) {
        if (value !== part && value.includes(part)) {
          leaks.push({
            fixture: fixture.name,
            path,
            how: "contains a real value",
          });
        }
      }
    }
  }
  return leaks;
}
