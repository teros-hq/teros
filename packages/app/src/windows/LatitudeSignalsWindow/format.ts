/**
 * Presentation helpers for the Latitude signals dashboard (F4 · C2). Local so the
 * window stays self-contained (mirrors SessionTraceWindow/format.ts).
 *
 * The REST read exposes NO `priority`, so — unlike the C1 badge — the accent comes
 * from the lifecycle `states[]`: escalating (getting worse) is loudest, then new,
 * then ongoing; a muted signal is greyed regardless.
 */

export type SignalLevel = "ok" | "warn" | "bad" | "muted" | "info"

/** Colour-blind-safe palette, always paired with text/icon in the UI. */
export const SIGNAL_COLORS: Record<SignalLevel, string> = {
  ok: "#3B82F6",
  warn: "#F59E0B",
  bad: "#EF4444",
  muted: "#9CA3AF",
  info: "#06B6D4",
}

const STATE_LEVEL: Record<string, SignalLevel> = {
  escalating: "bad",
  new: "warn",
  ongoing: "info",
}
/** Higher = louder; picks the accent when a signal holds several states. */
const STATE_RANK: Record<string, number> = { escalating: 3, new: 2, ongoing: 1 }

export const stateLevel = (state: string): SignalLevel => STATE_LEVEL[state] ?? "muted"

/** The accent for a whole signal: muted wins; else the loudest state's colour. */
export function signalAccent(states: string[], muted: boolean): string {
  if (muted) return SIGNAL_COLORS.muted
  const worst = [...states].sort((a, b) => (STATE_RANK[b] ?? 0) - (STATE_RANK[a] ?? 0))[0]
  return SIGNAL_COLORS[worst ? stateLevel(worst) : "muted"]
}

/** [0,1] → "25%" (rounded); "—" for a non-finite input. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—"
  return `${Math.round(fraction * 100)}%`
}

/** ISO/epoch → local date-time; "—" when absent/invalid. */
export function formatWhen(at: string | number | null | undefined): string {
  if (at == null) return "—"
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

/** integer count → "1,234". */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return new Intl.NumberFormat("en-US").format(Math.round(n))
}
