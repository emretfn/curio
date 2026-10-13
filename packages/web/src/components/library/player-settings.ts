/**
 * What the owner last chose in a video player, kept in this browser so the
 * next video starts the same way: how loud, whether muted, and how fast.
 * The server never sees it.
 */
export interface PlayerSettings {
  /** 0 to 1. */
  volume: number;
  muted: boolean;
  /** One of `PLAYBACK_RATES`. */
  rate: number;
}

/** The speeds on offer, slowest first. Normal speed is among them. */
export const PLAYBACK_RATES: readonly number[] = [1, 1.25, 1.5, 2];

const STORAGE_KEY = "curio:player";
const DEFAULTS: PlayerSettings = { volume: 1, muted: false, rate: 1 };

/** The stored choices, or the defaults for whatever is missing or not believable. */
export function readPlayerSettings(): PlayerSettings {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    if (typeof stored !== "object" || stored === null) return DEFAULTS;
    const { volume, muted, rate } = stored as Record<string, unknown>;
    return {
      volume:
        typeof volume === "number" && volume >= 0 && volume <= 1
          ? volume
          : DEFAULTS.volume,
      muted: typeof muted === "boolean" ? muted : DEFAULTS.muted,
      rate:
        typeof rate === "number" && PLAYBACK_RATES.includes(rate)
          ? rate
          : DEFAULTS.rate,
    };
  } catch {
    // Storage refused, or holds something else: the defaults.
    return DEFAULTS;
  }
}

export function writePlayerSettings(settings: PlayerSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage refused: nothing to remember.
  }
}
