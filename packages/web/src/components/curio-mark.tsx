/**
 * The mark, beside the app's name: an open C holding a single dot, on its
 * tile. The shapes are those of the app's icon, `src/app/icon.svg`, which
 * the extension's toolbar icon is rendered from too; `curio-mark.test.ts`
 * holds this copy to that file.
 *
 * It keeps its tile here and does not take the text's colour, in light and
 * in dark alike, so that the tab, the toolbar, the popup and this column all
 * show one thing. The dot is the reason: it is lit against the tile's ink,
 * and on a white page it would all but vanish. On a dark surface the tile
 * sinks into it, and what is left is the C and its dot.
 *
 * It is drawn here and not loaded, because a page of this app holds no image
 * element but the ones a post's media is shown in (X-8).
 */
export function CurioMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <rect width="16" height="16" rx="4" fill="#171717" />
      <path
        d="M13.657 6A6 6 0 1 0 13.657 10H11.464A4 4 0 1 1 11.464 6Z"
        fill="#fafafa"
      />
      <circle cx="8" cy="8" r="2" fill="#fcdd5b" />
    </svg>
  );
}
