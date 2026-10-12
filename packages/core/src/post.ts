/**
 * What is kept of a post. One shape serves the bookmarked post and the post
 * it quotes, whichever source it came from.
 */

/** A photo, video or GIF attached to a post. */
export interface PostMedia {
  type: "photo" | "video" | "animated_gif";
  /** The image itself for a photo; the poster frame for a video or GIF. */
  imageUrl: string;
  /** Pixel size of the original upload. */
  width: number | null;
  height: number | null;
  /** The description its author gave it, when there is one. */
  altText: string | null;
  /** For a video or GIF, its MP4 at the highest bitrate offered. */
  videoUrl: string | null;
  durationMs: number | null;
}

/** A link in a post's text. */
export interface PostLink {
  /** Where the link leads. */
  url: string;
  /** X's `t.co` redirect for it, which is what the raw text contains. */
  shortUrl: string;
  /** The shortened form X displays. */
  displayUrl: string;
}

/** The preview X attaches to a link: a title, a description and an image. */
export interface PostCard {
  /** X's name for the card layout, such as `summary_large_image`. */
  name: string;
  /** Where the card leads: the link's destination when the post names it, else its `t.co` redirect. */
  url: string;
  title: string | null;
  description: string | null;
  /** The site the card names, such as `example.com`. */
  domain: string | null;
  imageUrl: string | null;
}

/**
 * An X Article attached to a post. The timeline carries the title and an
 * opening excerpt only; the article's body is not in a bookmarks response.
 */
export interface PostArticle {
  id: string;
  title: string;
  previewText: string;
  coverImageUrl: string | null;
}

export interface PostContent {
  /** X's numeric post id, as a decimal string. */
  postId: string;
  /** X's numeric user id of the post's author, as a decimal string. */
  authorId: string;
  /** The author's handle, without the `@`, as of this sighting. */
  authorHandle: string;
  /** The author's display name, as of this sighting. */
  authorName: string;
  authorAvatarUrl: string | null;
  /** Whether X shows a verification badge on the author. */
  authorVerified: boolean;
  /**
   * The post's text as X displays it: complete for a long-form post, with
   * links written out in full, and without the reply prefix and the trailing
   * media link that X hides.
   */
  text: string;
  /** When the post was written. This is not when it was bookmarked. */
  postedAt: Date;
  /** X's language code for the text, such as `en`, or `und` when it found none. */
  lang: string | null;
  /** The id of the first post of the thread this post belongs to. */
  conversationId: string | null;
  inReplyToPostId: string | null;
  inReplyToHandle: string | null;
  media: PostMedia[];
  links: PostLink[];
  card: PostCard | null;
  article: PostArticle | null;
  /** Engagement as of this sighting. Null where the source did not say. */
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  quoteCount: number | null;
  bookmarkCount: number | null;
  viewCount: number | null;
}

/**
 * The post a bookmarked post quotes. X withholds a quoted post that was
 * deleted or restricted, and then only its id is known.
 */
export type QuotedPost =
  | (PostContent & {
      available: true;
      /** The id of the post this one quotes in turn. Only one level is kept. */
      quotedPostId: string | null;
    })
  | { available: false; postId: string };
