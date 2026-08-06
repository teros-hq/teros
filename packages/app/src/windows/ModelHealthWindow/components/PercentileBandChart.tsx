/**
 * PercentileBandChart — the latency (or TTFT) spread of each
 * `actualProvider×modelId` as a HORIZONTAL band p50→p99 with the p95 marked
 * (TER-616 / F1, design "Latency percentiles"). Models are rows, latency is the
 * X axis — so a long-tailed upstream reads as a bar reaching far right, at a
 * glance, and the row order/colour matches the volume chart and heatmap.
 *
 * Drawn with react-native-svg by hand (no charting dep). SVG elements via
 * `React.createElement(... as any)` because react-native-svg's web types don't
 * line up with JSX under react-native-web (repo-wide pattern). Width is measured
 * (`useChartWidth`) so it fills the Card; height is row-derived.
 *
 * Accessibility: never colour-alone — each band's p50/p95/p99 ride in the
 * wrapper aria-label and the p95 value is printed next to its marker.
 */

import { seriesColor } from "@teros/shared"
import React from "react"
import { Circle, Line, Rect, Svg, Text as SvgText } from "react-native-svg"
import { Text, XStack, YStack } from "tamagui"
import type { ModelHealthSummary } from "../../../services/AdminApi"
import { useColors } from "../../../components/mca/primitives/useColors"
import { formatMs, modelLabel } from "../format"
import { useChartWidth } from "./useChartWidth"

type Metric = "latency" | "ttft"

const ROW_H = 34
const PAD = { top: 24, right: 26, bottom: 30, left: 176 }

export function PercentileBandChart({
  models,
  metric,
  width: widthProp,
}: {
  models: ModelHealthSummary[]
  metric: Metric
  /** Override the measured width (tests / fixed layouts). */
  width?: number
}) {
  const c = useColors()
  const [measured, onLayout] = useChartWidth(760)
  const width = widthProp ?? measured

  const series = models
    .map((m) => ({ model: m, p: metric === "latency" ? m.latency : m.ttft }))
    .filter((s) => s.p.count > 0 && s.p.p99 != null)

  if (series.length === 0) {
    return (
      <YStack width="100%" height={120} ai="center" jc="center" onLayout={onLayout}>
        <Text color={c.text2} fontSize={13}>
          No {metric === "latency" ? "latency" : "TTFT"} samples in range
        </Text>
      </YStack>
    )
  }

  const height = PAD.top + series.length * ROW_H + PAD.bottom
  const plotW = Math.max(1, width - PAD.left - PAD.right)
  const rawMax = Math.max(1, ...series.map((s) => s.p.p99 ?? 0))
  const mag = 10 ** Math.floor(Math.log10(rawMax))
  const xMax = Math.ceil(rawMax / (mag / 2)) * (mag / 2) || rawMax
  const xFor = (v: number) => PAD.left + (Math.min(v, xMax) / xMax) * plotW

  const svgChildren: React.ReactNode[] = []

  // Vertical gridlines + top axis labels (0 … xMax).
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax)
  ticks.forEach((t, i) => {
    const x = xFor(t)
    svgChildren.push(
      React.createElement(Line as any, {
        key: `grid-${i}`,
        x1: x,
        y1: PAD.top - 4,
        x2: x,
        y2: height - PAD.bottom,
        stroke: c.border,
        strokeWidth: 1,
      }),
      React.createElement(
        SvgText as any,
        { key: `xlab-${i}`, x, y: PAD.top - 10, fill: c.text3, fontSize: 10, textAnchor: i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle" },
        formatMs(t),
      ),
    )
  })

  series.forEach((s, row) => {
    const yc = PAD.top + row * ROW_H + ROW_H / 2
    const p50 = s.p.p50 ?? 0
    const p95 = s.p.p95 ?? 0
    const p99 = s.p.p99 ?? 0
    const color = seriesColor(`${s.model.actualProvider}::${s.model.modelId}`)
    const x50 = xFor(p50)
    const x95 = xFor(p95)
    const x99 = xFor(p99)

    svgChildren.push(
      // Row label (model + upstream), right-aligned into the gutter.
      React.createElement(
        SvgText as any,
        { key: `ylab-${row}`, x: PAD.left - 12, y: yc + 4, fill: c.text, fontSize: 12, textAnchor: "end" },
        modelLabel(s.model.actualProvider, s.model.modelId, 26),
      ),
      // Light spread p50→p99.
      React.createElement(Rect as any, {
        key: `spread-${row}`,
        x: x50,
        y: yc - 5,
        width: Math.max(2, x99 - x50),
        height: 10,
        rx: 5,
        fill: color,
        fillOpacity: 0.2,
      }),
      // Solid p50→p95 (the SLO-relevant portion).
      React.createElement(Rect as any, {
        key: `solid-${row}`,
        x: x50,
        y: yc - 5,
        width: Math.max(2, x95 - x50),
        height: 10,
        rx: 5,
        fill: color,
        fillOpacity: 0.55,
      }),
      // p95 marker (thick tick).
      React.createElement(Line as any, {
        key: `p95-${row}`,
        x1: x95,
        y1: yc - 9,
        x2: x95,
        y2: yc + 9,
        stroke: color,
        strokeWidth: 2.5,
      }),
      // p99 end cap (open circle).
      React.createElement(Circle as any, {
        key: `p99-${row}`,
        cx: x99,
        cy: yc,
        r: 4,
        fill: "transparent",
        stroke: color,
        strokeWidth: 1.5,
      }),
      // p95 value above the marker.
      React.createElement(
        SvgText as any,
        { key: `p95v-${row}`, x: x95, y: yc - 12, fill: color, fontSize: 10, fontWeight: "600", textAnchor: "middle" },
        formatMs(p95),
      ),
    )
  })

  const ariaLabel = series
    .map(
      (s) =>
        `${s.model.actualProvider} ${s.model.modelId}: p50 ${formatMs(s.p.p50 ?? 0)}, p95 ${formatMs(s.p.p95 ?? 0)}, p99 ${formatMs(s.p.p99 ?? 0)}`,
    )
    .join("; ")

  return (
    <YStack width="100%" gap={8} onLayout={onLayout}>
      <YStack width="100%" height={height} overflow="hidden" aria-label={`${metric} percentiles — ${ariaLabel}`}>
        {React.createElement(
          Svg as any,
          { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": true },
          ...svgChildren,
        )}
      </YStack>
      <XStack ai="center" gap={16} paddingLeft={PAD.left} flexWrap="wrap">
        <LegendSwatch color={c.text2} opacity={0.2} label="p50→p99 spread" />
        <LegendSwatch color={c.text} opacity={0.55} label="p50→p95" />
        <XStack ai="center" gap={5}>
          <YStack width={2.5} height={12} backgroundColor={c.text} />
          <Text fontSize={11} color={c.text2}>
            p95 marker
          </Text>
        </XStack>
      </XStack>
    </YStack>
  )
}

function LegendSwatch({ color, opacity, label }: { color: string; opacity: number; label: string }) {
  const c = useColors()
  return (
    <XStack ai="center" gap={5}>
      <YStack width={18} height={9} borderRadius={4} backgroundColor={color} opacity={opacity} />
      <Text fontSize={11} color={c.text2}>
        {label}
      </Text>
    </XStack>
  )
}
