/**
 * Presentation helpers for the session-trace window (F2 / TER-643). Small and
 * local so the window stays self-contained (the duplicated `formatMs` with
 * ModelHealthWindow is 4 lines — not worth coupling two windows over).
 */

import { colors as semantic, type SurfaceTokens } from "../../components/mca/primitives/colors"
import type { BadgeTone } from "../../components/ui/ds/Badge"

export type TraceStatusLevel = "ok" | "warn" | "bad" | "muted" | "info"

/**
 * Colour-blind-safe palette (brand status ramp), always paired with text/icon
 * in the UI. Static — for presentation inside a render prefer `statusColor(c, level)`
 * so the colour follows the active theme.
 */
export const STATUS_COLORS: Record<TraceStatusLevel, string> = {
  ok: semantic.green,
  warn: semantic.amber,
  bad: semantic.red,
  muted: semantic.main500,
  info: semantic.purple300,
}

/** Level → `Badge` tone: ok green · warn amber · bad red · info violet · muted. */
export const STATUS_TONE: Record<TraceStatusLevel, BadgeTone> = {
  ok: "g",
  warn: "a",
  bad: "r",
  muted: "muted",
  info: "i",
}

/** Theme-aware level colour (`c.tint.*.tx`, `c.text3` for muted). */
export function statusColor(c: SurfaceTokens, level: TraceStatusLevel): string {
  switch (level) {
    case "ok":
      return c.tint.g.tx
    case "warn":
      return c.tint.a.tx
    case "bad":
      return c.tint.r.tx
    case "info":
      return c.tint.i.tx
    default:
      return c.text3
  }
}

/** Theme-aware level fill for bars/tiles (`c.tint.*.bd` is the saturated edge; `c.accent` for info). */
export function statusFill(c: SurfaceTokens, level: TraceStatusLevel): string {
  switch (level) {
    case "ok":
      return semantic.green
    case "warn":
      return semantic.amber
    case "bad":
      return semantic.red
    case "info":
      return c.accent
    default:
      return c.text3
  }
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
