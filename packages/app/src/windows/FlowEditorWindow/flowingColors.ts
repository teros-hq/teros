/**
 * flowingColors — Color utilities replicating Flowing's Tailwind shade system
 *
 * Flowing uses Tailwind color names (e.g. 'slate', 'blue') with shade maps
 * (300, 500, 600) to derive fill/stroke colors. Teros artifacts store colors
 * as hex values, so we use lighten/darken functions to approximate the same
 * visual effect.
 *
 * Mapping:
 *   shade-300 (light fill)   ≈ lightenColor(hex, 0.35)
 *   shade-500 (dark bg edge) ≈ darkenColor(hex, 0.20)
 *   shade-600 (dark stroke)  ≈ darkenColor(hex, 0.35)
 */

// ============================================================================
// COLOR MANIPULATION
// ============================================================================

/**
 * Darken a hex color by a given amount (0-1).
 */
export function darkenColor(hex: string, amount: number = 0.3): string {
  const match = hex.match(/^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i);
  if (!match) return hex;
  const r = Math.round(parseInt(match[1], 16) * (1 - amount));
  const g = Math.round(parseInt(match[2], 16) * (1 - amount));
  const b = Math.round(parseInt(match[3], 16) * (1 - amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Lighten a hex color by mixing it with white by a given amount (0-1).
 * amount=0 returns the original color, amount=1 returns white.
 */
export function lightenColor(hex: string, amount: number = 0.35): string {
  const match = hex.match(/^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i);
  if (!match) return hex;
  const r = Math.round(parseInt(match[1], 16) + (255 - parseInt(match[1], 16)) * amount);
  const g = Math.round(parseInt(match[2], 16) + (255 - parseInt(match[2], 16)) * amount);
  const b = Math.round(parseInt(match[3], 16) + (255 - parseInt(match[3], 16)) * amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ============================================================================
// FLOWING COLOR CONSTANTS
// ============================================================================

/** Signal gate color (slate equivalent) */
export const SIGNAL_COLOR = '#64748B';       // slate-500
export const SIGNAL_FILL = '#CBD5E1';        // slate-300
export const SIGNAL_STROKE = '#475569';      // slate-600

/** Default edge color when no artifact color is available */
export const DEFAULT_EDGE_COLOR = '#64748B'; // slate-500

// ============================================================================
// GATE COLOR RESOLVER
// ============================================================================

export interface GateColors {
  /** Light fill color (shade-300 equivalent) */
  fill: string;
  /** Dark stroke color (shade-600 equivalent) */
  stroke: string;
}

/**
 * Resolve gate colors from an artifact's hex color.
 * Returns lightened fill and darkened stroke, matching Flowing's shade system.
 *
 * For signal gates (no artifact), returns slate colors.
 */
export function resolveGateColors(
  artifactColor: string | null | undefined,
): GateColors {
  if (!artifactColor) {
    return { fill: SIGNAL_FILL, stroke: SIGNAL_STROKE };
  }
  return {
    fill: lightenColor(artifactColor, 0.35),
    stroke: darkenColor(artifactColor, 0.35),
  };
}

// ============================================================================
// EDGE COLOR RESOLVER
// ============================================================================

export interface EdgeColors {
  /** Light foreground stroke (shade-300 equivalent) */
  light: string;
  /** Dark background stroke (shade-500 equivalent) */
  dark: string;
}

/**
 * Resolve edge colors from an artifact's hex color.
 * Flowing uses shade-300 for foreground and shade-500 for background.
 */
export function resolveEdgeColors(
  artifactColor: string | null | undefined,
): EdgeColors {
  if (!artifactColor) {
    return { light: SIGNAL_FILL, dark: SIGNAL_COLOR };
  }
  return {
    light: lightenColor(artifactColor, 0.35),
    dark: darkenColor(artifactColor, 0.20),
  };
}
