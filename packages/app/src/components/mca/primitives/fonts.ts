/**
 * Font family names for the MCA catalog redesign (TER-523).
 *
 * The font files load on web via the Google Fonts `<link>` injected in
 * `public/index.html` (DM Sans / Newsreader / JetBrains Mono). React Native
 * Web resolves `fontFamily` by these literal names, so components reference
 * the constants below instead of hardcoding the strings.
 *
 * Native note: on iOS/Android the families fall back to the system font until
 * bundled via expo-font. This is intentional — Teros ships as a PWA and the
 * catalog smoke runs on web, where the `<link>` gives pixel-parity with the
 * mockups (docs/mcas/catalog-*.html).
 */

/** Primary UI typeface — DM Sans (weights 300/400/500/600). */
export const FONT_SANS = 'DM Sans';

/** Editorial serif for long-form description copy — Newsreader (300/400). */
export const FONT_SERIF = 'Newsreader';

/** Monospace for ids, versions, counters — JetBrains Mono (400/500). */
export const FONT_MONO = 'JetBrains Mono';
