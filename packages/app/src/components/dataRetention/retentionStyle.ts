/**
 * Visual mapping for the data-retention tiers.
 *
 * Each tier maps onto one of the design system's status tints (green = zero
 * retention, amber = retains, red = trains) and a Phosphor shield glyph. The
 * concrete colours come from the active theme via `useRetentionVisual()`, so the
 * badge/notice/modal follow light and dark mode.
 */

import type { RetentionTier } from "@teros/shared"
import type { TintKey } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"

export interface RetentionVisual {
  /** Status tint key of the theme (`c.tint[tint]`) — also the Badge tone. */
  tint: TintKey
  /** Phosphor icon name (kebab-case) for the tier. */
  icon: string
  /** Tile tone for the modal header. */
  tile: "mint" | "amber" | "pink"
}

export const RETENTION_VISUALS: Record<RetentionTier, RetentionVisual> = {
  zdr: { tint: "g", icon: "shield-check", tile: "mint" },
  retains: { tint: "a", icon: "shield", tile: "amber" },
  trains: { tint: "r", icon: "shield-warning", tile: "pink" },
}

/** Theme colours for a tier: foreground (icon + text), background and border. */
export function useRetentionVisual(
  tier: RetentionTier,
): RetentionVisual & { fg: string; bg: string; border: string } {
  const c = useColors()
  const visual = RETENTION_VISUALS[tier]
  const t = c.tint[visual.tint]
  return { ...visual, fg: t.tx, bg: t.bg, border: t.bd }
}
