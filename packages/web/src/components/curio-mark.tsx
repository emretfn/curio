/**
 * The mark, beside the app's name: a cabinet of curiosities with something
 * bright kept in one compartment. The shapes are those of the app's icon,
 * `src/app/icon.svg`, which the extension's toolbar icon is rendered from
 * too; `curio-mark.test.ts` holds this copy to that file. It is drawn here
 * and not loaded, because a page of this app holds no image element but the
 * ones a post's media is shown in (X-8).
 */
export function CurioMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <rect x="2" y="12" width="2" height="3" rx="0.5" fill="#2563c9" />
      <rect x="12" y="12" width="2" height="3" rx="0.5" fill="#2563c9" />
      <rect x="1" y="1" width="14" height="12" rx="2" fill="#2563c9" />
      <rect x="3" y="3" width="3" height="3" rx="0.75" fill="#ffffff" />
      <rect x="7" y="3" width="6" height="3" rx="0.75" fill="#ffffff" />
      <rect x="3" y="7" width="6" height="4" rx="0.75" fill="#ffffff" />
      <rect x="10" y="7" width="3" height="4" rx="0.75" fill="#f7b83d" />
    </svg>
  );
}
