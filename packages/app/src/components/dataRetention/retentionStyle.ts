/**
 * Visual mapping for the data-retention tiers.
 *
 * Colours are kept local here (consistent with the surrounding onboarding /
 * agent-core UI, which uses hardcoded hex). The MCA primitive token system
 * (components/mca/primitives/colors.ts) is scoped to MCA renderers, not this
 * general settings UI.
 */

import { Shield, ShieldAlert, ShieldCheck } from '@tamagui/lucide-icons'
import type { RetentionTier } from '@teros/shared'

export interface RetentionVisual {
  /** Foreground (icon + text) colour. */
  fg: string
  /** Pill / banner background. */
  bg: string
  /** Border colour. */
  border: string
  /** Lucide icon component for the tier. */
  Icon: typeof Shield
}

export const RETENTION_VISUALS: Record<RetentionTier, RetentionVisual> = {
  zdr: {
    fg: '#34D399',
    bg: 'rgba(16, 185, 129, 0.12)',
    border: 'rgba(16, 185, 129, 0.35)',
    Icon: ShieldCheck,
  },
  retains: {
    fg: '#F59E0B',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'rgba(245, 158, 11, 0.35)',
    Icon: Shield,
  },
  trains: {
    fg: '#F87171',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'rgba(239, 68, 68, 0.35)',
    Icon: ShieldAlert,
  },
}
