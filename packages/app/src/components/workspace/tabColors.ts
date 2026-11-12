/**
 * Shared tab color tokens — the single source for the tab strip palette,
 * used by both the desktop TilingContainer and the MobileTilingLayout so
 * both surfaces render the same color system in light AND dark.
 */

import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors, surface } from "../mca/primitives/colors"

// Adaptive tab colors — built from theme tokens
/**
 * Composite a semi-transparent rgba color over an opaque hex background.
 * Returns an opaque hex color. Eliminates transparency headaches in SVG/tab rendering.
 */
export function compositeOver(rgba: string, bg: string): string {
  const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (!m) return rgba
  const r = Number(m[1]), g = Number(m[2]), b = Number(m[3])
  const a = m[4] !== undefined ? Number(m[4]) : 1
  if (a >= 1) return rgba
  const bm = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!bm) return rgba
  const br = parseInt(bm[1], 16), bg2 = parseInt(bm[2], 16), bb = parseInt(bm[3], 16)
  const rr = Math.round(r * a + br * (1 - a))
  const rg = Math.round(g * a + bg2 * (1 - a))
  const rb = Math.round(b * a + bb * (1 - a))
  return `#${rr.toString(16).padStart(2, "0")}${rg.toString(16).padStart(2, "0")}${rb.toString(16).padStart(2, "0")}`
}

export function buildTabColors(c: ReturnType<typeof useColors>) {
  const isDark = c.bgPage === surface.dark.bgPage
  // The strip is the RECESS the tabs sit in — the page under the inner veil,
  // one veil darker than the canvas, in BOTH themes. It is window chrome, a
  // thin band: the island's surface itself never goes darker than the page.
  const tabBar = compositeOver(c.bgInner, c.bgPage)
  // One veil under the card — the dormant-pane tone in dark, reused by the
  // inactive-tab hover so both read as the same "surface waking up" step.
  const underCard = compositeOver(c.bgInner, c.bgCard)
  return {
    // Active tab + content are ONE card — no border anywhere: the shape is
    // the fill, and the wings carry the curve by contrast with the strip.
    active: {
      background: c.bgCard,
      tabText: c.text,
    },
    // Dormant container: its CONTENT stays one fill step below the card —
    // in light that's bgSurface (Main/100, already distinct from the white
    // card); in dark bgSurface EQUALS the card (#342F3D), so the dormant
    // pane must drop a veil below the card instead. Quiet text until
    // focus; the active/dormant difference lives in the fill step and the
    // text step, not in the pane shape.
    inactive: {
      background: isDark ? underCard : c.bgSurface,
      tabText: c.text3,
    },
    // Tab bar: the recessed strip behind the tabs
    tabBar,
    // Inactive tabs: a HAIR lighter than the strip — a weak white veil lifts
    // them just off the recess so they read as tabs at rest: strip <
    // inactive < active card. The alpha is per-theme: dark's strip has lots
    // of headroom (0.03 ≈ +7/channel); light's strip is already near-white
    // so the same perceptual hair needs 0.25 (≈ +5/channel). 0.015 was
    // invisible in both.
    inactiveTab: compositeOver(
      isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.25)',
      tabBar,
    ),
    inactiveTabText: c.text3,
    // Hover backgrounds for strip buttons — dark rises to the card step;
    // light presses one step down (bgCardHover equals the strip there and
    // would be invisible)
    hoverBg: isDark ? c.bgCard : c.bgPage,
    // Icon color for tab bar buttons (grip, nav, close, menu)
    iconDim: c.text3,
    iconMid: c.text2,
    // Menu popover
    menuBg: c.bgCard,
    menuBorder: c.borderStrong,
    menuHover: c.bgCardHover,
    menuSeparator: c.borderStrong,
    // Empty pane text
    emptyText: c.text3,
    emptySubtext: c.text3,
    // Close button hover — same step as the other strip buttons
    closeHover: isDark ? c.bgCard : c.bgPage,
    // Inactive tab hover — rises one quiet step from the strip: a veil under
    // the card (dark, the dormant-pane tone) / bgSurface (light)
    inactiveTabHover: isDark ? underCard : c.bgSurface,
    // Ghost drag image — a card in flight
    ghostBg: c.bgCard,
    ghostBorder: c.border,
    ghostText: c.text,
    // Drop zone accent — Purple/300 with its own alpha steps (was cyan
    // #06B6D4, then the pre-relaja indigo #5E6AD2 whose rgba literals
    // outlived the fill they were meant to match)
    dropAccent: semanticColors.purple300,
    dropAccentBg: semanticColors.purpleGlow,
    dropAccentBgSubtle: 'rgba(111,39,255,0.10)',
    dropAccentBorder: 'rgba(111,39,255,0.5)',
    // Tab-strip loading dot — the theme's accent role (Purple/200 dark /
    // Purple/300 light). `dropAccent` stays Purple/300 for the DROP ZONE
    // (deliberate), but the strip's spinner rides the recess in both themes
    // and needs the theme step (bug 2026-10-06: fixed Purple/300 rode only
    // 2.76:1 on the dark strip).
    spinnerAccent: c.accent,
    // Status dots
    redDot: semanticColors.red,
    blueDot: semanticColors.purple300,
    // Lock icon on active tab
    lockActive: semanticColors.purple300,
    // Lock icon on inactive tab
    lockInactive: c.text3,
  }
}

export type TabColors = ReturnType<typeof buildTabColors>
