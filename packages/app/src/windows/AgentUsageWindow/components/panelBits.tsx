/**
 * Small shared bits for the Agent Activity detail panels — a proportion bar,
 * the honest-degradation note and a headline stat. Kept together so every
 * panel communicates a gap the SAME way ("not measured for this provider",
 * never a fake 0). Drawn in the OS prototype vocabulary: thin violet bars on
 * the wash track, serif figures, mono percentages.
 */

import type { ReactNode } from "react"
import { View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import { T } from "../../../components/ui/ds/Text"

/** Horizontal proportion bar (0..1) — 6px, `c.wash` track, `c.accent` fill. No SVG (jsdom-safe). */
export function HBar({
  value,
  color,
  height = 6,
  track,
}: {
  value: number
  color?: string
  height?: number
  track?: string
}) {
  const c = useColors()
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100
  return (
    <View
      style={{
        flex: 1,
        height,
        borderRadius: height / 2,
        backgroundColor: track ?? c.wash,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${pct}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: color ?? c.accent,
        }}
      />
    </View>
  )
}

/**
 * Honest empty / degradation note. `tone="muted"` for "no data in range",
 * `tone="warn"` for "not measured here" (a real gap the panel must not fake).
 */
export function PanelNote({
  children,
  tone = "muted",
}: {
  children: string
  tone?: "muted" | "warn"
}) {
  const c = useColors()
  return (
    <T step="sm" color={tone === "warn" ? c.tint.a.tx : c.text3} style={{ paddingVertical: 8 }}>
      {children}
    </T>
  )
}

/** A compact stat cell for a row of panel headline numbers (label · serif figure · sub). */
export function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub?: string
  color?: string
}) {
  const c = useColors()
  return (
    <View style={{ gap: 2, minWidth: 120 }}>
      <T step="sm" tone="text2">
        {label}
      </T>
      <T step="2xl" color={color ?? c.text} numberOfLines={1}>
        {value}
      </T>
      {sub ? (
        <T step="sm" tone="text3">
          {sub}
        </T>
      ) : null}
    </View>
  )
}

/** A row of `Stat`s with the prototype's gap. */
export function StatRow({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 32, marginBottom: 4 }}>
      {children}
    </View>
  )
}

/** Label · bar · mono value · mono % — the prototype's "Por modelo" row. */
export function BarRow({
  label,
  value,
  valueText,
  pctText,
  color,
  labelWidth = 110,
}: {
  label: string
  value: number
  valueText: string
  pctText?: string
  color?: string
  labelWidth?: number
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <T step="sm" tone="text2" numberOfLines={1} style={{ width: labelWidth }}>
        {label}
      </T>
      <HBar value={value} color={color} />
      <T step="code" tone="text2" style={{ width: 72, textAlign: "right" }}>
        {valueText}
      </T>
      {pctText != null ? (
        <T step="code" tone="text3" style={{ width: 44, textAlign: "right" }}>
          {pctText}
        </T>
      ) : null}
    </View>
  )
}
