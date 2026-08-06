/**
 * Chart drill-down helpers (A5.3 / TER-672) — the #1 triage gesture: tap a bar,
 * open the sessions of that time bucket. Pure so it can be mutation-tested.
 */

/**
 * Period presets shared by the monitoring windows. Each window still keeps its
 * own structurally-identical literal today; this is the shared alias the drill
 * helpers type against (structural typing makes them interchangeable).
 */
export type Period = "1h" | "24h" | "7d" | "30d"

/**
 * Map a bar index to the `[from, to)` range of its bucket. `to` is the NEXT
 * bucket's start (buckets are contiguous), or `fallbackTo` (the view's `to`) for
 * the last bar. Returns `null` for an out-of-range index — the caller then does
 * not open a drill.
 */
export function bucketRange(
  isos: readonly string[],
  index: number,
  fallbackTo: string,
): { from: string; to: string } | null {
  // `isos[index]` is undefined for any out-of-range/negative index (and "" is
  // falsy) → the single `!from` guard covers every non-drillable case.
  const from = isos[index]
  if (!from) return null
  const to = isos[index + 1] ?? fallbackTo
  return { from, to }
}

/**
 * Props a chart-bar drill passes to the `agent-usage` window: the bucket range
 * plus the originating period so the drilled view keeps the investigation's
 * period label (A5.4). Shape mirrors `AgentActivityProps`.
 */
export function drillToAgentUsageProps(
  range: { from: string; to: string },
  period: Period,
): { initialFrom: string; initialTo: string; initialPeriod: Period } {
  return { initialFrom: range.from, initialTo: range.to, initialPeriod: period }
}
