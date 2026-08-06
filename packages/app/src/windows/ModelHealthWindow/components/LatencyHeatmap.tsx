/**
 * LatencyHeatmap — p95 latency (or TTFT) as a model × HOUR grid (TER-616 / F1,
 * design "p95 latency heatmap"). X = hour bucket, Y = model, cell colour = p95 on
 * a green→amber→red scale (faster→slower). Where PercentileBandChart answers
 * "which model has the longer tail right now?", the heatmap answers "WHEN did a
 * model get slow?" — the per-hour dimension the range-aggregate can't show.
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
import { Rect, Svg, Text as SvgText } from "react-native-svg"
import { Text, XStack, YStack } from "tamagui"
import type { ModelHealthHourBucket } from "../../../services/AdminApi"
import { useColors } from "../../../components/mca/primitives/useColors"
import { formatMs, modelLabel } from "../format"
import { useChartWidth } from "./useChartWidth"

type Metric = "latency" | "ttft"

const MAX_ROWS = 8
const CELL_H = 22
const ROW_GAP = 3
const PAD = { top: 8, right: 14, bottom: 40, left: 168 }

/** green(0) → amber(0.5) → red(1). t is clamped to [0,1]. */
function heatColor(t: number): string {
  const c = Math.max(0, Math.min(1, t))
  const stops = [
    [34, 197, 94],
    [245, 158, 11],
    [239, 68, 68],
  ]
  const [a, b, tt] = c < 0.5 ? [stops[0]!, stops[1]!, c * 2] : [stops[1]!, stops[2]!, (c - 0.5) * 2]
  const l = (i: number) => Math.round(a[i]! + (b[i]! - a[i]!) * tt)
  return `rgb(${l(0)},${l(1)},${l(2)})`
}

function hourLabel(iso: string, tz: string | undefined, unit: "hour" | "day"): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  try {
    // Day columns label as dates — an hourly time on a daily cell is noise (P5).
    if (unit === "day") return d.toLocaleDateString([], { timeZone: tz, month: "short", day: "numeric" })
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz })
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
  const totals = new Map<string, { key: string; provider: string; modelId: string; total: number }>()
  for (const b of series) {
    for (const m of b.models) {
      const k = `${m.actualProvider}::${m.modelId}`
      const cur = totals.get(k) ?? { key: k, provider: m.actualProvider, modelId: m.modelId, total: 0 }
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
      <YStack width="100%" height={96} ai="center" jc="center" onLayout={onLayout}>
        <Text color={c.text2} fontSize={13}>
          No {metric === "latency" ? "latency" : "TTFT"} distribution in range
        </Text>
      </YStack>
    )
  }

  const vMin = Math.min(...cells.map((c) => c.v))
  const vMax = Math.max(...cells.map((c) => c.v))
  const norm = (v: number) => (vMax > vMin ? (v - vMin) / (vMax - vMin) : 0)

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
        { key: `ylab-${ri}`, x: PAD.left - 10, y: y + CELL_H / 2 + 4, fill: c.text2, fontSize: 11, textAnchor: "end" },
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
          fill: v == null ? c.bgInner : heatColor(norm(v)),
          fillOpacity: v == null ? 1 : 0.9,
          "aria-label": v == null ? undefined : `${modelLabel(r.provider, r.modelId, 40)} ${hourLabel(series[ci]!.hourBucket, bucketTimeZone, bucketUnit)}: p95 ${formatMs(v)}`,
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
        { key: `xlab-${ci}`, x: PAD.left + ci * cellW + cellW / 2, y: height - PAD.bottom + 16, fill: c.text3, fontSize: 9, textAnchor: "middle" },
        hourLabel(b.hourBucket, bucketTimeZone, bucketUnit),
      ),
    )
  })

  const ariaLabel = `${metric} p95 heatmap — ${rows.length} models × ${nCols} hours, p95 ${formatMs(vMin)} to ${formatMs(vMax)}`

  return (
    <YStack width="100%" gap={8} onLayout={onLayout}>
      <YStack width="100%" height={height} overflow="hidden" aria-label={ariaLabel}>
        {React.createElement(
          Svg as any,
          { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": true },
          ...svgChildren,
        )}
      </YStack>
      {/* gradient legend */}
      <XStack ai="center" gap={10} paddingLeft={PAD.left}>
        <Text fontSize={10} fontFamily="$mono" color={c.text2}>
          {formatMs(vMin)}
        </Text>
        <XStack width={140} height={9} borderRadius={5} overflow="hidden">
          {Array.from({ length: 24 }, (_, i) => (
            <YStack key={i} flex={1} backgroundColor={heatColor(i / 23)} />
          ))}
        </XStack>
        <Text fontSize={10} fontFamily="$mono" color={c.text2}>
          {formatMs(vMax)}
        </Text>
        <Text fontSize={11} color={c.text2}>
          {metric === "latency" ? "p95 latency" : "p95 TTFT"} — faster ▸ slower
        </Text>
      </XStack>
    </YStack>
  )
}
