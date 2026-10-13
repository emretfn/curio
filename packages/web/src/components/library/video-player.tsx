"use client";

/**
 * The player around a post's video, and the plainer one around a GIF.
 *
 * Neither asks X for anything by itself. The video element is written in the
 * media elements' file and handed in by `media.tsx`, the one file that may
 * render it; this file only drives it. The file is requested when the
 * element appears, which is when the owner pressed play, and again only when
 * the owner presses "Try again" after it failed or hung. Nothing here names
 * an address, reads ahead, or picks among versions of a video. A drag along
 * the timeline seeks once, on release, and not at every place it passes.
 *
 * The controls are the app's own: play and pause, the timeline with the time
 * gone and the whole, speed, mute and volume, full screen. They leave the
 * picture alone while it plays and nothing is pointing at it. The keys are
 * in `src/lib/shortcuts.ts`, and are never the list's. Picture-in-picture is
 * left to the browser's own menu on the video, which a right click still
 * opens.
 */
import {
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  TriangleAlert,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clock } from "@/lib/clock";
import {
  LIST_KEYS,
  type PlayerAction,
  playerAction,
  SEARCH_KEY,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import {
  PLAYBACK_RATES,
  readPlayerSettings,
  writePlayerSettings,
} from "./player-settings.ts";

/** Given to the video element as its `ref`, so the player can drive it. */
export type AttachVideo = (element: HTMLVideoElement | null) => void;

/** With nothing pointing at a playing video, its controls leave after this long. */
const IDLE_MS = 2500;
/** A video that has loaded for this long without playing offers to start over. */
const SLOW_MS = 8000;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** What the element says of itself, as far as the controls show it. */
interface Playback {
  paused: boolean;
  ended: boolean;
  failed: boolean;
  /** Wanting to play, and without the data to. */
  waiting: boolean;
  /** Whether a frame has been shown yet. */
  begun: boolean;
  /** The time gone, in whole seconds. */
  seconds: number;
  /** In seconds, or 0 until the file says. */
  duration: number;
  /** How far the file is loaded past where it plays, 0 to 1. */
  buffered: number;
  volume: number;
  muted: boolean;
  rate: number;
}

// Before the element exists it is on its way: the owner has just pressed play.
const STARTING: Playback = {
  paused: false,
  ended: false,
  failed: false,
  waiting: true,
  begun: false,
  seconds: 0,
  duration: 0,
  buffered: 0,
  volume: 1,
  muted: false,
  rate: 1,
};

function read(video: HTMLVideoElement, begun: boolean): Playback {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  let loaded = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= video.currentTime + 0.5) {
      loaded = Math.max(loaded, video.buffered.end(index));
    }
  }
  const ready = video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  return {
    paused: video.paused,
    ended: video.ended,
    failed: video.error !== null,
    waiting: video.error === null && !video.ended && !video.paused && !ready,
    begun: begun || video.currentTime > 0 || (!video.paused && ready),
    seconds: Math.floor(video.currentTime),
    duration,
    buffered: duration > 0 ? Math.round((loaded / duration) * 100) / 100 : 0,
    volume: video.volume,
    muted: video.muted,
    rate: video.playbackRate,
  };
}

const MEDIA_EVENTS = [
  "play",
  "pause",
  "playing",
  "waiting",
  "canplay",
  "loadeddata",
  "ended",
  "error",
  "emptied",
  "timeupdate",
  "durationchange",
  "seeking",
  "seeked",
  "progress",
  "volumechange",
  "ratechange",
] as const;

/** The element's state, read again whenever it says something changed. */
function usePlayback(video: HTMLVideoElement | null): Playback {
  const [playback, setPlayback] = useState(STARTING);
  useEffect(() => {
    if (video === null) return;
    const sync = () =>
      setPlayback((previous) => {
        const next = read(video, previous.begun);
        return (Object.keys(next) as (keyof Playback)[]).every(
          (key) => next[key] === previous[key],
        )
          ? previous
          : next;
      });
    // Not read at once: the element is about to be told to play, and says
    // so itself a moment later. Until then it is starting.
    for (const event of MEDIA_EVENTS) video.addEventListener(event, sync);
    return () => {
      for (const event of MEDIA_EVENTS) video.removeEventListener(event, sync);
    };
  }, [video]);
  return playback;
}

/**
 * Plays. The promise fails when a pause overtakes it, or when the browser
 * will not play without a press: either way the element stays paused, and
 * the controls say so.
 */
function start(video: HTMLVideoElement): void {
  video.play().catch(() => {});
}

/** After a failure or a hang, by the owner's press: the same address, asked for again. */
function startOver(video: HTMLVideoElement): void {
  video.load();
  start(video);
}

/** The video that is playing with sound. Starting another pauses it. */
let sounding: HTMLVideoElement | null = null;

/** Where along a rail a pointer is, 0 to 1, measured between the thumb's two ends. */
function fractionAt(rail: HTMLElement, clientX: number): number {
  const { left, width } = rail.getBoundingClientRect();
  return clamp((clientX - left - RAIL_INSET) / (width - 2 * RAIL_INSET), 0, 1);
}
/** Half a thumb: the rail's padding, `px-1.5`, so the thumb never overhangs. */
const RAIL_INSET = 6;

// The keyboard's focus, over any picture: a white line with a dark one
// outside it. It is an outline, so a forced-colours mode still draws it.
const FOCUS =
  "outline-0 focus-visible:shadow-[0_0_0_4px_oklch(0_0_0/0.5)] focus-visible:outline-2 focus-visible:outline-white";

// One icon gives way to another: both stay in place and cross-fade. Without
// motion only the fade is left.
const ICON_LAYER =
  "[grid-area:1/1] transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:scale-100 motion-reduce:blur-[0px]";

function Swap<Name extends string>({
  shown,
  icons,
}: {
  shown: Name;
  icons: Record<Name, ReactNode>;
}) {
  return (
    <span aria-hidden="true" className="grid place-items-center">
      {(Object.keys(icons) as Name[]).map((name) => (
        <span
          key={name}
          className={cn(
            ICON_LAYER,
            name === shown
              ? "scale-100 opacity-100 blur-[0px]"
              : "scale-[0.25] opacity-0 blur-[4px]",
          )}
        >
          {icons[name]}
        </span>
      ))}
    </span>
  );
}

function BarButton({
  label,
  title,
  onClick,
  className,
  ref,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  className?: string;
  ref?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      className={cn(
        "pointer-events-auto size-8 shrink-0 items-center justify-center rounded-md transition-[background-color,scale] duration-150 ease-out hover:bg-white/15 focus-visible:bg-white/15 motion-safe:active:scale-[0.96] pointer-coarse:size-10 [&_svg]:size-4",
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The round sign in the middle of the picture: loading, or paused. It is a
 * sign and not a control; the picture under it is what a press reaches.
 */
function Disc({
  sign,
  late,
}: {
  /** What to show, or null for nothing. */
  sign: "loading" | "play" | "replay" | null;
  /** Wait a moment first, so a short pause for data shows nothing. */
  late?: boolean;
}) {
  // While it fades out it keeps the sign it had.
  const last = useRef<"loading" | "play" | "replay">("loading");
  if (sign !== null) last.current = sign;
  const shown = sign ?? last.current;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 m-auto flex @max-[12rem]/player:size-9 size-12 items-center justify-center rounded-full bg-black/65 text-white transition-[opacity,scale] duration-150 ease-out",
        sign === null ? "opacity-0 motion-safe:scale-[0.96]" : "opacity-100",
        sign !== null && late && "delay-300",
      )}
    >
      {shown === "loading" ? (
        <LoaderCircle className="size-5 motion-safe:animate-spin motion-reduce:animate-pulse" />
      ) : shown === "replay" ? (
        <RotateCcw className="size-5" />
      ) : (
        // A triangle's weight sits left of its centre.
        <Play className="size-5 translate-x-0.5" />
      )}
    </span>
  );
}

/** In place of the picture: it did not load, or has been loading too long. */
function Notice({
  failed,
  what,
  onRetry,
}: {
  failed: boolean;
  what: "video" | "GIF";
  onRetry: () => void;
}) {
  return (
    <div
      // A failure is said at once. Slowness is said by the player's status
      // line, which was there before it had anything to say.
      role={failed ? "alert" : undefined}
      data-player-notice={failed ? "failed" : "slow"}
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 p-2 text-center text-white"
    >
      {failed ? (
        <TriangleAlert aria-hidden="true" className="size-5" />
      ) : (
        <LoaderCircle
          aria-hidden="true"
          className="size-5 motion-safe:animate-spin motion-reduce:animate-pulse"
        />
      )}
      <p className="@max-[9rem]/player:sr-only font-medium text-xs">
        {failed
          ? `This ${what} did not load.`
          : `This ${what} is taking a while.`}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          "h-7 rounded-md bg-white/15 px-2.5 font-medium text-xs transition-[background-color,scale] duration-150 ease-out hover:bg-white/25 motion-safe:active:scale-[0.96] pointer-coarse:h-9",
          FOCUS,
        )}
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Whether loading has gone on long enough to offer starting over. Starting
 * over, which `again` does, is given as long again.
 */
function useSlow(waiting: boolean): { slow: boolean; again: () => void } {
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt starts the wait again, though loading never stopped.
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, attempt]);
  const again = useCallback(() => setAttempt((count) => count + 1), []);
  return { slow, again };
}

const RAIL =
  "group/rail relative h-8 min-w-0 cursor-pointer touch-none items-center rounded-md px-1.5 pointer-coarse:h-10";
const THUMB =
  "absolute top-1/2 size-3 -translate-1/2 scale-50 rounded-full bg-white opacity-0 shadow-[0_0_0_1px_oklch(0_0_0/0.15),0_1px_3px_oklch(0_0_0/0.4)] transition-[opacity,scale] duration-150 ease-out group-hover/rail:scale-100 group-hover/rail:opacity-100 group-focus-visible/rail:scale-100 group-focus-visible/rail:opacity-100 group-data-dragging/rail:scale-100 group-data-dragging/rail:opacity-100 motion-reduce:scale-100 pointer-coarse:scale-100 pointer-coarse:opacity-100";
/** A bar as long as its rail, slid left by what is not filled, and cut off by the rail. */
const filled = (part: string): CSSProperties => ({
  translate: `calc((var(${part}, 0) - 1) * 100%) 0`,
});

/**
 * The timeline. Dragging shows where a release would land, by `onPreview`,
 * and the release seeks there, once, by `onSeek`.
 */
function Scrubber({
  railRef,
  duration,
  seconds,
  buffered,
  onPreview,
  onSeek,
}: {
  /** The element whose `--played` the player paints, 0 to 1. */
  railRef: RefObject<HTMLDivElement | null>;
  duration: number;
  seconds: number;
  buffered: number;
  onPreview: (fraction: number | null) => void;
  onSeek: (fraction: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  /** Where the pointer is, 0 to 1, while it is over the rail or dragging. */
  const [pointed, setPointed] = useState<number | null>(null);
  const known = duration > 0;
  const at = (event: ReactPointerEvent<HTMLDivElement>) =>
    fractionAt(event.currentTarget, event.clientX);
  return (
    <div
      ref={railRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(seconds)}
      aria-valuetext={`${clock(seconds)} of ${clock(duration)}`}
      aria-disabled={known ? undefined : true}
      data-scrubber=""
      data-dragging={dragging ? "" : undefined}
      style={{ "--buffered": buffered } as CSSProperties}
      className={cn(
        RAIL,
        FOCUS,
        "pointer-events-auto @[10rem]/player:flex hidden flex-1",
      )}
      onPointerDown={(event) => {
        // The first finger only, and the main button only.
        if (!known || event.button !== 0 || !event.isPrimary) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        setPointed(at(event));
        onPreview(at(event));
      }}
      onPointerMove={(event) => {
        if (dragging) onPreview(at(event));
        if (dragging || event.pointerType === "mouse") setPointed(at(event));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        onSeek(at(event));
        onPreview(null);
        if (event.pointerType !== "mouse") setPointed(null);
      }}
      onPointerCancel={() => {
        setDragging(false);
        onPreview(null);
        setPointed(null);
      }}
      onPointerLeave={() => {
        if (!dragging) setPointed(null);
      }}
    >
      <div className="relative h-1 w-full">
        <div className="absolute inset-0 overflow-hidden rounded-full bg-white/30">
          <div
            className="absolute inset-0 rounded-full bg-white/35"
            style={filled("--buffered")}
          />
          <div
            className="absolute inset-0 rounded-full bg-white"
            style={filled("--played")}
          />
        </div>
        <div
          className={THUMB}
          style={{ left: "calc(var(--played, 0) * 100%)" }}
        />
        {pointed !== null && known ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-full mb-2.5 -translate-x-1/2 rounded-md bg-black/80 px-1.5 py-0.5 font-medium text-[0.6875rem] tabular-nums leading-normal"
            style={{
              left: `clamp(0.75rem, ${pointed * 100}%, calc(100% - 0.75rem))`,
            }}
          >
            {clock(pointed * duration)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** How loud, 0 to 1. Every position a drag passes is set at once: nothing is asked of anyone. */
function VolumeSlider({
  level,
  onLevel,
}: {
  level: number;
  onLevel: (level: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const percent = Math.round(level * 100);
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Volume"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      data-volume=""
      data-dragging={dragging ? "" : undefined}
      style={{ "--played": level } as CSSProperties}
      className={cn(
        RAIL,
        FOCUS,
        "pointer-events-auto @[30rem]/player:flex hidden w-16 shrink-0 pointer-coarse:hidden!",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        onLevel(fractionAt(event.currentTarget, event.clientX));
      }}
      onPointerMove={(event) => {
        if (dragging) onLevel(fractionAt(event.currentTarget, event.clientX));
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    >
      <div className="relative h-1 w-full">
        <div className="absolute inset-0 overflow-hidden rounded-full bg-white/30">
          <div
            className="absolute inset-0 rounded-full bg-white"
            style={filled("--played")}
          />
        </div>
        <div
          className={THUMB}
          style={{ left: "calc(var(--played, 0) * 100%)" }}
        />
      </div>
    </div>
  );
}

/** What the controls do to the element. */
function controlsOf(video: HTMLVideoElement, root: () => HTMLElement | null) {
  const setRate = (rate: number) => {
    // Both, so that loading again after a failure keeps the speed.
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
  };
  const rateIndex = () => {
    const index = PLAYBACK_RATES.indexOf(video.playbackRate);
    return index === -1 ? PLAYBACK_RATES.indexOf(1) : index;
  };
  const setVolume = (level: number) => {
    const volume = clamp(Math.round(level * 100) / 100, 0, 1);
    video.volume = volume;
    video.muted = volume === 0;
  };
  const seekTo = (seconds: number) => {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = clamp(seconds, 0, video.duration);
  };
  const toggle = () => {
    if (video.paused || video.ended) start(video);
    else video.pause();
  };
  const toggleFullscreen = () => {
    const node = root();
    if (node === null) return;
    if (document.fullscreenElement === node) {
      document.exitFullscreen().catch(() => {});
    } else if (typeof node.requestFullscreen === "function") {
      node.requestFullscreen().catch(() => {});
    } else {
      // A phone's Safari fills the screen with the video alone, in its own
      // player, and with nothing else.
      (
        video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
      ).webkitEnterFullscreen?.();
    }
  };
  const toggleMute = () => {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 0.5;
      video.muted = false;
    } else {
      video.muted = true;
    }
  };
  return {
    toggle,
    toggleFullscreen,
    setVolume,
    seekToFraction(fraction: number) {
      seekTo(fraction * video.duration);
    },
    toggleMute,
    /** The next speed, and round to the first after the last. */
    cycleRate() {
      setRate(PLAYBACK_RATES[(rateIndex() + 1) % PLAYBACK_RATES.length] ?? 1);
    },
    startOver() {
      startOver(video);
    },
    perform(action: PlayerAction) {
      switch (action.kind) {
        case "toggle":
          return toggle();
        case "seek-by":
          return seekTo(video.currentTime + action.seconds);
        case "seek-to":
          return seekTo(action.fraction * video.duration);
        case "volume-by":
          return setVolume((video.muted ? 0 : video.volume) + action.amount);
        case "volume-to":
          return setVolume(action.level);
        case "mute":
          return toggleMute();
        case "speed":
          return setRate(
            PLAYBACK_RATES[
              clamp(rateIndex() + action.step, 0, PLAYBACK_RATES.length - 1)
            ] ?? 1,
          );
        case "fullscreen":
          return toggleFullscreen();
      }
    },
  };
}

/**
 * A video with the app's controls. `children` renders the video element,
 * with the `ref` it is given; `length` is the video's length as the capture
 * gave it, shown until the file says.
 */
export function VideoPlayer({
  length,
  children,
}: {
  length: string | null;
  children: (attach: AttachVideo) => ReactNode;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const root = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const playback = usePlayback(video);
  const { slow, again } = useSlow(playback.waiting);
  /** Where a drag along the timeline is, 0 to 1. */
  const [preview, setPreview] = useState<number | null>(null);
  /** Whether a pointer or a key was at the player a moment ago. */
  const [active, setActive] = useState(true);
  /** Whether the keyboard's focus is on one of the controls. */
  const [keyboard, setKeyboard] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const controls = useMemo(
    () => (video === null ? null : controlsOf(video, () => root.current)),
    [video],
  );
  const shown =
    !playback.failed &&
    (playback.paused || active || keyboard || preview !== null);
  const shownNow = useRef(shown);
  shownNow.current = shown;

  const idle = useRef<number | undefined>(undefined);
  const poke = useCallback(() => {
    setActive(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(function rest() {
      // Not from under a pointer that rests on them.
      if (bar.current?.matches(":hover")) {
        idle.current = window.setTimeout(rest, IDLE_MS);
        return;
      }
      setActive(false);
    }, IDLE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(idle.current);
  }, [poke]);

  // The element has just appeared, because the owner pressed play: set it as
  // they last had a player, play, and put focus on the controls, where the
  // button they pressed was.
  useEffect(() => {
    if (video === null) return;
    const settings = readPlayerSettings();
    video.volume = settings.volume;
    video.muted = settings.muted;
    video.defaultPlaybackRate = settings.rate;
    video.playbackRate = settings.rate;
    const remember = () =>
      writePlayerSettings({
        volume: video.volume,
        muted: video.muted,
        rate: video.playbackRate,
      });
    const alone = () => {
      if (sounding !== null && sounding !== video) sounding.pause();
      sounding = video;
    };
    video.addEventListener("volumechange", remember);
    video.addEventListener("ratechange", remember);
    video.addEventListener("play", alone);
    start(video);
    playButton.current?.focus({ preventScroll: true });
    return () => {
      video.removeEventListener("volumechange", remember);
      video.removeEventListener("ratechange", remember);
      video.removeEventListener("play", alone);
      if (sounding === video) sounding = null;
    };
  }, [video]);

  // The filled part of the timeline follows the picture frame by frame,
  // written straight to the rail: the time beside it changes once a second.
  useEffect(() => {
    if (video === null) return;
    const paint = () => {
      const played =
        preview ??
        (video.duration > 0 ? video.currentTime / video.duration : 0);
      rail.current?.style.setProperty("--played", String(clamp(played, 0, 1)));
    };
    paint();
    // While it is paused, a seek or the length arriving still moves it.
    const moved = ["timeupdate", "seeked", "durationchange"] as const;
    for (const event of moved) video.addEventListener(event, paint);
    let frame = 0;
    if (!playback.paused && preview === null) {
      frame = requestAnimationFrame(function follow() {
        paint();
        frame = requestAnimationFrame(follow);
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      for (const event of moved) video.removeEventListener(event, paint);
    };
  }, [video, preview, playback.paused]);

  // Keys and presses, heard on the player itself and not on the document,
  // so that they are handled here before the list's own listener sees them.
  useEffect(() => {
    const node = root.current;
    if (node === null || video === null || controls === null) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = playerAction(
        event,
        target?.closest("[data-volume]")
          ? "volume"
          : target?.tagName === "BUTTON"
            ? "button"
            : "player",
      );
      if (action === null) {
        if (
          document.fullscreenElement === node &&
          (LIST_KEYS.includes(event.key.toLowerCase()) ||
            event.key === SEARCH_KEY)
        ) {
          // Behind a video that fills the screen there is no list to move in.
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      controls.perform(action);
      poke();
    };
    // A press on the picture plays or pauses. A finger's tap on a picture
    // whose controls have left only brings them back: there is no pointer to
    // move over them first. Whether they had left is noted as the press
    // begins, before it wakes them.
    let byMouse = true;
    let wasHidden = false;
    const onPointer = (event: PointerEvent) => {
      byMouse = event.pointerType === "mouse";
      wasHidden = !shownNow.current;
    };
    const onPress = () => {
      poke();
      if (!byMouse && wasHidden) return;
      controls.toggle();
      playButton.current?.focus({ preventScroll: true });
    };
    // Twice with a mouse fills the screen. Two taps of a finger are two taps.
    const onDouble = () => {
      if (byMouse) controls.toggleFullscreen();
    };
    const onFullscreen = () =>
      setFullscreen(document.fullscreenElement === node);
    node.addEventListener("keydown", onKey);
    video.addEventListener("click", onPress);
    video.addEventListener("dblclick", onDouble);
    video.addEventListener("pointerdown", onPointer);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      video.removeEventListener("pointerdown", onPointer);
      node.removeEventListener("keydown", onKey);
      video.removeEventListener("click", onPress);
      video.removeEventListener("dblclick", onDouble);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [video, controls, poke]);

  const elapsed =
    preview !== null && playback.duration > 0
      ? preview * playback.duration
      : playback.seconds;
  const total =
    playback.duration > 0 ? clock(playback.duration) : (length ?? "0:00");
  const level = playback.muted ? 0 : playback.volume;
  const loading = playback.waiting && !slow;
  const noticed = playback.failed || slow;

  return (
    <section
      ref={root}
      aria-label="Video player"
      data-player="video"
      data-playing={playback.paused ? undefined : ""}
      className={cn(
        "@container/player absolute inset-0 select-none overflow-hidden text-white [-webkit-tap-highlight-color:transparent] [&:fullscreen]:bg-black",
        playback.begun && "bg-black",
        !shown && !playback.failed && "cursor-none",
      )}
      onPointerMove={poke}
      onPointerDown={poke}
      onFocus={(event) => {
        setKeyboard(event.target.matches(":focus-visible"));
        poke();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setKeyboard(false);
        }
      }}
    >
      {children(setVideo)}
      <Disc
        sign={
          noticed || preview !== null
            ? null
            : loading
              ? "loading"
              : playback.ended
                ? "replay"
                : playback.paused
                  ? "play"
                  : null
        }
        late={loading && playback.begun}
      />
      <span role="status" className="sr-only">
        {loading
          ? "Loading video"
          : slow && !playback.failed
            ? "This video is taking a while."
            : ""}
      </span>
      {noticed && controls !== null ? (
        <Notice
          failed={playback.failed}
          what="video"
          onRetry={() => {
            again();
            controls.startOver();
            // The button that was pressed is about to go.
            playButton.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      <div
        ref={bar}
        dir="ltr"
        data-controls={shown ? "shown" : "hidden"}
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-linear-to-t from-black/75 via-black/35 to-transparent px-1.5 pt-8 pb-1.5 transition-opacity duration-200 ease-out",
          shown ? "opacity-100" : "opacity-0 *:pointer-events-none!",
        )}
      >
        <BarButton
          ref={playButton}
          label={playback.ended ? "Replay" : playback.paused ? "Play" : "Pause"}
          title={`${playback.ended ? "Replay" : playback.paused ? "Play" : "Pause"} (Space)`}
          onClick={() => controls?.toggle()}
          className="flex"
        >
          <Swap
            shown={
              playback.ended ? "replay" : playback.paused ? "play" : "pause"
            }
            icons={{
              play: <Play className="translate-x-px" />,
              pause: <Pause />,
              replay: <RotateCcw />,
            }}
          />
        </BarButton>
        <span
          data-player-time=""
          className="pointer-events-auto @[14rem]/player:block hidden shrink-0 px-1 font-medium text-xs tabular-nums"
        >
          {clock(elapsed)}
          <span className="@[22rem]/player:inline hidden text-white/70">
            {" / "}
            {total}
          </span>
        </span>
        <Scrubber
          railRef={rail}
          duration={playback.duration}
          seconds={elapsed}
          buffered={playback.buffered}
          onPreview={setPreview}
          onSeek={(fraction) => controls?.seekToFraction(fraction)}
        />
        <span className="@[10rem]/player:hidden flex-1" />
        <BarButton
          label={`Playback speed, ${playback.rate}×`}
          title="Playback speed (< and >)"
          onClick={() => controls?.cycleRate()}
          className="@[22rem]/player:flex hidden w-auto min-w-10 px-1.5 font-semibold text-xs tabular-nums pointer-coarse:w-auto pointer-coarse:min-w-11"
        >
          {playback.rate}×
        </BarButton>
        <BarButton
          label={level === 0 ? "Unmute" : "Mute"}
          onClick={() => controls?.toggleMute()}
          className="@[12rem]/player:flex hidden"
        >
          <Swap
            shown={level === 0 ? "off" : level < 0.5 ? "low" : "high"}
            icons={{
              off: <VolumeX />,
              low: <Volume1 />,
              high: <Volume2 />,
            }}
          />
        </BarButton>
        <VolumeSlider
          level={level}
          onLevel={(next) => controls?.setVolume(next)}
        />
        <BarButton
          label={fullscreen ? "Exit full screen" : "Full screen"}
          title={`${fullscreen ? "Exit full screen" : "Full screen"} (F)`}
          onClick={() => controls?.toggleFullscreen()}
          className="flex"
        >
          <Swap
            shown={fullscreen ? "exit" : "enter"}
            icons={{ enter: <Maximize />, exit: <Minimize /> }}
          />
        </BarButton>
      </div>
    </section>
  );
}

/**
 * A GIF: on X a short silent video that repeats, and here it behaves like
 * one. No controls and no sound; a press on it pauses it, and another plays
 * it again.
 */
export function GifPlayer({
  children,
}: {
  children: (attach: AttachVideo) => ReactNode;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const playback = usePlayback(video);
  const { slow, again } = useSlow(playback.waiting);
  useEffect(() => {
    if (video === null) return;
    start(video);
    button.current?.focus({ preventScroll: true });
  }, [video]);
  const noticed = playback.failed || slow;
  return (
    <div
      data-player="gif"
      data-playing={playback.paused ? undefined : ""}
      className={cn(
        "@container/player absolute inset-0 select-none overflow-hidden text-white",
        playback.begun && "bg-black",
      )}
    >
      {children(setVideo)}
      <button
        ref={button}
        type="button"
        aria-label={playback.paused ? "Play GIF" : "Pause GIF"}
        onClick={() => {
          if (video === null) return;
          if (video.paused) start(video);
          else video.pause();
        }}
        className="absolute inset-0 cursor-pointer outline-0 [-webkit-tap-highlight-color:transparent] focus-visible:shadow-[inset_0_0_0_5px_oklch(0_0_0/0.5)] focus-visible:outline-3 focus-visible:outline-white focus-visible:-outline-offset-3"
      >
        <Disc
          sign={
            noticed
              ? null
              : playback.waiting
                ? "loading"
                : playback.paused
                  ? "play"
                  : null
          }
          late={playback.waiting && playback.begun}
        />
        <span
          aria-hidden="true"
          className="absolute start-2 bottom-2 rounded-sm bg-black/65 px-1.5 py-0.5 font-semibold text-[0.625rem] leading-normal"
        >
          GIF
        </span>
      </button>
      <span role="status" className="sr-only">
        {!playback.waiting || playback.failed
          ? ""
          : slow
            ? "This GIF is taking a while."
            : "Loading GIF"}
      </span>
      {noticed && video !== null ? (
        <Notice
          failed={playback.failed}
          what="GIF"
          onRetry={() => {
            again();
            startOver(video);
            button.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}
