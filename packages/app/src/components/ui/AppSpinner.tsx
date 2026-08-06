/**
 * AppSpinner — Unified spinner component
 *
 * Replaces all direct usages of React Native's `ActivityIndicator` and
 * Tamagui's `Spinner`. Internally uses `TerosLoading` (the custom SVG
 * hexagon spinner) as the visual reference.
 *
 * Colors are resolved from the design system: semantic colors (red, green,
 * amber, violet, indigo) come from `semanticColors`, surface-adaptive tokens
 * (muted text) come from `useColors()`, and the Teros brand color (indigo) is kept as
 * a local constant since it is not part of the semantic palette.
 *
 * Usage:
 *   <AppSpinner />
 *   <AppSpinner size="lg" variant="brand" />
 *   <AppSpinner size="sm" variant="muted" />
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

// ─── Brand color (Teros indigo) ─────────────────────────────────────────────

const BRAND_COLOR = semanticColors.indigo;

// ─── Variant type ───────────────────────────────────────────────────────────

export type SpinnerVariant =
  | 'default'
  | 'brand'
  | 'muted'
  | 'danger'
  | 'success'
  | 'warning'
  | 'board'
  | 'onDark';

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
    default: semanticColors.indigo,
    brand: BRAND_COLOR,
    muted: c.text3,
    danger: semanticColors.red,
    success: semanticColors.green,
    warning: semanticColors.amber,
    board: semanticColors.violet,
    onDark: isDark ? '#FFFFFF' : c.text,
  };

  const resolvedSize = spinnerSizes[size];
  const resolvedColor = color ?? variantColors[variant];

  return <TerosLoading size={resolvedSize} color={resolvedColor} />;
}
