/**
 * Presentation helpers for the session-trace window (F2 / TER-643). Small and
 * local so the window stays self-contained (the duplicated `formatMs` with
 * ModelHealthWindow is 4 lines — not worth coupling two windows over).
 */

export type TraceStatusLevel = "ok" | "warn" | "bad" | "muted" | "info"

/** Colour-blind-safe palette, always paired with text/icon in the UI. */
export const STATUS_COLORS: Record<TraceStatusLevel, string> = {
  ok: "#3B82F6",
  warn: "#F59E0B",
  bad: "#EF4444",
  muted: "#9CA3AF",
  info: "#06B6D4",
}

/** ms → human ("820ms", "3.40s", "12.1s"). */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}

/** USD → "$0.0021" / "$1.23" (more decimals when tiny so it never reads $0.00). */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—"
  if (usd === 0) return "$0"
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return new Intl.NumberFormat("en-US").format(Math.round(n))
}

/** byte count → "1.2 KB" / "3.4 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** ISO/epoch → local clock time. */
export function formatClock(at: string | number | null | undefined): string {
  if (at == null) return "—"
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString()
}

const TOOL_STATUS_LEVEL: Record<string, TraceStatusLevel> = {
  success: "ok",
  error: "bad",
  permission_denied: "warn",
  aborted: "muted",
  running: "info",
}
export const toolStatusLevel = (status: string): TraceStatusLevel =>
  TOOL_STATUS_LEVEL[status] ?? "muted"

const SESSION_STATUS_LEVEL: Record<string, TraceStatusLevel> = {
  completed: "ok",
  errored: "bad",
  timed_out: "warn",
  aborted: "muted",
  running: "info",
}
export const sessionStatusLevel = (status: string): TraceStatusLevel =>
  SESSION_STATUS_LEVEL[status] ?? "muted"

/** Short label for an upstream×model (drops provider path prefixes). */
export function shortModel(modelId: string): string {
  return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId
}
