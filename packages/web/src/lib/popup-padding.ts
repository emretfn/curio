/**
 * How far a popup keeps from the edges of the window.
 *
 * The page keeps a band at its top clear whenever it brings something into
 * view, for the bar that stays there: `scroll-padding-block-start` in
 * `globals.css`. A browser holds to that for whatever takes the keyboard,
 * and a menu's first entry takes it as the menu opens. A menu laid over the
 * band, as one is in a short window, therefore had the page scroll under it
 * the moment it opened, and the control it hangs from went off the screen.
 * So a popup stays out of the band: it is placed, and made no taller than
 * fits, below it.
 */

/** What a popup keeps from an edge that has nothing on it. Base UI's own default. */
const EDGE_PX = 5;

export interface PopupPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The padding for a page whose computed `scroll-padding-top` is `band`: a length in pixels, or `auto`. */
export function paddingClearOf(band: string): PopupPadding {
  const top = Number.parseFloat(band);
  return {
    top: Number.isFinite(top) && top > EDGE_PX ? top : EDGE_PX,
    right: EDGE_PX,
    bottom: EDGE_PX,
    left: EDGE_PX,
  };
}

/** The padding for this page as it is styled now. Read as a popup opens, in the browser. */
export function popupPadding(): PopupPadding {
  return paddingClearOf(
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement).scrollPaddingTop,
  );
}
