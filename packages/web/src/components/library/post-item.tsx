"use client";

/**
 * One item of the library: a bookmarked post, readable where it stands, or
 * the note left where X withholds a post.
 */
import {
  ArrowUpRight,
  BadgeCheck,
  BookmarkX,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Heart,
  Repeat2,
} from "lucide-react";
import Link from "next/link";
import { memo, useId, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ArticleView,
  AuthorView,
  CardView,
  MarkedLine,
  PostBody,
  PostView,
  QuotedView,
  TimeView,
  WithheldView,
} from "@/lib/post-view";
import { cn } from "@/lib/utils";
import { MediaScope, MediaStrip, PreviewThumb } from "./media.tsx";
import { useRemembered } from "./row-memory.tsx";

/** A link that leaves the app. It opens in a new tab and tells the other site nothing. */
function Outbound({
  href,
  className,
  children,
}: {
  href: string;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
    >
      {children}
    </a>
  );
}

function Time({ at, className }: { at: TimeView; className?: string }) {
  return (
    <time dateTime={at.iso} title={at.full} className={className}>
      {at.label}
    </time>
  );
}

/** The author's initials where the picture would be. Avatars are never loaded. */
function Avatar({ author, small }: { author: AuthorView; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{ "--hue": author.hue } as React.CSSProperties}
      className={cn(
        "avatar-tint flex shrink-0 select-none items-center justify-center rounded-full font-semibold",
        small ? "size-5 text-[0.5625rem]" : "size-9 text-[0.8125rem]",
      )}
    >
      {author.initials}
    </span>
  );
}

/** Text with what a search found in it marked. The server decided which. */
function Marked({ line }: { line: MarkedLine }) {
  return line.map((piece, index) =>
    piece.kind === "mark" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one string, in order.
      <mark key={index}>{piece.text}</mark>
    ) : (
      piece.text
    ),
  );
}

function PostText({ post, quoted }: { post: PostBody; quoted?: boolean }) {
  // Remembered by the row, which leaves the page when it is scrolled away.
  const [expanded, setExpanded] = useRemembered(`open:${post.id}`, false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  if (post.text.length === 0) return null;
  const shortened = post.collapsible && !expanded;
  const further = shortened ? post.further : null;
  const toggle = () => {
    setExpanded(!expanded);
    if (expanded) {
      // Closing a long post from its foot would leave the reader far below
      // where it now ends. Once it has closed, bring it back into view. No
      // animation: the reader asked for the page to change, and should not
      // have to watch it.
      requestAnimationFrame(() => {
        container.current?.closest("[data-post]")?.scrollIntoView({
          block: "nearest",
        });
      });
    }
  };
  return (
    <div ref={container} className="flex flex-col items-start gap-1.5">
      <div
        id={id}
        lang={post.lang ?? undefined}
        dir="auto"
        className={cn(
          "post-text w-full",
          quoted && "text-[0.875rem]",
          shortened && (quoted ? "line-clamp-5" : "line-clamp-[10]"),
        )}
      >
        {post.text.map((piece, index) =>
          piece.kind === "link" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one text, in order.
            <Outbound key={index} href={piece.href}>
              {piece.label}
            </Outbound>
          ) : piece.kind === "mark" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: as above.
            <mark key={index}>{piece.text}</mark>
          ) : (
            piece.text
          ),
        )}
      </div>
      {further !== null ? (
        <p className="w-full border-highlight border-s-2 ps-2.5 text-[0.8125rem] text-muted-foreground leading-normal">
          <span className="font-medium">Further down: </span>
          <Marked line={further} />
        </p>
      ) : null}
      {post.collapsible ? (
        <Button
          variant="ghost"
          size="sm"
          data-expand=""
          aria-expanded={expanded}
          aria-controls={id}
          onClick={toggle}
          className="-ms-2.5 text-muted-foreground"
        >
          {expanded ? "Show less" : `Show all ${post.wordCount} words`}
          {expanded ? (
            <ChevronUp data-icon="inline-end" aria-hidden="true" />
          ) : (
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          )}
        </Button>
      ) : null}
    </div>
  );
}

/** A link card or an X Article: a picture's place, and a few lines of text. */
function Preview({
  href,
  label,
  title,
  description,
  imageSrc,
}: {
  href: string | null;
  label: string | null;
  title: MarkedLine | null;
  description: MarkedLine | null;
  imageSrc: string | null;
}) {
  const text = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
      {label !== null ? (
        <span className="truncate text-muted-foreground text-xs">{label}</span>
      ) : null}
      {title !== null ? (
        <span className="line-clamp-2 font-medium text-[0.875rem] leading-snug">
          <Marked line={title} />
        </span>
      ) : null}
      {description !== null ? (
        <span className="line-clamp-2 text-[0.8125rem] text-muted-foreground leading-normal">
          <Marked line={description} />
        </span>
      ) : null}
    </span>
  );
  return (
    <div className="flex items-start gap-3 rounded-xl border p-2 in-data-[quoted]:rounded-md">
      <PreviewThumb src={imageSrc} />
      {href !== null ? (
        <Outbound
          href={href}
          className="flex min-w-0 flex-1 self-stretch rounded-sm px-1 outline-none hover:[&_span.font-medium]:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {text}
        </Outbound>
      ) : (
        <div className="flex min-w-0 flex-1 px-1">{text}</div>
      )}
    </div>
  );
}

function CardPreview({ card }: { card: CardView }) {
  return (
    <Preview
      href={card.href}
      label={card.domain}
      title={card.title}
      description={card.description}
      imageSrc={card.imageSrc}
    />
  );
}

function ArticlePreview({
  article,
  url,
}: {
  article: ArticleView;
  url: string | null;
}) {
  return (
    <Preview
      href={article.href ?? url}
      label="Article on X · only its opening was captured"
      title={article.title}
      description={article.preview}
      imageSrc={article.coverSrc}
    />
  );
}

function Attachments({ post }: { post: PostBody }) {
  return (
    <>
      {post.article !== null ? (
        <ArticlePreview article={post.article} url={post.url} />
      ) : null}
      <MediaStrip media={post.media} summary={post.mediaSummary} />
      {post.card !== null ? <CardPreview card={post.card} /> : null}
    </>
  );
}

function OpenOnX({ url, children }: { url: string | null; children: string }) {
  if (url === null) return null;
  return (
    <Outbound
      href={url}
      className="-mx-1 inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-1 font-medium text-[0.8125rem] text-muted-foreground outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </Outbound>
  );
}

function Quoted({ quoted }: { quoted: QuotedView }) {
  if (!quoted.available) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-dashed px-3 py-2.5 text-[0.8125rem] text-muted-foreground">
        <span className="flex items-center gap-2">
          <EyeOff aria-hidden="true" className="size-3.5 shrink-0" />
          The quoted post is not available. X sent only its id.
        </span>
        <OpenOnX url={quoted.url}>Open quoted post on X</OpenOnX>
      </div>
    );
  }
  return (
    <MediaScope postId={quoted.id}>
      <section
        aria-label={`Quoted post by ${quoted.author.name}`}
        data-quoted=""
        className="flex flex-col gap-3 rounded-[1.25rem] border p-4"
      >
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.8125rem]">
          <Avatar author={quoted.author} small />
          <bdi className="font-semibold">{quoted.author.name}</bdi>
          <span className="text-muted-foreground">@{quoted.author.handle}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <Time at={quoted.posted} className="text-muted-foreground" />
        </div>
        <PostText post={quoted} quoted />
        <Attachments post={quoted} />
        <div className="flex justify-end">
          <OpenOnX url={quoted.url}>Open quoted post on X</OpenOnX>
        </div>
      </section>
    </MediaScope>
  );
}

function Count({
  value,
  label,
  icon: Icon,
}: {
  value: string | null;
  label: string;
  icon: typeof Heart;
}) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={label}>
      <Icon aria-hidden="true" className="size-3.5" />
      {value}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** How the saved time is worded, by what it rests on. */
const SAVED_BY: Record<PostView["savedBy"], { label: string; title: string }> =
  {
    observed: {
      label: "Saved",
      title: "X confirmed this bookmark as you made it.",
    },
    estimate: {
      label: "Saved",
      title: "Estimated from the order of your bookmarks on X.",
    },
    "first-seen": {
      label: "In the library since",
      title:
        "X gave no time for this bookmark. This is when the library first captured it.",
    },
  };

export const PostItem = memo(function PostItem({
  post,
  position,
  total,
}: {
  post: PostView;
  /** Its place among all the items of the list, from 1, and how many there are. */
  position: number;
  total: number;
}) {
  const headingId = useId();
  return (
    <MediaScope postId={post.id}>
      <article
        data-post=""
        data-post-id={post.id}
        data-url={post.url ?? undefined}
        tabIndex={-1}
        aria-labelledby={headingId}
        // Only the rows near the screen are in the page, so each says where
        // it stands among all of them.
        aria-posinset={position}
        aria-setsize={total}
        className="post-row flex flex-col gap-4 rounded-sm py-7 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[6px] sm:py-8"
      >
        {/* The author belongs to the text under it: nearer than the rest. */}
        <header className="-mb-1 flex items-center gap-3">
          <Avatar author={post.author} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h3
              id={headingId}
              className="flex min-w-0 items-center gap-1.5 text-[0.9375rem] leading-snug"
            >
              <Link
                href={`/?author=${post.author.id}`}
                prefetch={false}
                title={`Show every bookmark by ${post.author.name}`}
                className="truncate rounded-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <bdi>{post.author.name}</bdi>
              </Link>
              {post.author.verified ? (
                <BadgeCheck
                  role="img"
                  aria-label="Verified on X"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : null}
              <span className="truncate font-normal text-muted-foreground">
                @{post.author.handle}
              </span>
            </h3>
            <p className="truncate text-[0.8125rem] text-muted-foreground leading-snug">
              Posted <Time at={post.posted} />
              {post.replyingTo !== null
                ? ` · replying to @${post.replyingTo}`
                : ""}
            </p>
          </div>
        </header>

        {post.removed !== null || post.withheld ? (
          <div className="flex flex-wrap gap-1.5">
            {post.removed !== null ? (
              <Badge
                variant="outline"
                title="You removed this bookmark on X. The library keeps its copy."
              >
                <BookmarkX aria-hidden="true" />
                Removed on X · <Time at={post.removed} />
              </Badge>
            ) : null}
            {post.withheld ? (
              <Badge
                variant="outline"
                title="X no longer sends this post. This is the copy the library captured earlier."
              >
                <EyeOff aria-hidden="true" />
                Withheld on X · kept here
              </Badge>
            ) : null}
          </div>
        ) : null}

        <PostText post={post} />
        <Attachments post={post} />
        {post.quoted !== null ? <Quoted quoted={post.quoted} /> : null}

        <footer className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span title={SAVED_BY[post.savedBy].title}>
              {SAVED_BY[post.savedBy].label} <Time at={post.saved} />
            </span>
            <Count value={post.counts.likes} label="likes" icon={Heart} />
            <Count value={post.counts.reposts} label="reposts" icon={Repeat2} />
            <Count value={post.counts.views} label="views" icon={Eye} />
          </p>
          <OpenOnX url={post.url}>Open on X</OpenOnX>
        </footer>
      </article>
    </MediaScope>
  );
});

/**
 * A bookmark whose post X withholds. There is nothing to read, so it is one
 * line: the list says once, above these, what they are.
 */
export function WithheldItem({
  post,
  position,
  total,
}: {
  post: WithheldView;
  position: number;
  total: number;
}) {
  return (
    <article
      data-post=""
      data-post-id={post.id}
      data-url={post.url ?? undefined}
      tabIndex={-1}
      aria-label={`Withheld post ${post.id}`}
      aria-posinset={position}
      aria-setsize={total}
      className="post-row flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm py-3 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[6px]"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <EyeOff aria-hidden="true" className="size-4" />
      </span>
      <p className="min-w-0 flex-1 text-[0.875rem]">
        <span className="text-muted-foreground">Post </span>
        <span className="font-mono text-[0.8125rem]">{post.id}</span>
      </p>
      <OpenOnX url={post.url}>Open on X</OpenOnX>
    </article>
  );
}
