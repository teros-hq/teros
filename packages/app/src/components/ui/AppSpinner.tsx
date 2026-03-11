/**
 * AppSpinner — Unified spinner component
 *
 * Replaces all direct usages of React Native's `ActivityIndicator` and
 * Tamagui's `Spinner`. Internally uses `TerosLoading` (the custom SVG
 * hexagon spinner) as the visual reference.
 *
 * Usage:
 *   <AppSpinner />
 *   <AppSpinner size="lg" variant="brand" />
 *   <AppSpinner size="sm" variant="muted" />
 */

import React from 'react';
import { TerosLoading } from '../TerosLoading';

// ─── Size tokens ────────────────────────────────────────────────────────────

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

const spinnerSizes: Record<SpinnerSize, number> = {
  xs: 10,
  sm: 16,
  md: 24,
  lg: 48,
};

// ─── Color tokens ────────────────────────────────────────────────────────────

export type SpinnerVariant =
  | 'default'
  | 'brand'
  | 'muted'
  | 'danger'
  | 'success'
  | 'warning'
  | 'board'
  | 'onDark';

export const spinnerColors: Record<SpinnerVariant, string> = {
  default: '#3B82F6', // blue
  brand: '#06B6D4',   // cyan Teros
  muted: '#71717A',   // grey
  danger: '#EF4444',  // red
  success: '#22C55E', // green
  warning: '#F59E0B', // amber
  board: '#8B5CF6',   // violet
  onDark: '#FFFFFF',  // white
};

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
  const resolvedSize = spinnerSizes[size];
  const resolvedColor = color ?? spinnerColors[variant];

  return <TerosLoading size={resolvedSize} color={resolvedColor} />;
}
