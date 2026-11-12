/**
 * Font family names — Teros Design System v0.2.6 (relaja, October 2026).
 *
 * Saans / Prody are commercial typefaces, licensed — the .otf files are
 * self-hosted in `public/fonts/` and declared via `@font-face` in
 * `app/+html.tsx` and `public/index.html`. Reddit Mono is free and loads
 * from Google Fonts. React Native Web resolves `fontFamily` by these
 * literal names, so components reference the constants below instead of
 * hardcoding the strings.
 *
 * Brand rule: weight 400 everywhere — hierarchy comes from size, never
 * from bold. Saans Medium (500) and SemiBold (600) files are hosted for
 * completeness; no brand style uses them yet.
 */

import { Platform } from "react-native"

/** Primary UI typeface — Saans (400, plus 500/600 hosted). */
export const FONT_SANS = "Saans"

/** Editorial serif for headlines — Prody (400 only). */
export const FONT_SERIF = "Prody"

/** Monospace for ids, versions, counters — Reddit Mono (400, self-hosted). */
export const FONT_MONO = "Reddit Mono"

/** Reading serif for message prose — Ivory Light (300), as the prototype:
 *  headlines in Prody, the agent's running text in Ivory. ONE family name,
 *  not a list: RenderHtml's CSS processor keeps only the first family it
 *  finds in `systemFonts`. The trial Ivory build only draws letters, digits
 *  and the apostrophe, so the @font-face (app/+html.tsx) declares Prody
 *  under the same "Ivory" name for every other glyph via unicode-range.
 *  Native has no Ivory face and keeps Prody. */
export const FONT_SERIF_TEXT = Platform.OS === "web" ? "Ivory" : "Prody"
