/**
 * Time-bucket helpers shared by the monitoring windows (2026-07-07 audit).
 *
 * The `-tokens-per-hour` response returns one row per (bucket × groupKey) —
 * up to 9 rows for the same hour in real data. KPI sparklines/deltas must run
 * on ONE point per time bucket, and charts must render a UNIFORM time axis
 * (a missing hour is a zero, not an invisible gap), so both concerns live
 * here as pure, mutation-testable functions.
 */

import type { AgentUsageBucket } from "../../services/AdminApi"

export type BucketUnit = "hour" | "day"

export interface TimeBucketPoint {
  /** Bucket start, ISO-8601 UTC. */
  bucket: string
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  totalTokens: number
  costUsd: number
  activeHours: number
  sessionCount: number
}

const UNIT_MS: Record<BucketUnit, number> = { hour: 3_600_000, day: 86_400_000 }

/** Adaptive unit for a period length: ≤ 2 days → hour buckets, else day. */
export function unitForPeriodMs(periodMs: number): BucketUnit {
  return periodMs > 2 * UNIT_MS.day ? "day" : "hour"
}

function zeroPoint(bucketIso: string): TimeBucketPoint {
  return {
    bucket: bucketIso,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    activeHours: 0,
    sessionCount: 0,
  }
}

/**
 * Collapse (bucket × groupKey) rows into ONE point per time bucket (ascending).
 * This is what sparklines/deltas must consume — mapping the raw rows gives a
 * series with several points per hour and trends that split by row count.
 */
export function aggregateBucketsByTime(buckets: AgentUsageBucket[]): TimeBucketPoint[] {
  const byBucket = new Map<string, TimeBucketPoint>()
  for (const b of buckets) {
    const point = byBucket.get(b.bucket) ?? zeroPoint(b.bucket)
    point.inputTokens += b.inputTokens
    point.outputTokens += b.outputTokens
    point.cachedReadTokens += b.cachedReadTokens
    point.totalTokens += b.totalTokens
    point.costUsd += b.costUsd
    point.activeHours += b.activeHours
    point.sessionCount += b.sessionCount
    byBucket.set(b.bucket, point)
  }
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
}

/** Truncate an epoch to its UTC bucket start. */
function truncToUnit(ms: number, unit: BucketUnit): number {
  return Math.floor(ms / UNIT_MS[unit]) * UNIT_MS[unit]
}

/**
 * Densify a per-bucket series over `[from, to)`: every expected bucket appears
 * exactly once, zero-filled when absent — so the time axis is uniform and a
 * quiet hour is visibly a zero instead of an invisible gap (finding N6).
 */
export function fillTimeBuckets(
  points: TimeBucketPoint[],
  fromIso: string,
  toIso: string,
  unit: BucketUnit,
): TimeBucketPoint[] {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return points
  const byIso = new Map(points.map((p) => [Date.parse(p.bucket), p]))
  const out: TimeBucketPoint[] = []
  for (let t = truncToUnit(from, unit); t < to; t += UNIT_MS[unit]) {
    out.push(byIso.get(t) ?? zeroPoint(new Date(t).toISOString()))
  }
  return out
}

/**
 * Densify any `hourBucket`-keyed series (e.g. the model-health time-series)
 * over `[from, to)` — same uniform-axis guarantee as `fillTimeBuckets`, for
 * series whose element shape the caller owns.
 */
export function fillSeriesBuckets<T extends { hourBucket: string }>(
  series: T[],
  fromIso: string,
  toIso: string,
  unit: BucketUnit,
  makeEmpty: (iso: string) => T,
): T[] {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return series
  const byMs = new Map(series.map((s) => [Date.parse(s.hourBucket), s]))
  const out: T[] = []
  for (let t = truncToUnit(from, unit); t < to; t += UNIT_MS[unit]) {
    out.push(byMs.get(t) ?? makeEmpty(new Date(t).toISOString()))
  }
  return out
}

/**
 * Provider chips from the loaded KPI buckets: LOGICAL provider → session
 * count (P4). The logical id (`teros`, `anthropic`, …) is the key every
 * backend query filters by; deriving chips from `actualProvider` (fireworks/
 * together) zeroed the dashboard when a chip was selected.
 */
export function providerCountsFromBuckets(buckets: AgentUsageBucket[]): [string, number][] {
  const m = new Map<string, number>()
  for (const b of buckets) {
    const p = b.groupKey?.provider
    if (!p) continue
    m.set(p, (m.get(p) ?? 0) + b.sessionCount)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

/** Client-side exact provider scope for rows that carry `groupKey.provider`. */
export function filterBucketsByProvider(
  buckets: AgentUsageBucket[],
  provider: string | undefined,
): AgentUsageBucket[] {
  if (!provider) return buckets
  return buckets.filter((b) => b.groupKey?.provider === provider)
}

/**
 * Trend over a per-bucket series: sum of the 2nd half vs the 1st (▲/▼ %).
 * Runs on the AGGREGATED, DENSE series so the halves split by time. `null`
 * when there isn't enough signal to claim a trend.
 */
export function pctDeltaOverTime(values: number[]): { text: string; up: boolean } | null {
  if (values.length < 4) return null
  const mid = Math.floor(values.length / 2)
  const a = values.slice(0, mid).reduce((x, y) => x + y, 0)
  const b = values.slice(mid).reduce((x, y) => x + y, 0)
  if (a === 0) return b > 0 ? { text: "▲ new", up: true } : null
  const d = (b - a) / a
  if (!Number.isFinite(d) || Math.abs(d) < 0.005) return null
  return { text: `${d >= 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(0)}%`, up: d >= 0 }
}

/**
 * Tz-aware bucket label. Hour buckets: `16:00` (plus `Jul 7` when the span
 * crosses days); day buckets: `Jul 7`. Replaces the HH:00-only labels that
 * made a 30-day chart read `16:00 18:00 10:00…` with no dates (P5).
 */
export function bucketLabel(iso: string, unit: BucketUnit, withDate: boolean): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  if (unit === "day") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  const hour = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
  return withDate ? `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hour}` : hour
}
