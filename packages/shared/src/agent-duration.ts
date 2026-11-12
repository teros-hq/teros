/**
 * Agent-duration formatting (WS2 — horas de agente por conversación/tarea).
 *
 * One formatter for every surface that shows "how much agent time this
 * conversation/task has consumed": chat header chip, conversations list row,
 * task card badge, task detail row. All of them render the SAME numbers the
 * quota discounts (`user-api.my-usage-channels-summary`, sum semantics,
 * decision #29), so they must also agree on how those numbers are written.
 *
 * Rules (Pablo, 2026-10-25):
 *   - `< 60 min`  → `Xm` — starts at `0m` (never seconds, never `45s`)
 *   - `≥ 60 min`  → hours ONLY, ONE decimal: `1.0h`, `2.3h`, `5.4h`, `26.1h`
 *                  (no `2h 20m` style — past 59 minutes we stop showing minutes)
 *   - Floor (truncate down) at the displayed digit — conservative: never
 *     shows MORE than was used (2h20m = 2.33h → `2.3h`, not `2.4h`).
 *   - Unit glued to the number, lowercase — matches the time-ago style
 *     (`10h`, `2d`) these chips sit next to.
 *
 * i18n-ready: the string form uses the unit labels in `AGENT_DURATION_UNITS`;
 * `formatAgentDurationParts` exposes the raw h/m decomposition for consumers
 * that want to translate/rebuild it differently.
 */

/** Unit labels used by the default (non-translated) string form. */
export const AGENT_DURATION_UNITS = {
  h: 'h',
  m: 'm',
} as const

/**
 * The raw pieces — i18n consumers translate `unit` and rejoin.
 * `unit` is 'm' below one hour, 'h' from one hour up.
 */
export interface AgentDurationParts {
  hours: number
  minutes: number
  /** 'h' | 'm' — which unit the display leads with ('m' when < 60 min). */
  unit: 'h' | 'm'
}

/**
 * Split a duration in milliseconds into display pieces (floor, no rounding up).
 * Negative or non-finite input is clamped to 0.
 */
export function formatAgentDurationParts(ms: number): AgentDurationParts {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalMinutes = Math.floor(safe / 60_000)
  if (totalMinutes < 60) {
    return { hours: 0, minutes: totalMinutes, unit: 'm' }
  }
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    unit: 'h',
  }
}

/**
 * Format a duration in milliseconds for the agent-hours surfaces:
 *   0        → '0m'
 *   30m      → '30m'
 *   59m59s   → '59m'           (floor — conservative)
 *   60m      → '1.0h'          (the ≥60min switch to hours-only)
 *   2h20m    → '2.3h'          (2.333h floored to one decimal)
 *   2h       → '2.0h'
 *   26h5m    → '26.0h'         (26.083h floored to one decimal)
 */
export function formatAgentDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalMinutes = Math.floor(safe / 60_000)
  if (totalMinutes < 60) {
    return `${totalMinutes}${AGENT_DURATION_UNITS.m}`
  }
  // ≥ 1h: hours only, ONE decimal, floored — never show more than was used.
  const hours = Math.floor((totalMinutes / 60) * 10) / 10
  return `${hours.toFixed(1)}${AGENT_DURATION_UNITS.h}`
}
