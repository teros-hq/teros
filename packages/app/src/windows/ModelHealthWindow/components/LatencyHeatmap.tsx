/**
 * LatencyHeatmap — p95 latency (or TTFT) as a model × HOUR grid (TER-616 / F1,
 * design "p95 latency heatmap"). X = hour bucket, Y = model, cell colour = p95
 * on a violet alpha ramp (faint → solid as the cell gets slower within the
 * range), tinted amber / red when the cell crosses the shared warn / critical
 * threshold for its model class. Where PercentileBandChart answers "which
 * model has the longer tail right now?", the heatmap answers "WHEN did a model
 * get slow?" — the per-hour dimension the range-aggregate can't show.
 *
 * Reads the per-hour `series` (`ModelHealthHourBucket[]`, each hour carrying the
 * per-`actualProvider×modelId` summaries), the SAME data the volume chart uses —
 * so rows/colours line up. Drawn with react-native-svg by hand;
 * `React.createElement(... as any)` per the repo-wide RN-Web SVG typing pattern.
 *
 * Accessibility: never colour-alone — every non-empty cell carries an aria-label
 * with model + hour + p95, and the wrapper announces the min/max span.
 */

import React from "react"
import { View } from "react-native"
import { Rect, Svg, Text as SvgText } from "react-native-svg"
import type { ModelHealthHourBucket } from "../../../services/AdminApi"
import { colors as semantic } from "../../../components/mca/primitives/colors"
import { FONT_MONO, FONT_SANS } from "../../../components/mca/primitives/fonts"
import { useColors } from "../../../components/mca/primitives/useColors"
import { T } from "../../../components/ui/ds/Text"
import { formatMs, latencyLevel, modelLabel } from "../format"
import { useChartWidth } from "./useChartWidth"

type Metric = "latency" | "ttft"

const MAX_ROWS = 8
const CELL_H = 22
const ROW_GAP = 3
const PAD = { top: 8, right: 14, bottom: 40, left: 168 }

/** `#RRGGBB` → `rgba(r,g,b,a)` (falls back to the input for non-hex strings). */
function hexAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** Alpha for a normalised value: faint (0.14) → solid (0.9). */
const rampAlpha = (t: number) => 0.14 + Math.max(0, Math.min(1, t)) * 0.76

function hourLabel(iso: string, tz: string | undefined, unit: "hour" | "day"): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  try {
    // Day columns label as dates — an hourly time on a daily cell is noise (P5).
    if (unit === "day")
      return d.toLocaleDateString([], { timeZone: tz, month: "short", day: "numeric" })
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    })
  } catch {
    return `${String(d.getHours()).padStart(2, "0")}:00`
  }
}

export function LatencyHeatmap({
  series,
  metric = "latency",
  width: widthProp,
  bucketTimeZone,
  bucketUnit = "hour",
}: {
  series: ModelHealthHourBucket[]
  metric?: Metric
  /** Override the measured width (tests / fixed layouts). */
  width?: number
  bucketTimeZone?: string
  /** Column granularity — 'day' labels as dates (P5). */
  bucketUnit?: "hour" | "day"
}) {
  const c = useColors()
  const [measured, onLayout] = useChartWidth(760)
  const width = widthProp ?? measured

  // Rows = models by total volume (top MAX_ROWS); cols = hour buckets.
  const totals = new Map<
    string,
    { key: string; provider: string; modelId: string; total: number }
  >()
  for (const b of series) {
    for (const m of b.models) {
      const k = `${m.actualProvider}::${m.modelId}`
      const cur = totals.get(k) ?? {
        key: k,
        provider: m.actualProvider,
        modelId: m.modelId,
        total: 0,
      }
      cur.total += m.requestCount
      totals.set(k, cur)
    }
  }
  const rows = [...totals.values()].sort((a, b) => b.total - a.total).slice(0, MAX_ROWS)
  const p95At = (rowKey: string, col: number): number | null => {
    const m = series[col]?.models.find((x) => `${x.actualProvider}::${x.modelId}` === rowKey)
    const p = m ? (metric === "latency" ? m.latency : m.ttft) : null
    return p && p.count > 0 && p.p95 != null ? p.p95 : null
  }

  const cells: { row: number; col: number; v: number }[] = []
  rows.forEach((r, ri) => {
    series.forEach((_, ci) => {
      const v = p95At(r.key, ci)
      if (v != null) cells.push({ row: ri, col: ci, v })
    })
  })

  if (rows.length === 0 || cells.length === 0) {
    return (
      <View
        style={{ width: "100%", height: 96, alignItems: "center", justifyContent: "center" }}
        onLayout={onLayout}
      >
        <T step="sm" tone="text3">
          No {metric === "latency" ? "latency" : "TTFT"} distribution in range
        </T>
      </View>
    )
  }

  const vMin = Math.min(...cells.map((x) => x.v))
  const vMax = Math.max(...cells.map((x) => x.v))
  const norm = (v: number) => (vMax > vMin ? (v - vMin) / (vMax - vMin) : 0)

  /** Cell colour: violet ramp within the range; amber / red once past the model's threshold. */
  const cellColor = (v: number, modelId: string): string => {
    const level = latencyLevel(metric, v, modelId)
    const base = level === "critical" ? semantic.red : level === "warn" ? semantic.amber : c.accent
    return hexAlpha(base, rampAlpha(norm(v)))
  }

  const nCols = series.length
  const height = PAD.top + rows.length * (CELL_H + ROW_GAP) + PAD.bottom
  const plotW = Math.max(1, width - PAD.left - PAD.right)
  const cellW = plotW / nCols
  const labelEvery = Math.max(1, Math.ceil(nCols / 8))

  const svgChildren: React.ReactNode[] = []

  rows.forEach((r, ri) => {
    const y = PAD.top + ri * (CELL_H + ROW_GAP)
    svgChildren.push(
      React.createElement(
        SvgText as any,
        {
          key: `ylab-${ri}`,
          x: PAD.left - 10,
          y: y + CELL_H / 2 + 4,
          fill: c.text2,
          fontSize: 11,
          fontFamily: FONT_SANS,
          textAnchor: "end",
        },
        modelLabel(r.provider, r.modelId, 24),
      ),
    )
    series.forEach((_, ci) => {
      const x = PAD.left + ci * cellW
      const v = p95At(r.key, ci)
      svgChildren.push(
        React.createElement(Rect as any, {
          key: `cell-${ri}-${ci}`,
          x: x + 1,
          y,
          width: Math.max(1, cellW - 2),
          height: CELL_H,
          rx: 3,
          fill: v == null ? c.wash : cellColor(v, r.modelId),
          "aria-label":
            v == null
              ? undefined
              : `${modelLabel(r.provider, r.modelId, 40)} ${hourLabel(series[ci]!.hourBucket, bucketTimeZone, bucketUnit)}: p95 ${formatMs(v)}`,
        }),
      )
    })
  })

  // X-axis hour labels (adaptive density).
  series.forEach((b, ci) => {
    if (ci % labelEvery !== 0) return
    svgChildren.push(
      React.createElement(
        SvgText as any,
        {
          key: `xlab-${ci}`,
          x: PAD.left + ci * cellW + cellW / 2,
          y: height - PAD.bottom + 16,
          fill: c.text3,
          fontSize: 9,
          fontFamily: FONT_MONO,
          textAnchor: "middle",
        },
        hourLabel(b.hourBucket, bucketTimeZone, bucketUnit),
      ),
    )
  })

  const ariaLabel = `${metric} p95 heatmap — ${rows.length} models × ${nCols} hours, p95 ${formatMs(vMin)} to ${formatMs(vMax)}`

  return (
    <View style={{ width: "100%", gap: 8 }} onLayout={onLayout}>
      <View
        style={{ width: "100%", height, overflow: "hidden" }}
        {...({ "aria-label": ariaLabel } as any)}
      >
        {React.createElement(
          Svg as any,
          { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": true },
          ...svgChildren,
        )}
      </View>
      {/* ramp legend + threshold tints */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingLeft: PAD.left,
          flexWrap: "wrap",
        }}
      >
        <T step="codenote" tone="text2">
          {formatMs(vMin)}
        </T>
        <View
          style={{
            width: 140,
            height: 8,
            borderRadius: 4,
            overflow: "hidden",
            flexDirection: "row",
          }}
        >
          {Array.from({ length: 24 }, (_, i) => (
            <View
              key={i}
              style={{ flex: 1, backgroundColor: hexAlpha(c.accent, rampAlpha(i / 23)) }}
            />
          ))}
        </View>
        <T step="codenote" tone="text2">
          {formatMs(vMax)}
        </T>
        <T step="12" tone="text2">
          {metric === "latency" ? "p95 latency" : "p95 TTFT"} — faster ▸ slower
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginLeft: 6 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              backgroundColor: hexAlpha(semantic.amber, 0.7),
            }}
          />
          <T step="12" tone="text3">
            warn
          </T>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              backgroundColor: hexAlpha(semantic.red, 0.7),
              marginLeft: 6,
            }}
          />
          <T step="12" tone="text3">
            critical
          </T>
        </View>
      </View>
    </View>
  )
}
