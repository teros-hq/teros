/**
 * AppSpinner — Unified spinner component
 *
 * Replaces all direct usages of React Native's `ActivityIndicator` and
 * Tamagui's `Spinner`. Internally uses `TerosLoading` (the custom SVG
 * hexagon spinner) as the visual reference.
 *
 * Colors resolve from the ACTIVE THEME (bug 2026-10-06: fixed palette colors
 * left spinners invisible — `indigoDark` #1C0252 rode black-on-black on dark
 * surfaces, and the fixed brand Purple/300 only managed 2.71:1 in dark):
 *
 *   • accent variants (`default` / `brand` / `board`) → `useColors().accent`
 *     — Purple/200 in dark, Purple/300 in light. The shimmer lesson: dark's
 *     accent is the LIGHT step of the ramp, never the deep one.
 *   • status variants (`danger` / `success` / `warning`) → semantic colors
 *     (theme-agnostic on purpose — status reads the same in both themes).
 *   • `muted` → `c.text3` (surface-adaptive neutral).
 *   • `onFill` → WHITE in both themes — for spinners riding a SOLID brand
 *     fill (violet/green/red buttons, hero banners). The fill is fixed, so
 *     white is the one color that reads on it in both themes.
 *   • `onDark` → adaptive ink (white in dark, `c.text` in light) — for
 *     surfaces that adapt WITH the theme (page, cards, `c.border` buttons).
 *
 * Usage:
 *   <AppSpinner />
 *   <AppSpinner size="lg" variant="brand" />
 *   <AppSpinner size="sm" variant="muted" />
 *   <AppSpinner size="sm" variant="onFill" />  // inside a solid-fill button
 */

import React from 'react';
import { useColors } from '../mca/primitives/useColors';
import { colors as semanticColors, surface } from '../mca/primitives/colors';
import { TerosLoading } from '../TerosLoading';

// ─── Size tokens ────────────────────────────────────────────────────────────

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

const spinnerSizes: Record<SpinnerSize, number> = {
  xs: 10,
  sm: 16,
  md: 24,
  lg: 48,
};

// ─── Variant type ───────────────────────────────────────────────────────────

export type SpinnerVariant =
  | 'default'
  | 'brand'
  | 'muted'
  | 'danger'
  | 'success'
  | 'warning'
  | 'board'
  | 'onDark'
  | 'onFill';

// ─── Component ───────────────────────────────────────────────────────────────

export interface AppSpinnerProps {
  /** Visual size of the spinner (default: 'md') */
  size?: SpinnerSize;
  /** Color variant (default: 'brand') */
  variant?: SpinnerVariant;
  /** Override color directly (takes precedence over variant) */
  color?: string;
}

export function AppSpinner({
  size = 'md',
  variant = 'brand',
  color,
}: AppSpinnerProps) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  const variantColors: Record<SpinnerVariant, string> = {
    // Accent variants ride the theme's accent SURFACE role (R10) — the same
    // token the queued-indicator and shimmer use. The old fixed Purple/300
    // was the light-theme accent worn in dark too (2.71:1 on Main/900 — the
    // bug); Purple/200 reads 4.74:1 there.
    default: c.accent,
    brand: c.accent,
    board: c.accent,
    muted: c.text3,
    danger: semanticColors.red,
    success: semanticColors.green,
    warning: semanticColors.amber,
    // Adaptive ink — for surfaces that follow the theme (page/cards/borders).
    // @todo nira - 2026.10.06 : rename `onDark` → `adaptive` in a dedicated sweep —
    // the name predates theme resolution and now misleads: it is NOT "white
    // always" (that's `onFill`); it is ink that follows the theme's surfaces.
    onDark: isDark ? '#FFFFFF' : c.text,
    // Solid brand fills (violet/green/red buttons, heroes) are theme-agnostic
    // — white reads on them in BOTH themes. Sites that used `onDark` on such
    // fills drew theme ink on a fixed violet in light (≈2.1:1).
    onFill: '#FFFFFF',
  };

  const resolvedSize = spinnerSizes[size];
  const resolvedColor = color ?? variantColors[variant];

  return <TerosLoading size={resolvedSize} color={resolvedColor} />;
}
