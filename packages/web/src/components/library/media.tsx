"use client";

/**
 * A post's media, as a placeholder until the owner asks for it.
 *
 * Each post, and each quoted post, is one `MediaScope`. Nothing in a scope
 * is loaded from X until the scope is revealed, and a scope is revealed in
 * exactly two ways: the owner presses "Show media" in it, or the owner has
 * turned on the automatic setting and one of its placeholders has stayed on
 * screen for a moment. Until then there is no media element in the page at
 * all, so nothing a browser does ahead of time (preloading, lazy loading,
 * rendering rows that are off screen) can ask X for anything.
 */
import { ImageIcon, Play } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MediaView } from "@/lib/post-view";
import { cn } from "@/lib/utils";
import { AUTO_MEDIA_DWELL_MS } from "@/lib/x-media-policy";
import { useAutoMedia } from "./auto-media.ts";
import { usePinRow } from "./row-memory.tsx";
import { GifPlayer, VideoPlayer } from "./video-player.tsx";
import { XImage, XVideo } from "./x-media-element.tsx";

interface Scope {
  /** The post whose media this is. */
  postId: string;
  revealed: boolean;
  reveal: () => void;
}

const ScopeContext = createContext<Scope>({
  postId: "",
  revealed: false,
  reveal: () => {},
});

/** One post's worth of media: revealed together, and only together. */
export function MediaScope({
  postId,
  children,
}: {
  postId: string;
  children: ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  // A row showing media stays in the page however far the list is scrolled:
  // taken out and drawn again, it would ask X for the same media twice.
  const pin = usePinRow();
  const reveal = useCallback(() => {
    pin();
    setRevealed(true);
  }, [pin]);
  const scope = useMemo(
    () => ({ postId, revealed, reveal }),
    [postId, revealed, reveal],
  );
  return (
    <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
  );
}

/**
 * With the automatic setting on, reveals the scope once this placeholder has
 * been at least half on screen, in a visible tab, for `AUTO_MEDIA_DWELL_MS`.
 * The observer's margin is zero: a placeholder just below the fold is not on
 * screen. Scrolling past one clears its timer, so a quick scroll through the
 * list loads nothing.
 */
function useRevealOnScreen<T extends Element>() {
  const { revealed, reveal } = useContext(ScopeContext);
  const auto = useAutoMedia();
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!auto || revealed || node === null) return;
    let onScreen = false;
    let timer: number | undefined;
    const disarm = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const arm = () => {
      if (!onScreen || document.visibilityState !== "visible") return disarm();
      timer ??= window.setTimeout(reveal, AUTO_MEDIA_DWELL_MS);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries.at(-1)?.isIntersecting === true;
        arm();
      },
      { rootMargin: "0px", threshold: 0.5 },
    );
    observer.observe(node);
    document.addEventListener("visibilitychange", arm);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", arm);
      disarm();
    };
  }, [auto, revealed, reveal]);
  return ref;
}

function KindIcon({ kind }: { kind: MediaView["kind"] }) {
  if (kind === "photo")
    return <ImageIcon aria-hidden="true" className="size-4" />;
  if (kind === "gif") {
    return (
      <span aria-hidden="true" className="font-semibold text-[0.625rem]">
        GIF
      </span>
    );
  }
  // A triangle's weight sits left of its centre.
  return <Play aria-hidden="true" className="size-4 translate-x-px" />;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

function MediaFrame({
  media,
  alone,
  wide,
}: {
  media: MediaView;
  alone: boolean;
  wide: boolean;
}) {
  // Whether the owner has pressed play. Only then is there a video element.
  const [started, setStarted] = useState(false);
  const aspectRatio = alone
    ? clamp(media.aspectRatio ?? 16 / 9, 1, 2.4)
    : wide
      ? 8 / 3
      : 4 / 3;
  const { videoSrc } = media;
  const isVideo = media.kind !== "photo";
  const label = media.alt ?? (isVideo ? "Video" : "Photo");
  const video = (attach: (element: HTMLVideoElement | null) => void) =>
    videoSrc === null ? null : (
      <XVideo
        ref={attach}
        src={videoSrc}
        label={label}
        loop={media.kind === "gif"}
        className="absolute inset-0 size-full object-contain"
      />
    );
  return (
    <div
      className={cn(
        "relative overflow-hidden",
        started ? "bg-black" : "bg-muted",
        wide && "col-span-2",
      )}
      style={{ aspectRatio }}
    >
      {/*
        The poster stays where it is under the player: it is what shows until
        the video's first frame, and behind a video that did not load. Once
        play is pressed it is fitted as the video will be, not cropped.
      */}
      {media.imageSrc !== null ? (
        <XImage
          src={media.imageSrc}
          alt={media.alt ?? ""}
          className={cn(
            "size-full",
            started ? "object-contain" : "object-cover",
          )}
        />
      ) : null}
      {!isVideo || videoSrc === null ? null : !started ? (
        <button
          type="button"
          onClick={() => setStarted(true)}
          className="absolute inset-0 m-auto flex size-12 items-center justify-center rounded-full bg-black/65 text-white outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-black/80 focus-visible:ring-3 focus-visible:ring-ring motion-safe:active:scale-[0.96]"
        >
          <Play aria-hidden="true" className="size-5 translate-x-0.5" />
          <span className="sr-only">
            {media.kind === "gif" ? "Play GIF" : "Play video"}
          </span>
        </button>
      ) : media.kind === "gif" ? (
        <GifPlayer>{video}</GifPlayer>
      ) : (
        <VideoPlayer length={media.duration}>{video}</VideoPlayer>
      )}
      {started ? null : media.kind === "gif" ? (
        <span
          aria-hidden="true"
          className="absolute start-2 bottom-2 rounded-sm bg-black/65 px-1.5 py-0.5 font-semibold text-[0.625rem] text-white leading-normal"
        >
          GIF
        </span>
      ) : media.duration !== null ? (
        <span className="absolute start-2 bottom-2 rounded-sm bg-black/65 px-1.5 py-0.5 font-medium text-white text-xs tabular-nums">
          {media.duration}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A post's photos, videos and GIFs. Unrevealed, it is one row that says what
 * is there and offers to show it; revealed, the media in place.
 */
export function MediaStrip({
  media,
  summary,
}: {
  media: MediaView[];
  summary: string | null;
}) {
  const { postId, revealed, reveal } = useContext(ScopeContext);
  const ref = useRevealOnScreen<HTMLButtonElement>();
  if (media.length === 0) return null;
  const loadable = media.some(
    (item) => item.imageSrc !== null || item.videoSrc !== null,
  );

  if (revealed && loadable) {
    return (
      <div
        className={cn(
          "grid gap-0.5 overflow-hidden rounded-xl in-data-[quoted]:rounded-md",
          media.length > 1 && "grid-cols-2",
        )}
      >
        {media.map((item, index) => (
          <MediaFrame
            // biome-ignore lint/suspicious/noArrayIndexKey: a post's media never reorders, and two can share an address.
            key={index}
            media={item}
            alone={media.length === 1}
            wide={
              media.length > 1 &&
              media.length % 2 === 1 &&
              index === media.length - 1
            }
          />
        ))}
      </div>
    );
  }

  const durations = media
    .map((item) => item.duration)
    .filter((duration) => duration !== null);
  const described = media.filter((item) => item.alt !== null);
  const tiles = (
    <span className="flex shrink-0 gap-1">
      {media.slice(0, 4).map((item, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: as above.
          key={index}
          className="flex size-10 items-center justify-center rounded-sm bg-muted text-muted-foreground"
        >
          <KindIcon kind={item.kind} />
        </span>
      ))}
    </span>
  );
  const caption = (
    <span className="min-w-0 flex-1 text-[0.8125rem] leading-snug">
      <span className="font-medium">{summary}</span>
      {durations.length > 0 ? (
        <span className="text-muted-foreground tabular-nums">
          {" · "}
          {durations.join(", ")}
        </span>
      ) : null}
    </span>
  );
  return (
    <div className="flex flex-col gap-2">
      {loadable ? (
        <button
          ref={ref}
          type="button"
          data-show-media=""
          data-media-of={postId}
          onClick={reveal}
          className="group/strip flex w-full items-center gap-3 rounded-xl border border-dashed p-2 text-start in-data-[quoted]:rounded-md outline-none transition-[background-color,border-color] duration-150 ease-out hover:border-foreground/25 hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
        >
          {tiles}
          {caption}
          <span className="shrink-0 pe-1.5 font-medium text-[0.8125rem] text-muted-foreground group-hover/strip:text-foreground">
            Show media
          </span>
        </button>
      ) : (
        <div className="flex w-full items-center gap-3 rounded-xl border border-dashed p-2 in-data-[quoted]:rounded-md">
          {tiles}
          {caption}
        </div>
      )}
      {described.map((item, index) => (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: as above.
          key={index}
          className="text-[0.8125rem] text-muted-foreground leading-normal"
        >
          <span className="font-medium">Description: </span>
          {item.alt}
        </p>
      ))}
    </div>
  );
}

/**
 * The small picture beside a link card or an article: a placeholder that
 * shows it when pressed, and the picture once its post's media is revealed.
 */
export function PreviewThumb({ src }: { src: string | null }) {
  const { postId, revealed, reveal } = useContext(ScopeContext);
  const ref = useRevealOnScreen<HTMLButtonElement>();
  if (src === null) return null;
  if (revealed) {
    return (
      <XImage
        src={src}
        alt=""
        className="size-18 shrink-0 rounded-sm object-cover"
      />
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      data-show-media=""
      data-media-of={postId}
      onClick={reveal}
      title="Show image"
      className="flex size-18 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground outline-none transition-[background-color,color] duration-150 ease-out hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ImageIcon aria-hidden="true" className="size-4" />
      <span className="sr-only">Show image</span>
    </button>
  );
}
