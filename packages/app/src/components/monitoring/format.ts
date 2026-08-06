/**
 * Shared monitoring formatters (matches the design's `monitoring-data` helpers).
 * Rates are fractions (0..1) as the backend emits them; `—` on non-finite.
 */

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return Math.round(n).toLocaleString("en-US")
}

/** Compact magnitude: 5800 → "5.8k", 5_800_000 → "5.8M". */
export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const a = Math.abs(n)
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`
  return String(Math.round(n))
}

/** ms → "820 ms" / "3.40 s" / "12.1 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

/** fraction → "x.y%". */
export function fmtPct(frac: number | null | undefined): string {
  if (frac == null || !Number.isFinite(frac)) return "—"
  return `${(frac * 100).toFixed(frac < 0.1 ? 1 : 0)}%`
}

export function fmtUSD(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—"
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** seconds → "3.2s" / "1.4m". */
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—"
  return sec >= 60 ? `${(sec / 60).toFixed(1)}m` : `${sec.toFixed(1)}s`
}

/** Drop provider path prefixes: `accounts/fireworks/models/kimi` → `kimi`. */
export function shortModel(id: string | null | undefined): string {
  if (!id) return ""
  return id.includes("/") ? (id.split("/").pop() ?? id) : id
}
