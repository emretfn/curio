/**
 * An invented response in the shape of a real one, standing in for a real
 * capture in the tests of the redactor and of the leak check. Nothing here
 * comes from anyone's bookmarks: the names, ids and links are made up.
 */
export const INVENTED = {
  postId: "1975123456789012345",
  authorId: "44196397001",
  handle: "RealAuthor_1",
  mentioned: "SomeFriend",
  name: "A Real Person",
  shortLink: "https://t.co/AbCdEf1234",
  mediaLink: "https://t.co/ZyXwVu9876",
  site: "private-blog.example.org",
  text: "@SomeFriend café \u{1F600} read this &amp; that https://t.co/AbCdEf1234 #Secret https://t.co/ZyXwVu9876",
} as const;

export const inventedCapture = {
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              {
                entryId: `tweet-${INVENTED.postId}`,
                sortIndex: "1861891119789912064",
                content: {
                  entryType: "TimelineTimelineItem",
                  __typename: "TimelineTimelineItem",
                  itemContent: {
                    itemType: "TimelineTweet",
                    tweet_results: {
                      result: {
                        __typename: "Tweet",
                        rest_id: INVENTED.postId,
                        source:
                          '<a href="https://mobile.twitter.com" rel="nofollow">Twitter for Somephone</a>',
                        core: {
                          user_results: {
                            result: {
                              __typename: "User",
                              id: Buffer.from(
                                `User:${INVENTED.authorId}`,
                              ).toString("base64"),
                              rest_id: INVENTED.authorId,
                              is_blue_verified: true,
                              avatar: {
                                image_url:
                                  "https://pbs.twimg.com/profile_images/1790000000000000001/Qw3rTy_normal.jpg",
                              },
                              core: {
                                created_at: "Tue Mar 03 10:11:12 +0000 2015",
                                name: INVENTED.name,
                                screen_name: INVENTED.handle,
                              },
                              relationship_counts: {
                                followers: 48213,
                                following: 7,
                              },
                            },
                          },
                        },
                        views: { count: "937", state: "EnabledWithCount" },
                        legacy: {
                          created_at: "Wed Apr 08 06:30:15 +0000 2026",
                          full_text: INVENTED.text,
                          display_text_range: [12, 71],
                          lang: "tr",
                          favorite_count: 1234,
                          retweet_count: 56,
                          reply_count: 7,
                          quote_count: 0,
                          bookmark_count: 890,
                          bookmarked: true,
                          is_quote_status: false,
                          conversation_id_str: INVENTED.postId,
                          id_str: INVENTED.postId,
                          user_id_str: INVENTED.authorId,
                          in_reply_to_screen_name: INVENTED.mentioned,
                          entities: {
                            hashtags: [{ indices: [64, 71], text: "Secret" }],
                            urls: [
                              {
                                display_url: `${INVENTED.site}/a-post…`,
                                expanded_url: `https://${INVENTED.site}/a-post/about-me?ref=42`,
                                indices: [40, 63],
                                url: INVENTED.shortLink,
                              },
                            ],
                            user_mentions: [
                              {
                                id_str: "55500011122",
                                indices: [0, 11],
                                name: "Some Friend",
                                screen_name: INVENTED.mentioned,
                              },
                            ],
                          },
                          extended_entities: {
                            media: [
                              {
                                type: "photo",
                                media_key: "3_1790000000000000002",
                                indices: [72, 95],
                                url: INVENTED.mediaLink,
                                expanded_url: `https://x.com/${INVENTED.handle}/status/${INVENTED.postId}/photo/1`,
                                media_url_https:
                                  "https://pbs.twimg.com/media/GsEcReTiMaGe.jpg",
                                original_info: { width: 1920, height: 1080 },
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
              {
                entryId: "cursor-bottom-1861891119789000000",
                sortIndex: "1861891119789000000",
                content: {
                  entryType: "TimelineTimelineCursor",
                  cursorType: "Bottom",
                  value: "HBaAgLDRn4yXzzQAAA==",
                },
              },
            ],
          },
        ],
      },
    },
  },
};
