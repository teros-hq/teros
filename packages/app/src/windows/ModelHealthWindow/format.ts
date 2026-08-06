/**
 * Presentation helpers for the model-health window (TER-616 / F1).
 *
 * The THRESHOLDS now live in one shared source (`@teros/shared`
 * monitoring-thresholds) so the frontend and the backend alerting agree and the
 * same number never paints two colours (TER-670). This module only re-exports
 * the level helpers (scoped by model class) and owns the presentation: the
 * colour palette (shared with `components/monitoring/colors.ts`) and formatting.
 */

import {
  type HealthLevel,
  latencyLevel as sharedLatencyLevel,
  LEVEL_LABELS,
  rateLevel as sharedRateLevel,
  worseLevel,
} from "@teros/shared"
import { levelColors } from "../../components/monitoring/colors"

export type { HealthLevel }
export { LEVEL_LABELS, worseLevel }

/** ok/warn/critical palette — the ONE monitoring palette (green/amber/red). */
export const LEVEL_COLORS = levelColors

/**
 * p95 latency/ttft level, scoped to the model's class so a reasoning model
 * (Kimi/GLM/o-series) — slow by nature — is not flagged critical just for
 * running tens of seconds (TER-670). Pass `modelId` for the class; omitting it
 * falls back to the stricter "standard" band.
 */
export function latencyLevel(
  metric: "latency" | "ttft",
  p95: number | null,
  modelId?: string,
): HealthLevel {
  return sharedLatencyLevel(metric, p95, modelId)
}

export const errorRateLevel = (r: number): HealthLevel => sharedRateLevel("error", r)
export const saturationLevel = (r: number): HealthLevel => sharedRateLevel("saturation", r)
export const fallbackLevel = (r: number): HealthLevel => sharedRateLevel("fallback", r)
export const toolErrorLevel = (r: number): HealthLevel => sharedRateLevel("toolError", r)
export const truncationLevel = (r: number): HealthLevel => sharedRateLevel("truncation", r)
export const emptyLevel = (r: number): HealthLevel => sharedRateLevel("empty", r)

export function percentileColor(
  metric: "latency" | "ttft",
  p95: number,
  modelId?: string,
): string {
  return LEVEL_COLORS[latencyLevel(metric, p95, modelId)]
}

/** ms → human ("820ms", "3.40s", "12.1s"). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}

/** fraction → "x.y%". `null`/`undefined`/non-finite ⇒ "—" (not measurable). */
export function formatPct(frac: number | null | undefined): string {
  if (frac == null || !Number.isFinite(frac)) return "—"
  return `${(frac * 100).toFixed(frac < 0.1 ? 1 : 0)}%`
}

/** Compact int with thousands separators. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n))
}

/**
 * Throughput as a human rate (F1.1). ≥1/min reads in minutes; a slower rate
 * switches to per-hour so it doesn't collapse to "0/min". One decimal under 10,
 * rounded above.
 */
export function formatRate(perMin: number): string {
  if (!Number.isFinite(perMin) || perMin <= 0) return "0/min"
  if (perMin >= 1) return `${perMin >= 10 ? Math.round(perMin) : perMin.toFixed(1)}/min`
  const perHour = perMin * 60
  return `${perHour >= 10 ? Math.round(perHour) : perHour.toFixed(1)}/h`
}

/**
 * Short, readable label for an upstream×model. Drops provider path prefixes
 * (`accounts/fireworks/models/kimi-k2p6` → `kimi-k2p6`) and truncates.
 */
export function modelLabel(actualProvider: string, modelId: string, max = 24): string {
  const short = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId
  const label = `${actualProvider}·${short}`
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}
