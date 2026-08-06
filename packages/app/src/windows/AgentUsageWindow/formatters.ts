/**
 * Display formatters for the agent usage dashboard.
 *
 * Pure functions extracted from `AgentUsageWindowContent.tsx`. They share a
 * convention: return `'—'` (em dash) for non-finite / undefined input so the
 * UI shows a stable placeholder instead of `NaN` or `Infinity`.
 *
 * No locale awareness here — the dashboard renders these as raw strings.
 * Locale formatting of dates uses `i18n.language` at the call site (see
 * `monthLabel` inside `QuotaBurnSection`).
 */

/**
 * Round-half-up to integer, prefix with k / M suffix for large magnitudes.
 *   999     → "999"
 *   1_000   → "1.0k"
 *   1_500_000 → "1.50M"
 *   NaN / Infinity → "—"
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return Math.round(n).toString()
}

/**
 * USD cost with magnitude-adaptive precision (MN2: avoid flooding the UI
 * with irrelevant decimals at large magnitudes).
 *   0       → "$0"
 *   0.0005  → "<$0.01"
 *   0.123   → "$0.123"
 *   42.5    → "$42.50"
 *   1234    → "$1,234"
 *   NaN     → "—"
 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n === 0) return "$0"
  if (n < 0.01) return `<$0.01`
  if (n < 1) return `$${n.toFixed(3)}`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

/**
 * Hours with 2-decimal precision and a trailing `h`.
 *   1.5  → "1.50 h"
 *   NaN  → "—"
 */
export function formatHours(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return `${n.toFixed(2)} h`
}

/**
 * Byte size with binary (1024) prefixes.
 *   0          → "0 B"
 *   500        → "500 B"
 *   2048       → "2.0 KB"
 *   1_500_000  → "1.4 MB"
 *   NaN        → "0 B" (matches the previous inline behavior)
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0 B"
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/**
 * Duration in milliseconds → human-readable string with adaptive unit.
 *   null / Infinity / NaN → "—"
 *   <1s     → "N ms"
 *   <1min   → "N.N s"
 *   <1h     → "N.N min"
 *   ≥1h     → "N.NN h"
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`
  return `${(ms / 3_600_000).toFixed(2)} h`
}

/**
 * Relative time ("Xs ago" / "Xm ago" / "Xh ago" / "Xd ago") from an ISO
 * timestamp string. Returns "—" for invalid inputs.
 */
export function relativeTime(iso: string): string {
  return relativeTimeFromMs(new Date(iso).getTime())
}

/**
 * Relative time from epoch milliseconds. The delta is clamped at 0 so a
 * future timestamp (clock skew) doesn't show "−5s ago".
 */
export function relativeTimeFromMs(t: number): string {
  if (!Number.isFinite(t)) return "—"
  const delta = Math.max(0, Date.now() - t)
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

/** Look up a name in a directory map; falls back to the id if not found, and
 *  to `'—'` if the id itself is missing. */
export function resolveName(
  map: Map<string, string>,
  id: string | undefined | null,
): string {
  if (!id) return "—"
  return map.get(id) ?? id
}
