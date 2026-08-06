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

import type { MCACategory } from '@teros/shared';

export type Theme = 'dark' | 'light';

// ─── Status (5 states, guide §3) ────────────────────────────────────────────
// Includes `pending` (orange, no pulse). The legacy 4-state union remains a
// subset to keep older code paths (StatusDot, etc.) compiling unchanged.
export type McaStatusType =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'pending_permission'
  | 'pending_user_input';

// ─── Semantic palette (theme-agnostic, guide §5) ────────────────────────────
const semantic = {
  indigo: '#5E6AD2',
  indigoLight: '#7B82E0',
  indigoDark: '#4A52B8',
  indigoGlow: 'rgba(94,106,210,0.15)',
  violet: '#8B5CF6',
  violetGlow: 'rgba(139,92,246,0.15)',
  green: '#22C55E',
  amber: '#F59E0B',
  red: '#EF4444',
  orange: '#F97316',
} as const;

// ─── Surface tokens by theme (guide §5) ─────────────────────────────────────
// Dark uses the values from the v2 guide HTML (lines 24-36). Light uses the
// editorial cream palette from the same guide (lines 37-49).
export interface SurfaceTokens {
  bgPage: string;
  bgCard: string;
  bgCardHover: string;
  bgInner: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  shadowSm: string;
  shadow: string;
  shadowLg: string;
}

const surfaceDark: SurfaceTokens = {
  bgPage: '#0A0A0F',
  bgCard: '#16161D',
  bgCardHover: '#1D1D26',
  bgInner: 'rgba(0,0,0,0.22)',
  border: 'rgba(228,228,231,0.07)',
  borderStrong: 'rgba(228,228,231,0.13)',
  text: '#E4E4E7',
  text2: '#A1A1AA',
  text3: '#52525B',
  shadowSm: '0 1px 4px rgba(0,0,0,0.40)',
  shadow: '0 4px 24px rgba(0,0,0,0.50)',
  shadowLg: '0 24px 64px rgba(0,0,0,0.60)',
};

const surfaceLight: SurfaceTokens = {
  bgPage: '#E8E1D0',
  bgCard: 'rgba(250,247,240,0.90)',
  bgCardHover: 'rgba(250,247,240,0.98)',
  bgInner: 'rgba(10,10,15,0.05)',
  border: 'rgba(10,10,15,0.09)',
  borderStrong: 'rgba(10,10,15,0.15)',
  text: '#1A1A1F',
  text2: '#4A4A5A',
  text3: '#8A8A9A',
  shadowSm: '0 2px 8px rgba(10,10,15,0.12)',
  shadow: '0 4px 20px rgba(10,10,15,0.14)',
  shadowLg: '0 24px 64px rgba(10,10,15,0.10)',
};

export const surface: Record<Theme, SurfaceTokens> = {
  dark: surfaceDark,
  light: surfaceLight,
};

// ─── Status dot tints (guide §3) ────────────────────────────────────────────
// Same hex in both themes (theme-agnostic).
// Running glow alpha follows the §3 table (0.6), not the CSS inline of the
// guide HTML (0.7) — the guide has internal drift; the table is the intent.
export const statusDotColors = {
  pending: { fill: semantic.orange, glow: 'rgba(249,115,22,0)', pulse: false },
  running: { fill: semantic.indigo, glow: 'rgba(94,106,210,0.6)', pulse: true },
  completed: { fill: semantic.green, glow: 'rgba(34,197,94,0.5)', pulse: false },
  failed: { fill: semantic.red, glow: 'rgba(239,68,68,0.5)', pulse: false },
  pending_permission: { fill: semantic.violet, glow: 'rgba(139,92,246,0.6)', pulse: true },
  // Inline user form waiting to be filled — same "waiting on the human" family
  // as pending_permission (violet, pulsing).
  pending_user_input: { fill: semantic.violet, glow: 'rgba(139,92,246,0.6)', pulse: true },
} as const;

// ─── Anti-pattern indicators (guide §8 / §8.5) ──────────────────────────────
// Risk (amber) and irreversibility (red) markers rendered in the header
// between the badge and the chevron. Same hex in both themes — these are
// semantic safety signals, not surface colour. Kept here so any future
// adjustment to the indicator look-and-feel happens in one place.
export const indicators = {
  risk: {
    fg: semantic.amber,
    bg: 'rgba(245,158,11,0.12)',
    border: 'rgba(245,158,11,0.20)',
  },
  irreversible: {
    fg: semantic.red,
    bg: 'rgba(239,68,68,0.12)',
    border: 'rgba(239,68,68,0.18)',
  },
} as const;

// ─── ControlsBar palette (guide §8) ─────────────────────────────────────────
// Deny / Allow / Permission accent + progress fill, theme-agnostic semantic.
// Values mirror the inline rgba that lived in `ControlsBar.tsx` before the
// extraction — visual parity is preserved. Kept here so the permission flow
// look-and-feel can be tuned without touching the component.
export const controlsBar = {
  deny: {
    fg: semantic.red,
    bg: 'rgba(239,68,68,0.15)',
    border: 'rgba(239,68,68,0.20)',
  },
  allow: {
    fg: semantic.green,
    bg: 'rgba(34,197,94,0.15)',
    border: 'rgba(34,197,94,0.20)',
  },
  permission: {
    fg: semantic.violet,
    modalBorder: 'rgba(139,92,246,0.25)',
  },
} as const;

// ─── DiffViewer palette ─────────────────────────────────────────────────────
// Add / Delete line tints. Theme-agnostic — the diff semantic is universal.
// Backgrounds reuse the semantic green/red at 12% so the row tint matches
// the surrounding §5 palette. Foregrounds use slightly darker hues
// (#16a34a/#dc2626 vs #22C55E/#EF4444) for readability on the tinted bg
// without dropping contrast on either theme.
export const diff = {
  add: { fg: '#16a34a', bg: 'rgba(34,197,94,0.12)' },
  del: { fg: '#dc2626', bg: 'rgba(239,68,68,0.12)' },
} as const;

// ─── Badge palettes (guide §4) ──────────────────────────────────────────────
export interface BadgeColors {
  text: string;
  bg: string;
  border: string;
}

export interface BadgePalette {
  ok: BadgeColors;
  err: BadgeColors;
  warn: BadgeColors;
  gray: BadgeColors;
  info: BadgeColors;
}

const badgesDark: BadgePalette = {
  ok: { text: '#86efac', bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.18)' },
  err: { text: '#fca5a5', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.18)' },
  warn: { text: '#fcd34d', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.18)' },
  gray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.10)' },
  info: { text: '#a5b4fc', bg: 'rgba(94,106,210,0.12)', border: 'rgba(94,106,210,0.20)' },
};

const badgesLight: BadgePalette = {
  ok: { text: '#15803d', bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.22)' },
  err: { text: '#b91c1c', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.22)' },
  warn: { text: '#b45309', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.22)' },
  gray: { text: '#6a6a7a', bg: 'rgba(0,0,0,0.05)', border: 'rgba(0,0,0,0.10)' },
  info: { text: '#4338ca', bg: 'rgba(94,106,210,0.10)', border: 'rgba(94,106,210,0.22)' },
};

export const badges: Record<Theme, BadgePalette> = {
  dark: badgesDark,
  light: badgesLight,
};

// ─── MCA category badges (catalog redesign, TER-523) ────────────────────────
// One tint per MCA category for the catalog card / detail header badge.
// Values come straight from the catalog mockups (docs/mcas/catalog-window.html
// `.b-<cat>` rules), NOT Tailwind defaults — the vendor palette was validated
// against the rendered design. `media` shares the AI tint (the mockup groups
// them as "AI & Media"). Keyed by `MCACategory` so adding a category to the
// shared enum without a tint here fails the build — a structural guard, not a
// reminder.
export interface CategoryBadge {
  text: string;
  bg: string;
}

const categoryBadgesDark: Record<MCACategory, CategoryBadge> = {
  communication: { text: '#8B96E9', bg: 'rgba(94,106,210,0.14)' },
  productivity: { text: '#4CC38A', bg: 'rgba(76,195,138,0.12)' },
  development: { text: '#F0A030', bg: 'rgba(240,160,48,0.12)' },
  ai: { text: '#A78BFA', bg: 'rgba(167,139,250,0.14)' },
  media: { text: '#A78BFA', bg: 'rgba(167,139,250,0.14)' },
  design: { text: '#F472B6', bg: 'rgba(244,114,182,0.12)' },
  storage: { text: '#38BDF8', bg: 'rgba(56,189,248,0.12)' },
  system: { text: '#94A3B8', bg: 'rgba(100,116,139,0.14)' },
  data: { text: '#34D399', bg: 'rgba(52,211,153,0.12)' },
  utility: { text: '#FBBF24', bg: 'rgba(251,191,36,0.12)' },
  google: { text: '#5E6AD2', bg: 'rgba(94,106,210,0.14)' },
  other: { text: '#94A3B8', bg: 'rgba(148,163,184,0.10)' },
};

const categoryBadgesLight: Record<MCACategory, CategoryBadge> = {
  communication: { text: '#4A56C0', bg: 'rgba(94,106,210,0.12)' },
  productivity: { text: '#16A34A', bg: 'rgba(22,163,74,0.10)' },
  development: { text: '#B45309', bg: 'rgba(180,83,9,0.10)' },
  ai: { text: '#7C3AED', bg: 'rgba(124,58,237,0.10)' },
  media: { text: '#7C3AED', bg: 'rgba(124,58,237,0.10)' },
  design: { text: '#DB2777', bg: 'rgba(219,39,119,0.10)' },
  storage: { text: '#0284C7', bg: 'rgba(2,132,199,0.10)' },
  system: { text: '#475569', bg: 'rgba(71,85,105,0.10)' },
  data: { text: '#059669', bg: 'rgba(5,150,105,0.10)' },
  utility: { text: '#A16207', bg: 'rgba(161,98,7,0.10)' },
  google: { text: '#4A56C0', bg: 'rgba(94,106,210,0.12)' },
  other: { text: '#64748B', bg: 'rgba(100,116,139,0.10)' },
};

export const categoryBadges: Record<Theme, Record<MCACategory, CategoryBadge>> = {
  dark: categoryBadgesDark,
  light: categoryBadgesLight,
};

/**
 * Badge tint for an MCA category. Unknown / unmapped categories fall back to
 * the neutral `other` tint so the badge never renders blank.
 */
export function categoryBadgeProps(category: string, theme: Theme): CategoryBadge {
  const set = categoryBadges[theme];
  return set[category as MCACategory] ?? set.other;
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
  bright: '#e4e4e7',

  // v2 surface (dark only — renderers that need adaptive read via useColors())
  bgPage: surfaceDark.bgPage,
  bgCard: surfaceDark.bgCard,
  bgCardHover: surfaceDark.bgCardHover,
  bgInner: surfaceDark.bgInner,
  /** @deprecated No v2 equivalent — paint with `bgInner` or surface theme. Sunset 2026-10-01. */
  bgDark: 'rgba(0,0,0,0.3)',
  border: surfaceDark.border,
  borderStrong: surfaceDark.borderStrong,
  /** @deprecated Use `borderStrong`. Sunset 2026-10-01. */
  borderHover: surfaceDark.borderStrong,

  text: surfaceDark.text,
  text2: surfaceDark.text2,
  text3: surfaceDark.text3,

  chevron: '#3f3f46',

  // ── Semantic accents (TER-270) — used by ToolCallCard.accent and renderers
  // to convey the nature of an operation at a glance.
  accentReadOnly: surfaceDark.text3,
  accentMutation: semantic.indigo,
  accentDestructive: semantic.red,

  // ── Domain kind tints (TER-270) — for filesystem & similar MCAs that
  // classify content by `kind` (text / binary / image).
  kindText: '#06b6d4',
  kindBinary: semantic.amber,
  kindImage: '#a855f7',

  // ── Subtle glows for hover/active states.
  glowSubtle: semantic.indigoGlow,
} as const;

export type McaColors = typeof colors;
