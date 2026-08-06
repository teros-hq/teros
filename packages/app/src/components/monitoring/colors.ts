/**
 * Monitoring design tokens + health/status colors.
 *
 * Hex values mirror the Teros Design System tokens synced to Claude Design
 * (`teros-tokens.css`) so the implemented UI matches the approved "Monitoring
 * Suite" design 1:1. Consolidated here so theme work (TER) touches one file.
 * Health uses green→amber→red ALWAYS paired with an icon (never color alone).
 */

import {
  feedbackLevel,
  type HealthLevel,
  LEVEL_LABELS,
  rateLevel,
  successLevel,
  worseLevel,
} from "@teros/shared"

export type { HealthLevel }
export { worseLevel }

/** Session / turn / tool status vocabulary from the design's `statusMeta`. */
export type StatusKind =
  | "ok"
  | "completed"
  | "active"
  | "idle"
  | "warn"
  | "warning"
  | "error"
  | "failed"
  | "running"

export const tokens = {
  accent: "#5E6AD2",
  accentPress: "#3F4A9E",

  text: "#E4E4E7",
  textSecondary: "#D4D4D8",
  textTertiary: "#9CA3AF",
  textMuted: "#52525B",

  bg: "#0A0A0F",
  bgHover: "#12121A",
  bgPress: "#1A1A24",
  bgInner: "rgba(0,0,0,0.2)",
  bgDark: "rgba(0,0,0,0.3)",
  bgCard: "rgba(39,39,42,0.6)",
  gray800: "#14141E",
  gray600: "#2E2E3A",

  border: "rgba(255,255,255,0.04)",
  borderHover: "rgba(255,255,255,0.08)",
  borderFocus: "#5E6AD2",

  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
} as const

/**
 * Teros-standard thin scrollbar (web only; silently ignored on native).
 * Same values as the MCA renderers' `scrollStyle` — apply to EVERY ScrollView
 * in the monitoring suite (horizontal table scroll + vertical page scroll) so
 * scrollbars never fall back to the chunky browser default.
 */
export const scrollbarThin = {
  scrollbarWidth: "thin",
  scrollbarColor: "rgba(255,255,255,0.2) transparent",
} as const

export const levelColors: Record<HealthLevel, string> = {
  ok: tokens.success,
  warn: tokens.warning,
  critical: tokens.error,
}

/** The ONE severity vocabulary (re-exported from the shared source, TER-670). */
export const levelLabels = LEVEL_LABELS

/** Color for a level: warn→amber, critical→red, ok→muted (signal over noise). */
function levelToneColor(level: HealthLevel): string {
  return level === "critical" ? tokens.error : level === "warn" ? tokens.warning : tokens.textSecondary
}
/** Color for a "higher is better" level: ok→green, warn→amber, critical→red. */
function goodnessColor(level: HealthLevel): string {
  return level === "critical" ? tokens.error : level === "warn" ? tokens.warning : tokens.success
}

export interface StatusMeta {
  color: string
  /** icon name understood by the shared icon set (StatusDot/Pill). */
  icon: "check-circle" | "alert" | "x-circle" | "loader" | "clock"
  label: string
}

/** Maps a raw status string → color + icon + label (design's `statusMeta`). */
export function statusMeta(s: StatusKind | string): StatusMeta {
  switch (s) {
    case "ok":
    case "completed":
    case "active":
      return { color: tokens.success, icon: "check-circle", label: s === "ok" ? "Healthy" : s }
    case "idle":
      return { color: tokens.textTertiary, icon: "clock", label: "idle" }
    case "warn":
      return { color: tokens.warning, icon: "alert", label: "Watch" }
    case "warning":
      return { color: tokens.warning, icon: "alert", label: "truncated" }
    case "error":
      return { color: tokens.error, icon: "x-circle", label: "Failing" }
    case "failed":
      return { color: tokens.error, icon: "x-circle", label: "failed" }
    case "running":
      return { color: tokens.accent, icon: "loader", label: "running" }
    default:
      return { color: tokens.success, icon: "check-circle", label: String(s) }
  }
}

/**
 * Metric-tone: the cell colour for a numeric health metric, derived from the ONE
 * shared threshold source so a value never disagrees with the badge that reads
 * the same number (TER-670/A3.2). `v` is a PERCENTAGE (the UI's unit) → converted
 * to the fraction the shared bands use.
 *
 * Only the three metrics actually rendered survive; the old `sat`/`fallback`/
 * `toolerr`/`ttft` kinds were dead (no caller) and carried divergent thresholds.
 */
export function metricTone(kind: "err" | "success" | "fb", v: number): string {
  switch (kind) {
    case "err":
      // Bad-when-high; ok stays muted (don't paint every healthy cell green).
      return levelToneColor(rateLevel("error", v / 100))
    case "success":
      return goodnessColor(successLevel(v / 100))
    case "fb":
      return goodnessColor(feedbackLevel(v / 100))
  }
}
