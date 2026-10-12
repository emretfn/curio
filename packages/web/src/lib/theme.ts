/**
 * Light or dark. The choice is kept in the browser: absent means "follow the
 * system", and `light` or `dark` overrides it. The `dark` class on the root
 * element is what the styles read.
 */
export const THEME_STORAGE_KEY = "x-bookmarks:theme";

/**
 * Runs before the first paint, from the layout, so the page never flashes
 * the wrong theme. `applyTheme` in `components/library/settings.tsx` makes
 * the same decision again when the choice or the system changes.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});document.documentElement.classList.toggle("dark",t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))}catch(e){}})()`;
