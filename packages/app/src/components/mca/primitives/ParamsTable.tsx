/**
 * Params Table — used by Fallback Body and Permission flow (Renderer UX
 * Guide v2 §0, §8).
 *
 * The OS prototype's `.kvl`: a key/value list of a tool call's `input`
 *   • Key    — mono 11, text3, fixed 110px column.
 *   • Value  — sans 13, text2.
 *
 * Objects and arrays render as a compact placeholder (`{…}` / `[…N]`) in the
 * list — never expanded, no nesting, no JSON tree — and the exact payload sits
 * behind the "View JSON" disclosure (`JsonToggle`) for whoever needs it.
 *
 * Otherwise intentionally small and dumb: zero conditional branches per row.
 * The point is a legible "what was passed in" readout. For richer detail
 * views, write a custom renderer.
 */

import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { JsonToggle } from "./JsonToggle"

/** `.kvl` key column — `grid-template-columns: 110px 1fr`. */
const KEY_WIDTH = 110

export interface ParamsTableProps {
  params?: Record<string, unknown> | null
  /**
   * Label width in px. Default 110 — the prototype's `.kvl` key column.
   */
  labelWidth?: number
  /**
   * When `params` is empty/missing, show this hint. Default omits the
   * table entirely (renders nothing).
   */
  emptyHint?: string
  /**
   * Hard cap on rows rendered. If `params` exceeds this, the first
   * `maxRows - 1` are shown and a final row says `[+N more]`. Without
   * this, a tool that returns 10K input fields would freeze the RN
   * bridge mapping ParamsRow components. Default 50.
   */
  maxRows?: number
}

export function ParamsTable({
  params,
  labelWidth = KEY_WIDTH,
  emptyHint,
  maxRows = 50,
}: ParamsTableProps) {
  const entries = params ? Object.entries(params) : []

  if (entries.length === 0) {
    if (!emptyHint) return null
    return (
      <YStack>
        <T step="12" tone="text3">
          {emptyHint}
        </T>
      </YStack>
    )
  }

  const overflow = entries.length > maxRows
  const visible = overflow ? entries.slice(0, maxRows - 1) : entries
  const remaining = entries.length - visible.length

  return (
    <YStack gap={8}>
      <YStack gap={6}>
        {visible.map(([key, value]) => (
          <ParamsRow key={key} label={key} value={value} labelWidth={labelWidth} />
        ))}
        {overflow && (
          <T step="codenote" tone="text3" style={{ paddingTop: 2 }}>
            [+{remaining} more]
          </T>
        )}
      </YStack>
      <JsonToggle value={params} />
    </YStack>
  )
}

function ParamsRow({
  label,
  value,
  labelWidth,
}: {
  label: string
  value: unknown
  labelWidth: number
}) {
  return (
    <XStack alignItems="flex-start" gap={12}>
      <T
        step="code"
        tone="text3"
        numberOfLines={1}
        style={{ width: labelWidth, flexShrink: 0, fontSize: 11, lineHeight: 18 }}
      >
        {label}
      </T>
      <T
        step="sm"
        tone="text2"
        numberOfLines={3}
        style={{ flex: 1, minWidth: 0, lineHeight: 18 }}
        selectable
      >
        {formatValue(value)}
      </T>
    </XStack>
  )
}

/** @internal exported for unit tests only — do not import in renderers. */
export function formatValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "—"
  if (typeof value === "string") return value.length === 0 ? '""' : value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "bigint") return `${value.toString()}n`
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function") return "[Function]"
  if (value instanceof Date) {
    // toISOString() throws on Invalid Date — fall back to a marker rather
    // than crash the whole table render.
    try {
      return value.toISOString()
    } catch {
      return "[Invalid Date]"
    }
  }
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[…${value.length}]`
  if (typeof value === "object") {
    // Detect circular references defensively. We don't deep-print
    // anyway (`{…}` is the contract for objects per UX Guide v2 §0),
    // so the only thing we need to avoid is an unhandled throw.
    try {
      JSON.stringify(value)
      return "{…}"
    } catch {
      return "{circular}"
    }
  }
  return String(value)
}
