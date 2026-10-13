/**
 * The week's posts, newest saved first, under the day each was saved on.
 * Each is the library's own `PostItem`: the same post, the same media rules
 * (nothing is asked of X until the owner asks, X-7), the same links.
 *
 * The whole week is in the page, where the library's list draws only the
 * rows near the screen: a week is tens of posts, and the summary above
 * points at them by address, which needs each to be there.
 */
import { PostItem } from "@/components/library/post-item";
import type { PostView } from "@/lib/post-view";
import { dayHeading, dayKey } from "@/lib/week-label";
import { postAnchor } from "./parts.tsx";

export function WeekPosts({
  posts,
}: {
  posts: readonly { view: PostView; savedOn: Date }[];
}) {
  const days: { key: string; label: string; posts: PostView[] }[] = [];
  for (const { view, savedOn } of posts) {
    const key = dayKey(savedOn);
    const day = days.at(-1);
    if (day?.key === key) day.posts.push(view);
    else days.push({ key, label: dayHeading(savedOn), posts: [view] });
  }
  let position = 0;
  return (
    <div data-testid="digest-posts" className="flex flex-col">
      {days.map((day) => (
        <section key={day.key} aria-label={`Saved on ${day.label}`}>
          <h3 className="sticky top-(--header-height) z-10 -mx-1 border-b bg-background/90 px-1 py-2 font-medium text-[0.8125rem] text-muted-foreground backdrop-blur-sm">
            <time dateTime={day.key}>{day.label}</time>
          </h3>
          {day.posts.map((post) => {
            position += 1;
            return (
              // The line that ends a post is this row's, which has square
              // corners. The post a reference led to is marked inside it.
              <div key={post.id} className="border-b">
                <div
                  id={postAnchor(post.id)}
                  className="-mx-3 scroll-mt-24 rounded-lg px-3 target:bg-muted/60"
                >
                  <PostItem
                    post={post}
                    position={position}
                    total={posts.length}
                  />
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
