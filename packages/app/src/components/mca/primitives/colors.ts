// MCA renderer color tokens — v2 (Renderer UX Guide, May 2026).
//
// Two layers:
//   • surface  — theme-adaptive (light + dark). Read via `useColors()`.
//   • semantic — theme-agnostic brand colors (indigo, green, amber, red,
//                violet, orange). Read directly from `colors`.
//
// Backwards compatibility: every legacy key (`success`, `running`, `failed`,
// `bgCard`, `border`, `primary`, `secondary`, `muted`, `bright`, `chevron`,
// `accent*`, `kind*`, etc.) is preserved as a compatibility shim mapped to
// the new dark-mode set so the 70+ existing renderers keep compiling. New
// renderers should prefer the v2 names (`text`, `text2`, `text3`, `bgPage`,
// `bgCardHover`, `borderStrong`, `indigo`, `green`, `amber`, `red`, `violet`,
// `orange`).

import type { MCACategory } from "@teros/shared"

export type Theme = "dark" | "light"

// ─── Status (5 states, guide §3) ────────────────────────────────────────────
// Includes `pending` (orange, no pulse). The legacy 4-state union remains a
// subset to keep older code paths (StatusDot, etc.) compiling unchanged.
export type McaStatusType =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "pending_permission"
  | "pending_user_input"

// ─── Semantic palette (theme-agnostic) ──────────────────────────────────────
// DS v0.2.6 (relaja): the brand ramps. `main` is the neutral spine, `purple`
// the accent, mint/yellow/pink the Essentials. Status colors live in the
// status ramps below (green/amber/red off-palette on purpose, info = purple).
const semantic = {
  // ── Main ramp — the neutral spine ──
  main100: "#FAF9FC",
  main200: "#F2F0F7",
  main300: "#E5DFEF",
  main400: "#CFC5E2",
  main500: "#968FA7",
  main600: "#797386",
  main700: "#575263",
  main800: "#342F3D",
  main900: "#201C27",

  // ── Purple — the accent ramp ──
  purple100: "#E7DCFF",
  purple200: "#9C6BFF",
  purple300: "#6F27FF",
  purple500: "#1C0252",
  purpleGlow: "rgba(111,39,255,0.15)",

  // ── Mint ──
  mint100: "#B9FFF0",
  mint200: "#1EFFCE",
  mint300: "#00D1A3",
  mint400: "#096A55",
  mint500: "#003E31",
  mintGlow: "rgba(30,255,206,0.15)",

  // ── Yellow ──
  yellow200: "#FFFFB0",
  yellow300: "#E8E863",
  yellow400: "#747449",

  // ── Pink ──
  pink200: "#FFD2D2",
  pink300: "#FF8181",
  pink400: "#944343",

  // ── Avatar entity ring (DS v0.2.6 OS layer, R18) ──
  // Humans take the four Essentials as a closed conic ring. Web only —
  // React Native has no conic-gradient; native humans fall back to Mint/200
  // (the DS's own external signal, and the closest single-colour stand-in
  // for the Essentials) until a gradient path exists.
  avatarRingHuman: "conic-gradient(from 200deg, #1EFFCE, #6F27FF, #FFFFB0, #9C6BFF, #1EFFCE)",

  // ── Status (off-palette on purpose — see DS colors.status) ──
  green: "#1CA24D",
  amber: "#F59E0B",
  red: "#EF4444",
  orange: "#F97316",

  // ── Legacy aliases (pre-relaja names → brand ramp steps) ──────────────────
  // The accent moved indigo → Purple. Old names keep compiling and now draw
  // the brand violet: indigo is the light-theme accent (Purple/300), the
  // light/dark variants are the ramp neighbours, violet tracks Purple/200.
  // Sunset with the renderer migration — prefer purple*/mint* by name.
  /** @deprecated Use `semantic.purple300` (accent). */
  indigo: "#6F27FF",
  /** @deprecated Use `semantic.purple200` (dark-theme accent). */
  indigoLight: "#9C6BFF",
  /** @deprecated Use `semantic.purple500`. */
  indigoDark: "#1C0252",
  /** @deprecated Use `semantic.purpleGlow`. */
  indigoGlow: "rgba(111,39,255,0.15)",
  /** @deprecated Use `semantic.purple200`. */
  violet: "#9C6BFF",
  /** @deprecated Use `semantic.purpleGlow`. */
  violetGlow: "rgba(111,39,255,0.15)",
  /** @deprecated Compose from `semantic.green` at the alpha you need. */
  greenGlow: "rgba(28,162,77,0.15)",
} as const

// ─── Surface tokens by theme ────────────────────────────────────────────────
// DS v0.2.6 (relaja): the Main ramp is the neutral spine.
//   Dark:  Main/900 page · Main/800 card · Main/700 border · Main/600 strong
//   Light: Main/200 page · White card · Main/300 border · Main/400 strong
// Shadows: one shadow per theme (the DS has no elevation ramp yet);
// dark shadows are black, light shadows are Main/800 ink.
// OS layer (R17): `bgItem` is the fill for an item inside a panel — one step
// off the panel, never a line. `accent` (R10) is the theme's violet as a
// SURFACE role: ring colours and violet text read this, never the raw ramp.
export interface SurfaceTokens {
  bgPage: string
  bgSurface: string
  bgCard: string
  bgCardHover: string
  bgInner: string
  bgItem: string
  border: string
  borderStrong: string
  text: string
  text2: string
  text3: string
  accent: string
  shadowSm: string
  shadow: string
  shadowLg: string

  // ── OS prototype roles (design-testing, Oct 2026) ──────────────────────
  /** App frame behind sidebar + sheet (the "unida" frame). */
  bgFrame: string
  /** The main sheet the window panes sit on. */
  bgSheet: string
  /** A card one step off the sheet (`--step`). */
  bgStep: string
  /** Header strips / composer pill fill (`--header-bg`). */
  bgHeader: string
  /** Control fill — switch track, "+" composer button (`--control-bg`). */
  bgControl: string
  /** Translucent wash for chips / hover (`--wash`). */
  wash: string
  /** Stronger wash — hover of a washed thing (`--wash2`). */
  wash2: string
  /** Hero / home card fill (`--box`): the sheet colour in dark, white in light. */
  bgBox: string
  /** Row inside a card (`--nest`). */
  nest: string
  nestHover: string
  /** Active nav item / tab fill (`--nav-active`). */
  navActive: string
  /** Input fill (`--field`). */
  field: string
  /** Icon tile fill (`--tile`). */
  tile: string
  /** Border for accent-tinted things (`--border-accent`). */
  borderAccent: string
  borderAccentStrong: string
  /** Ink pill — the inverted button (theme toggle, "Explorar"). */
  inkPill: string
  inkPillText: string
  /** Violet-tinted lifts (web box-shadow strings). */
  liftSm: string
  liftSmHover: string
  lift: string
  liftHover: string
  elevHover: string
  elevRaised: string
  /** Status tints: g(reen) a(mber) r(ed) i(nfo/purple) m(int). */
  tint: Record<TintKey, TintColors>
}

export type TintKey = "g" | "a" | "r" | "i" | "m"
export interface TintColors {
  bg: string
  tx: string
  bd: string
}

// Dark — measured on the design-testing prototype (Oct 2026, resolved vars):
//   --fr #201C27 (Main/900) · --sheet / --box / --card / --header-bg #17131E
//   (Main/950) · --step #201C27 · borders bone at 4 % / 7.5 % · tints ~12 %.
// The sheet is one step DARKER than the frame; cards step back up to the
// frame colour; the hero cards sit on the sheet colour and separate by lift.
const surfaceDark: SurfaceTokens = {
  bgPage: "#201C27",
  bgSurface: "#17131E",
  bgCard: "#17131E",
  bgCardHover: "rgba(250,249,252,0.03)",
  bgInner: "rgba(0,0,0,0.22)",
  // ! off-ramp half step Main/800 → Main/700, from the OS prototypes — the
  // DS carries the same `!` (open decision: add Main/750 or accept the
  // off-ramp surface). Do not "fix" it onto the ramp.
  bgItem: "#3E3849",
  // Prototype (design-testing) borders: hairlines of bone over the dark
  // page, not a ramp step — the surfaces separate by fill, the line only hints.
  border: "rgba(250,249,252,0.04)",
  borderStrong: "rgba(250,249,252,0.075)",
  text: "#FAF9FC",
  text2: "#CFC5E2",
  text3: "#968FA7",
  // Purple/200 — 4.74:1 on Main/900 (the deep 300 dies on a dark page)
  accent: "#9C6BFF",
  shadowSm: "0 1px 4px rgba(0,0,0,0.40)",
  shadow: "0 4px 24px rgba(0,0,0,0.50)",
  shadowLg: "0 24px 60px -24px rgba(0,0,0,0.55)",

  bgFrame: "#201C27",
  bgSheet: "#17131E",
  bgStep: "#201C27",
  bgBox: "#17131E",
  bgHeader: "#17131E",
  bgControl: "#575263",
  wash: "rgba(250,249,252,0.04)",
  wash2: "rgba(250,249,252,0.07)",
  nest: "rgba(250,249,252,0.035)",
  nestHover: "rgba(250,249,252,0.055)",
  navActive: "rgba(156,107,255,0.12)",
  field: "rgba(250,249,252,0.03)",
  tile: "rgba(156,107,255,0.14)",
  borderAccent: "#6F27FF",
  borderAccentStrong: "#9C6BFF",
  inkPill: "#F2F0F7",
  inkPillText: "#2C2836",
  liftSm: "0 12px 26px -16px rgba(111,39,255,0.34)",
  liftSmHover: "0 14px 32px -14px rgba(111,39,255,0.50)",
  lift: "0 24px 50px -30px rgba(111,39,255,0.42)",
  liftHover: "0 28px 58px -28px rgba(111,39,255,0.58)",
  elevHover: "0 8px 22px -6px rgba(0,0,0,0.45)",
  elevRaised: "0 0 10px -7px rgba(0,0,0,0.4), 0 24px 56px -12px rgba(0,0,0,0.55)",
  tint: {
    g: { bg: "rgba(28,162,77,0.12)", tx: "#DCFCE7", bd: "rgba(28,162,77,0.30)" },
    a: { bg: "rgba(245,158,11,0.10)", tx: "#FEF3C7", bd: "rgba(245,158,11,0.28)" },
    r: { bg: "rgba(239,68,68,0.09)", tx: "#FEE2E2", bd: "rgba(239,68,68,0.30)" },
    i: { bg: "rgba(156,107,255,0.13)", tx: "#E7DCFF", bd: "rgba(156,107,255,0.30)" },
    m: { bg: "rgba(0,209,163,0.12)", tx: "#B9FFF0", bd: "rgba(0,209,163,0.28)" },
  },
}

const surfaceLight: SurfaceTokens = {
  bgPage: "#F2F0F7",
  bgSurface: "#FAF9FC",
  bgCard: "#FFFFFF",
  bgCardHover: "#FAF9FC",
  bgInner: "rgba(52,47,61,0.05)",
  bgItem: "#F2F0F7",
  // Prototype (design-testing): the hairline is Main/300 at 55% — cards
  // separate by white-on-bone fill + violet lift, the line only hints.
  border: "rgba(229,223,239,0.55)",
  borderStrong: "#E5DFEF",
  text: "#342F3D",
  text2: "#575263",
  text3: "#968FA7",
  // Purple/300 — 6.16:1 on White (the light-theme accent)
  accent: "#6F27FF",
  shadowSm: "0 2px 8px rgba(52,47,61,0.12)",
  shadow: "0 4px 20px rgba(52,47,61,0.14)",
  shadowLg: "0 24px 60px -24px rgba(52,47,61,0.28)",

  bgFrame: "#EDEAF4",
  bgSheet: "#FAF9FC",
  bgStep: "#FFFFFF",
  // The prototype's light --box is the sheet colour; the app keeps its hero
  // cards white on the bone sheet on purpose (decided Oct 2026).
  bgBox: "#FFFFFF",
  bgHeader: "#F2F0F7",
  bgControl: "#CFC5E2",
  wash: "rgba(207,197,226,0.18)",
  wash2: "rgba(207,197,226,0.30)",
  nest: "rgba(52,47,61,0.04)",
  nestHover: "rgba(52,47,61,0.07)",
  navActive: "rgba(111,39,255,0.10)",
  field: "rgba(255,255,255,0.70)",
  tile: "rgba(111,39,255,0.12)",
  borderAccent: "#9C6BFF",
  borderAccentStrong: "#6F27FF",
  inkPill: "#201C27",
  inkPillText: "#FAF9FC",
  liftSm: "0 12px 24px -16px rgba(111,39,255,0.26)",
  liftSmHover: "0 14px 30px -14px rgba(111,39,255,0.38)",
  lift: "0 22px 46px -30px rgba(111,39,255,0.30)",
  liftHover: "0 26px 54px -28px rgba(111,39,255,0.42)",
  elevHover: "0 8px 22px -6px rgba(52,47,61,0.20)",
  elevRaised: "0 0 10px -7px rgba(52,47,61,0.16), 0 24px 56px -12px rgba(52,47,61,0.26)",
  tint: {
    g: { bg: "#DCFCE7", tx: "#1CA24D", bd: "rgba(28,162,77,0.20)" },
    a: { bg: "#FEF3C7", tx: "#B87708", bd: "rgba(245,158,11,0.35)" },
    r: { bg: "#FEE2E2", tx: "#EF4444", bd: "rgba(239,68,68,0.20)" },
    i: { bg: "#E7DCFF", tx: "#6F27FF", bd: "rgba(111,39,255,0.20)" },
    m: { bg: "#B9FFF0", tx: "#003E31", bd: "rgba(0,209,163,0.20)" },
  },
}

export const surface: Record<Theme, SurfaceTokens> = {
  dark: surfaceDark,
  light: surfaceLight,
}

// ─── Status dot tints (guide §3) ────────────────────────────────────────────
// Same hex in both themes (theme-agnostic).
// Running glow alpha follows the §3 table (0.6), not the CSS inline of the
// guide HTML (0.7) — the guide has internal drift; the table is the intent.
export const statusDotColors = {
  pending: { fill: semantic.orange, glow: "rgba(249,115,22,0)", pulse: false },
  // Glows follow the relaja fills (the old rgba literals kept the pre-relaja
  // hexes #5E6AD2/#22C55E/#8B5CF6 after the fills moved to the brand palette).
  // `running` is AMBER (#F59E0B) — unified with the board's in_progress
  // column (COLUMN_COLORS.in_progress): "the agent is working" is one
  // concept, one color, everywhere in the OS. It pulses while alive.
  running: { fill: semantic.amber, glow: "rgba(245,158,11,0.55)", pulse: true },
  completed: { fill: semantic.green, glow: "rgba(28,162,77,0.5)", pulse: false },
  failed: { fill: semantic.red, glow: "rgba(239,68,68,0.5)", pulse: false },
  pending_permission: { fill: semantic.violet, glow: "rgba(156,107,255,0.6)", pulse: true },
  // Inline user form waiting to be filled — same "waiting on the human" family
  // as pending_permission (violet, pulsing).
  pending_user_input: { fill: semantic.violet, glow: "rgba(156,107,255,0.6)", pulse: true },
} as const

// ─── Anti-pattern indicators (guide §8 / §8.5) ──────────────────────────────
// Risk (amber) and irreversibility (red) markers rendered in the header
// between the badge and the chevron. Same hex in both themes — these are
// semantic safety signals, not surface colour. Kept here so any future
// adjustment to the indicator look-and-feel happens in one place.
export const indicators = {
  risk: {
    fg: semantic.amber,
    bg: "rgba(245,158,11,0.12)",
    border: "rgba(245,158,11,0.20)",
  },
  irreversible: {
    fg: semantic.red,
    bg: "rgba(239,68,68,0.12)",
    border: "rgba(239,68,68,0.18)",
  },
} as const

// ─── ControlsBar palette (guide §8) ─────────────────────────────────────────
// Deny / Allow / Permission accent + progress fill, theme-agnostic semantic.
// Values mirror the inline rgba that lived in `ControlsBar.tsx` before the
// extraction — visual parity is preserved. Kept here so the permission flow
// look-and-feel can be tuned without touching the component.
export const controlsBar = {
  deny: {
    fg: semantic.red,
    bg: "rgba(239,68,68,0.15)",
    border: "rgba(239,68,68,0.20)",
  },
  denyAlways: {
    fg: "#dc2626",
    bg: "rgba(220,38,38,0.18)",
    border: "rgba(220,38,38,0.25)",
  },
  allow: {
    fg: semantic.green,
    bg: "rgba(28,162,77,0.15)",
    border: "rgba(28,162,77,0.20)",
  },
  allowAlways: {
    fg: "#16a34a",
    bg: "rgba(22,163,74,0.18)",
    border: "rgba(22,163,74,0.25)",
  },
  permission: {
    fg: semantic.violet,
    modalBorder: "rgba(139,92,246,0.25)",
  },
} as const

// ─── DiffViewer palette ─────────────────────────────────────────────────────
// Add / Delete line tints. Theme-agnostic — the diff semantic is universal.
// Backgrounds reuse the semantic green/red at 12% so the row tint matches
// the surrounding §5 palette. Foregrounds use slightly darker hues
// (#16a34a/#dc2626 vs #22C55E/#EF4444) for readability on the tinted bg
// without dropping contrast on either theme.
export const diff = {
  add: { fg: "#16a34a", bg: "rgba(34,197,94,0.12)" },
  del: { fg: "#dc2626", bg: "rgba(239,68,68,0.12)" },
} as const

// ─── Badge palettes (guide §4) ──────────────────────────────────────────────
export interface BadgeColors {
  text: string
  bg: string
  border: string
}

export interface BadgePalette {
  ok: BadgeColors
  err: BadgeColors
  warn: BadgeColors
  gray: BadgeColors
  info: BadgeColors
}

// Prototype (design-testing) tints: ok = g, err = r, warn = a, info = i.
const badgesDark: BadgePalette = {
  ok: { text: "#DCFCE7", bg: "rgba(28,162,77,0.20)", border: "rgba(28,162,77,0.38)" },
  err: { text: "#FEE2E2", bg: "rgba(239,68,68,0.20)", border: "rgba(239,68,68,0.38)" },
  warn: { text: "#FEF3C7", bg: "rgba(245,158,11,0.20)", border: "rgba(245,158,11,0.38)" },
  gray: { text: "#968FA7", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.10)" },
  info: { text: "#E7DCFF", bg: "rgba(156,107,255,0.20)", border: "rgba(156,107,255,0.38)" },
}

const badgesLight: BadgePalette = {
  ok: { text: "#1CA24D", bg: "#DCFCE7", border: "rgba(28,162,77,0.20)" },
  err: { text: "#EF4444", bg: "#FEE2E2", border: "rgba(239,68,68,0.20)" },
  warn: { text: "#B87708", bg: "#FEF3C7", border: "rgba(245,158,11,0.35)" },
  gray: { text: "#797386", bg: "rgba(207,197,226,0.18)", border: "rgba(0,0,0,0.0)" },
  info: { text: "#6F27FF", bg: "#E7DCFF", border: "rgba(111,39,255,0.20)" },
}

export const badges: Record<Theme, BadgePalette> = {
  dark: badgesDark,
  light: badgesLight,
}

// ─── MCA category badges (catalog redesign, TER-523) ────────────────────────
// One tint per MCA category for the catalog card / detail header badge.
// Values come straight from the catalog mockups (docs/mcas/catalog-window.html
// `.b-<cat>` rules), NOT Tailwind defaults — the vendor palette was validated
// against the rendered design. `media` shares the AI tint (the mockup groups
// them as "AI & Media"). Keyed by `MCACategory` so adding a category to the
// shared enum without a tint here fails the build — a structural guard, not a
// reminder.
export interface CategoryBadge {
  text: string
  bg: string
}

const categoryBadgesDark: Record<MCACategory, CategoryBadge> = {
  communication: { text: "#8B96E9", bg: "rgba(94,106,210,0.14)" },
  productivity: { text: "#4CC38A", bg: "rgba(76,195,138,0.12)" },
  development: { text: "#F0A030", bg: "rgba(240,160,48,0.12)" },
  ai: { text: "#A78BFA", bg: "rgba(167,139,250,0.14)" },
  media: { text: "#A78BFA", bg: "rgba(167,139,250,0.14)" },
  design: { text: "#F472B6", bg: "rgba(244,114,182,0.12)" },
  storage: { text: "#38BDF8", bg: "rgba(56,189,248,0.12)" },
  system: { text: "#94A3B8", bg: "rgba(100,116,139,0.14)" },
  data: { text: "#34D399", bg: "rgba(52,211,153,0.12)" },
  utility: { text: "#FBBF24", bg: "rgba(251,191,36,0.12)" },
  google: { text: "#5E6AD2", bg: "rgba(94,106,210,0.14)" },
  microsoft: { text: "#4A9EFF", bg: "rgba(74,158,255,0.14)" },
  other: { text: "#94A3B8", bg: "rgba(148,163,184,0.10)" },
}

const categoryBadgesLight: Record<MCACategory, CategoryBadge> = {
  communication: { text: "#4A56C0", bg: "rgba(94,106,210,0.12)" },
  productivity: { text: "#16A34A", bg: "rgba(22,163,74,0.10)" },
  development: { text: "#B45309", bg: "rgba(180,83,9,0.10)" },
  ai: { text: "#7C3AED", bg: "rgba(124,58,237,0.10)" },
  media: { text: "#7C3AED", bg: "rgba(124,58,237,0.10)" },
  design: { text: "#DB2777", bg: "rgba(219,39,119,0.10)" },
  storage: { text: "#0284C7", bg: "rgba(2,132,199,0.10)" },
  system: { text: "#475569", bg: "rgba(71,85,105,0.10)" },
  data: { text: "#059669", bg: "rgba(5,150,105,0.10)" },
  utility: { text: "#A16207", bg: "rgba(161,98,7,0.10)" },
  google: { text: "#4A56C0", bg: "rgba(94,106,210,0.12)" },
  microsoft: { text: "#1E6FD9", bg: "rgba(74,158,255,0.12)" },
  other: { text: "#64748B", bg: "rgba(100,116,139,0.10)" },
}

export const categoryBadges: Record<Theme, Record<MCACategory, CategoryBadge>> = {
  dark: categoryBadgesDark,
  light: categoryBadgesLight,
}

/**
 * Badge tint for an MCA category. Unknown / unmapped categories fall back to
 * the neutral `other` tint so the badge never renders blank.
 */
export function categoryBadgeProps(category: string, theme: Theme): CategoryBadge {
  const set = categoryBadges[theme]
  return set[category as MCACategory] ?? set.other
}

// ─── Compatibility shim (legacy `colors` export) ────────────────────────────
// Maps the v2 dark set onto the pre-v2 names used by ~70 existing renderers.
// Do not extend this in new code — prefer `useColors()` for adaptive tokens
// or import semantic colors by name (`indigo`, `green`, …).
//
// **Sunset target: 2026-10-01.** All legacy aliases below are marked
// `@deprecated`. Once the 16 sub-issues of Follow-up E migrate every
// renderer to `useColors()` + named semantic imports, this shim becomes
// the only blocker and can be removed in a single PR. TypeScript surfaces
// the deprecation in autocomplete and call sites — which is the signal
// that drives the migration during sub-issue work.
export const colors = {
  // semantic (unchanged hex)
  ...semantic,

  // ─── Legacy aliases (pre-v2 → v2 dark) ────────────────────────────────
  /** @deprecated Use `colors.green` (semantic). Sunset 2026-10-01. */
  success: semantic.green,
  /** @deprecated Use `colors.indigo` (semantic). Sunset 2026-10-01. */
  running: semantic.indigo,
  /** @deprecated Use `colors.red` (semantic). Sunset 2026-10-01. */
  failed: semantic.red,
  /** @deprecated Use `colors.amber` (semantic). Sunset 2026-10-01. */
  warning: semantic.amber,
  /** @deprecated Use `colors.indigo` (semantic). Sunset 2026-10-01. */
  info: semantic.indigo,

  /** @deprecated Use `statusDotColors.completed.glow`. Sunset 2026-10-01. */
  glowSuccess: statusDotColors.completed.glow,
  /** @deprecated Use `statusDotColors.running.glow`. Sunset 2026-10-01. */
  glowRunning: statusDotColors.running.glow,
  /** @deprecated Use `statusDotColors.failed.glow`. Sunset 2026-10-01. */
  glowFailed: statusDotColors.failed.glow,

  /** @deprecated Use `useColors().badges.ok`. Sunset 2026-10-01. */
  badgeSuccess: { text: badgesDark.ok.text, bg: badgesDark.ok.bg },
  /** @deprecated Use `useColors().badges.err`. Sunset 2026-10-01. */
  badgeError: { text: badgesDark.err.text, bg: badgesDark.err.bg },
  /** @deprecated Use `useColors().badges.info`. Sunset 2026-10-01. */
  badgeInfo: { text: badgesDark.info.text, bg: badgesDark.info.bg },
  /** @deprecated Use `useColors().badges.warn`. Sunset 2026-10-01. */
  badgeWarning: { text: badgesDark.warn.text, bg: badgesDark.warn.bg },
  /** @deprecated Use `useColors().badges.gray`. Sunset 2026-10-01. */
  badgeGray: { text: badgesDark.gray.text, bg: badgesDark.gray.bg },

  // ─── Legacy text scale → v2 dark text/text2/text3 + bright ────────────
  /** @deprecated Use `useColors().text`. Sunset 2026-10-01. */
  primary: surfaceDark.text,
  /** @deprecated Use `useColors().text2`. Sunset 2026-10-01. */
  secondary: surfaceDark.text2,
  /** @deprecated Use `useColors().text3`. Sunset 2026-10-01. */
  muted: surfaceDark.text3,
  /** @deprecated Use `colors.text` directly. Sunset 2026-10-01. */
  bright: "#e4e4e7",

  // v2 surface (dark only — renderers that need adaptive read via useColors())
  bgPage: surfaceDark.bgPage,
  bgCard: surfaceDark.bgCard,
  bgCardHover: surfaceDark.bgCardHover,
  bgInner: surfaceDark.bgInner,
  /** @deprecated No v2 equivalent — paint with `bgInner` or surface theme. Sunset 2026-10-01. */
  bgDark: "rgba(0,0,0,0.3)",
  border: surfaceDark.border,
  borderStrong: surfaceDark.borderStrong,
  /** @deprecated Use `borderStrong`. Sunset 2026-10-01. */
  borderHover: surfaceDark.borderStrong,

  text: surfaceDark.text,
  text2: surfaceDark.text2,
  text3: surfaceDark.text3,

  chevron: "#3f3f46",

  // ── Semantic accents (TER-270) — used by ToolCallCard.accent and renderers
  // to convey the nature of an operation at a glance.
  accentReadOnly: surfaceDark.text3,
  accentMutation: semantic.indigo,
  accentDestructive: semantic.red,

  // ── Domain kind tints (TER-270) — for filesystem & similar MCAs that
  // classify content by `kind` (text / binary / image).
  kindText: "#06b6d4",
  kindBinary: semantic.amber,
  kindImage: "#a855f7",

  // ── Subtle glows for hover/active states.
  glowSubtle: semantic.indigoGlow,
} as const

export type McaColors = typeof colors
