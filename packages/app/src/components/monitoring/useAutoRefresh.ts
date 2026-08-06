/**
 * `useAutoRefresh()` — shared refresh clock for the monitoring windows
 * (2026-07-07 audit, P1/N1/N2).
 *
 * Nothing in the suite refreshed by itself, the Refresh button only reloaded
 * the model-health slice, and the time range was FROZEN at mount (`to = new
 * Date()` inside a memo keyed only on the period). Each window now keys its
 * range memo on `tick` too: every tick slides the window to "now" and every
 * data effect downstream refetches. `bump()` is the manual Refresh — same
 * mechanism, so the button refreshes EVERYTHING.
 *
 * The in-flight gauge keeps its own 5 s cadence (real-time signal); this
 * clock is for the rollup/session-backed data where 60 s is plenty.
 */

import { useCallback, useEffect, useState } from "react"

export const AUTO_REFRESH_MS = 60_000

export function useAutoRefresh(intervalMs: number = AUTO_REFRESH_MS): {
  /** Increments every interval (and on bump). Key range memos on it. */
  tick: number
  /** Manual refresh — advances the same clock so ALL data reloads. */
  bump: () => void
} {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  const bump = useCallback(() => setTick((t) => t + 1), [])

  return { tick, bump }
}
