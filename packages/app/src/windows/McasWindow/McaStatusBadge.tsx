import type React from "react"
import { Badge as DsBadge, type BadgeTone } from "../../components/ui/ds"
import { STATUS_COLORS } from "./mcaHealth.utils"

/** `STATUS_COLORS` hex → design-system badge tone (g / r / a / muted). */
const TONE_BY_HEX: Record<string, BadgeTone> = {
  [STATUS_COLORS.ok.toUpperCase()]: "g",
  [STATUS_COLORS.fail.toUpperCase()]: "r",
  [STATUS_COLORS.partial.toUpperCase()]: "a",
  [STATUS_COLORS.pending.toUpperCase()]: "muted",
}

export function toneForStatusColor(color: string): BadgeTone {
  return TONE_BY_HEX[color.toUpperCase()] ?? "neutral"
}

/** Small pill used for availability / overall-status labels across the health dashboard. */
export function Badge({
  children,
  color,
}: {
  children: React.ReactNode
  color: string
  icon?: React.ReactNode
}) {
  const tone = toneForStatusColor(color)
  return (
    <DsBadge tone={tone} dot={tone !== "neutral" && tone !== "muted"} sm pill>
      {children}
    </DsBadge>
  )
}
