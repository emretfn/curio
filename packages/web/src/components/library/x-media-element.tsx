"use client";

/**
 * The only two elements in the app that make the browser ask another host
 * for something: a picture and a video on X's media CDN. X-7 to X-11 in
 * CODING_STANDARDS.md say when they may exist, and `media.tsx` is the only
 * file that renders them, after the owner has asked.
 *
 * Each request is as plain as an element can make it:
 * - `crossOrigin="anonymous"` sends no cookie and no stored credential;
 * - `referrerPolicy="no-referrer"`, and the page's own policy, send no
 *   Referer;
 * - there is no `loading`, `srcSet`, `poster` or `preload` hint: the browser
 *   asks for exactly the one address, when the element appears, and for a
 *   video only once it is told to play.
 *
 * The video has no controls of the browser's. `video-player.tsx` puts the
 * app's own around it and drives it through its `ref`; it adds no request.
 *
 * The address comes from `xMediaUrl`, which admits two hosts, and the page's
 * Content-Security-Policy refuses any other.
 */
import { ImageOff } from "lucide-react";
import { type Ref, useState } from "react";
import { cn } from "@/lib/utils";

function DidNotLoad({ className }: { className?: string | undefined }) {
  return (
    <span
      className={cn(
        "flex size-full min-h-16 flex-col items-center justify-center gap-1 bg-muted p-2 text-center text-muted-foreground text-xs",
        className,
      )}
    >
      <ImageOff aria-hidden="true" className="size-4" />
      Did not load
    </span>
  );
}

/** A picture from X's image CDN. It exists only once the owner has asked for it. */
export function XImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <DidNotLoad className={className} />;
  return (
    // biome-ignore lint/performance/noImgElement: Next's image component would have this app's server request the picture from X, which X-10 forbids. The browser asks for it, once, when the owner does.
    <img
      data-x-media="image"
      src={src}
      alt={alt}
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("image-outline", className)}
    />
  );
}

/**
 * A video from X's video CDN, playing. It is rendered only when the owner
 * presses play, which is why it starts at once: until then there is no
 * element, and so no request. What it shows while it loads, and when it
 * fails, is the player's to say.
 */
export function XVideo({
  ref,
  src,
  label,
  loop,
  className,
}: {
  ref: Ref<HTMLVideoElement>;
  src: string;
  label: string;
  /** A GIF on X is a short silent video that repeats. */
  loop: boolean;
  className?: string | undefined;
}) {
  return (
    <video
      ref={ref}
      data-x-media="video"
      src={src}
      aria-label={label}
      crossOrigin="anonymous"
      autoPlay
      playsInline
      loop={loop}
      muted={loop}
      tabIndex={-1}
      className={cn("image-outline", className)}
    />
  );
}
