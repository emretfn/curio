/**
 * Small parts the digest's sections share: a section with its heading, a
 * command to copy from, and the line that stands for a post where the
 * digest points at one.
 *
 * A post is drawn once on the page, in the week's list, by the library's own
 * `PostItem`. Everywhere else it is a reference: who wrote it and how it
 * opens, as a link to where it stands in that list.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PostReference } from "@/server/digest";

/** Where a post stands in the week's list. */
export const postAnchor = (postId: string) => `post-${postId}`;

export function Section({
  id,
  title,
  aside,
  className,
  children,
  ...rest
}: {
  id: string;
  title: string;
  /** A short note at the heading's end: a count, as a rule. */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn("flex flex-col gap-4", className)}
      {...rest}
    >
      <div className="flex items-baseline justify-between gap-4 border-b py-2.5">
        <h2 id={id} className="font-semibold text-[0.9375rem] leading-snug">
          {title}
        </h2>
        {aside !== undefined ? (
          <p className="shrink-0 text-[0.8125rem] text-muted-foreground tabular-nums">
            {aside}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A command to run in a terminal, with what it does beside it. */
export function Command({
  children,
  does,
}: {
  children: string;
  does: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[0.8125rem] text-muted-foreground">{does}</p>
      {/* On a narrow screen the command wraps, and only between its
          words: a flag broken at its hyphen reads as two. Copied, it is
          the same one line. */}
      {/* Its corners follow the card's: the card's radius less its padding. */}
      <pre className="whitespace-pre-wrap rounded-[calc(var(--radius-xl)-(--spacing(3)))] bg-muted px-2.5 py-2 font-mono text-[0.8125rem] leading-normal">
        <code>
          {children.split(" ").flatMap((word, index) => [
            index === 0 ? "" : " ",
            // biome-ignore lint/suspicious/noArrayIndexKey: the words of one constant command, in order.
            <span key={index} className="whitespace-nowrap">
              {word}
            </span>,
          ])}
        </code>
      </pre>
    </div>
  );
}

/**
 * A post the digest points at. Its opening is one line here; the whole
 * post is where the link leads, further down the page.
 */
export function Reference({ post }: { post: PostReference }) {
  const line = (
    <>
      <bdi className="shrink-0 font-medium">{post.author}</bdi>
      {/* One line where the link leads to the whole post. Where there is
          nowhere to lead, the opening is shown whole: it is a line or two. */}
      <span
        dir="auto"
        className={cn(
          "min-w-0 text-muted-foreground transition-colors duration-150 ease-out group-hover/reference:text-foreground",
          post.listed ? "truncate" : "break-words",
        )}
      >
        {post.opening}
      </span>
    </>
  );
  const row =
    "flex min-w-0 items-baseline gap-2 py-1 text-[0.8125rem] leading-snug";
  if (!post.listed) {
    // No longer in the week's list: removed on X since the digest was
    // written. The library still holds it; there is nowhere here to lead.
    return (
      <p className={cn(row, "flex-wrap")}>
        {line}
        <span className="shrink-0 text-muted-foreground text-xs">
          Removed on X since, so not listed below
        </span>
      </p>
    );
  }
  return (
    <a
      href={`#${postAnchor(post.id)}`}
      data-reference={post.id}
      className={cn(
        row,
        "group/reference -mx-1.5 rounded-sm px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {line}
      <span className="sr-only">(jumps to the post below)</span>
    </a>
  );
}

export function References({ posts }: { posts: readonly PostReference[] }) {
  if (posts.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {posts.map((post) => (
        <li key={post.id} className="min-w-0">
          <Reference post={post} />
        </li>
      ))}
    </ul>
  );
}
