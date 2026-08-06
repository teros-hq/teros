/**
 * Pure computations for the agent usage dashboard.
 *
 * Everything in this file is a deterministic function — no React, no side
 * effects, no time-of-day dependency. This lets the main component drop
 * the corresponding `useMemo` closures and gain testability for free.
 *
 * Hierarchy of derivations:
 *
 *     buckets   ──►  aggregateBuckets()      ──► kpis (sessions/tokens/cost/hours)
 *               └►   computeKpiSparklines()  ──► per-timestamp series
 *                                              └► computeKpiTrends()  ──► % deltas
 *
 * Trend semantics: "first-half vs second-half of the period". Cheap proxy
 * for accelerometer-style intuition without needing a `previous-period`
 * round-trip to the backend. See `computeTrendPct` for the divide-by-zero
 * guard.
 */

import type { AgentUsageBucket } from "../../services/AdminApi"

// =============================================================================
// KPI aggregation
// =============================================================================

export interface KpiAggregate {
  sessions: number
  tokens: number
  costUsd: number
  activeHours: number
}

/** Sum the bucket array into a single KPI aggregate. Treats missing fields
 *  as 0 (preserves the inline behavior the dashboard had since v1). */
export function aggregateBuckets(buckets: AgentUsageBucket[]): KpiAggregate {
  return buckets.reduce<KpiAggregate>(
    (acc, b) => ({
      sessions: acc.sessions + (b.sessionCount ?? 0),
      tokens: acc.tokens + (b.totalTokens ?? 0),
      costUsd: acc.costUsd + (b.costUsd ?? 0),
      activeHours: acc.activeHours + (b.activeHours ?? 0),
    }),
    { sessions: 0, tokens: 0, costUsd: 0, activeHours: 0 },
  )
}

// =============================================================================
// Sparkline series
// =============================================================================

export interface KpiSparklines {
  sessions: number[]
  tokens: number[]
  cost: number[]
  hours: number[]
}

/**
 * Collapse buckets to per-timestamp series (oldest → newest), summing
 * across the per-bucket dimensions (multiple agents in a single time
 * window roll up to one point). Returns `null` for <2 buckets — the
 * caller hides the sparkline in that case.
 */
export function computeKpiSparklines(
  buckets: AgentUsageBucket[],
): KpiSparklines | null {
  if (buckets.length < 2) return null
  const map = new Map<
    string,
    { time: number; sessions: number; tokens: number; cost: number; hours: number }
  >()
  for (const b of buckets) {
    const t = new Date(b.bucket).getTime()
    const key = String(t)
    let e = map.get(key)
    if (!e) {
      e = { time: t, sessions: 0, tokens: 0, cost: 0, hours: 0 }
      map.set(key, e)
    }
    e.sessions += b.sessionCount ?? 0
    e.tokens += b.totalTokens ?? 0
    e.cost += b.costUsd ?? 0
    e.hours += b.activeHours ?? 0
  }
  const ordered = [...map.values()].sort((a, b) => a.time - b.time)
  return {
    sessions: ordered.map((e) => e.sessions),
    tokens: ordered.map((e) => e.tokens),
    cost: ordered.map((e) => e.cost),
    hours: ordered.map((e) => e.hours),
  }
}

// =============================================================================
// Trend deltas
// =============================================================================

export interface KpiTrends {
  sessions: number | null
  tokens: number | null
  cost: number | null
  hours: number | null
}

/**
 * Percentage delta between `current` and `previous`.
 *   - Returns `null` if either input is non-finite or `previous` is 0
 *     (divide-by-zero / Infinity guard).
 *   - Uses `Math.abs(previous)` as the denominator so a swing from
 *     `-10 → +10` registers as `+200%` (not `-200%`).
 */
export function computeTrendPct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null
  if (previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

/**
 * First-half vs second-half percentage delta over a single series. Returns
 * `null` when the series has fewer than 2 points (no signal possible).
 */
export function splitHalfTrend(series: number[]): number | null {
  if (series.length < 2) return null
  const mid = Math.floor(series.length / 2)
  const firstHalf = series.slice(0, mid).reduce((s, v) => s + v, 0)
  const secondHalf = series.slice(mid).reduce((s, v) => s + v, 0)
  return computeTrendPct(secondHalf, firstHalf)
}

/** Convenience wrapper: apply `splitHalfTrend` to each KPI series. */
export function computeKpiTrends(sparklines: KpiSparklines | null): KpiTrends | null {
  if (!sparklines) return null
  return {
    sessions: splitHalfTrend(sparklines.sessions),
    tokens: splitHalfTrend(sparklines.tokens),
    cost: splitHalfTrend(sparklines.cost),
    hours: splitHalfTrend(sparklines.hours),
  }
}
