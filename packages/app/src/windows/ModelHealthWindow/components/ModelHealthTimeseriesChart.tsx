/**
 * ModelHealthTimeseriesChart — request volume over time, one stacked bar per
 * hour split by `actualProvider×modelId` (F1.2). Answers "WHEN did load /
 * degradation happen?", which the range-aggregate charts (PercentileBandChart,
 * heatmap) can't show. Same hand-drawn react-native-svg approach as
 * `TokenTimeSeriesChart`/`PercentileBandChart` — no charting dependency.
 *
 * X axis = hour bucket (rendered in `bucketTimeZone`, adaptive label density);
 * Y axis = turns. Top-8 upstream×model by total get a stable colour; the rest
 * fold into grey "Other". The legend carries the per-model totals (the same
 * info a hover tooltip would, which react-native-web can't do reliably).
 *
 * Accessibility: a single wrapper aria-label announces the bucket count + span;
 * the SVG itself is aria-hidden, the legend is real text.
 */

import React from "react"
import { Line, Rect, Svg, Text as SvgText } from "react-native-svg"
import { Text, XStack, YStack } from "tamagui"
import type { ModelHealthHourBucket } from "../../../services/AdminApi"
import { useColors } from "../../../components/mca/primitives/useColors"
import { formatCount, modelLabel } from "../format"
import { useChartWidth } from "./useChartWidth"

const PALETTE = [
  "#3B82F6",
  "#22C55E",
  "#A855F7",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#84CC16",
  "#EF4444",
]
const OTHER_COLOR = "#71717A"

const DAY_MS = 86_400_000

function fmtTime(iso: string, tz: string, withDate: boolean, unit: "hour" | "day"): string {
  // Day buckets label as dates — a "00:00" time on a daily bar is noise (P5).
  if (unit === "day") {
    return new Date(iso).toLocaleDateString([], { timeZone: tz, month: "short", day: "numeric" })
  }
  return new Date(iso).toLocaleString([], {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    ...(withDate ? { month: "numeric", day: "numeric" } : {}),
  })
}

export function ModelHealthTimeseriesChart({
  series,
  bucketTimeZone,
  bucketUnit = "hour",
  width: widthProp,
  height = 220,
}: {
  series: ModelHealthHourBucket[]
  bucketTimeZone: string
  /** Bucket granularity — 'day' labels as dates (P5). */
  bucketUnit?: "hour" | "day"
  /** Override the measured width (tests / fixed layouts). */
  width?: number
  height?: number
}) {
  // Measured-width responsiveness (same pattern as PercentileBandChart /
  // LatencyHeatmap): the chart fills its Card instead of capping at a fixed
  // 720px box that left the right half of a wide window empty. The SVG draws
  // in real pixels — no viewBox scale, so height doesn't stretch with width.
  const c = useColors()
  const [measured, onLayout] = useChartWidth(720)
  const width = widthProp ?? measured
  // Per-bucket totals + per-model split, plus model metadata for the legend.
  const buckets = series.map((b) => {
    const perModel = new Map<string, number>()
    let total = 0
    for (const m of b.models) {
      const key = `${m.actualProvider}::${m.modelId}`
      perModel.set(key, (perModel.get(key) ?? 0) + m.requestCount)
      total += m.requestCount
    }
    return { time: new Date(b.hourBucket).getTime(), iso: b.hourBucket, perModel, total }
  })

  const maxTotal = Math.max(...buckets.map((b) => b.total), 0)
  if (buckets.length === 0 || maxTotal === 0) {
    return (
      <YStack width="100%" height={height} ai="center" jc="center" onLayout={onLayout}>
        <Text color={c.text2} fontSize={13}>
          No request volume in range
        </Text>
      </YStack>
    )
  }

  // Top-8 models by total volume; everything else folds into "Other".
  const modelTotals = new Map<string, number>()
  const modelMeta = new Map<string, { actualProvider: string; modelId: string }>()
  for (const b of series) {
    for (const m of b.models) {
      const key = `${m.actualProvider}::${m.modelId}`
      modelTotals.set(key, (modelTotals.get(key) ?? 0) + m.requestCount)
      if (!modelMeta.has(key)) modelMeta.set(key, { actualProvider: m.actualProvider, modelId: m.modelId })
    }
  }
  const topKeys = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k)
  const topSet = new Set(topKeys)
  const colorFor = (key: string) =>
    topSet.has(key) ? PALETTE[topKeys.indexOf(key) % PALETTE.length]! : OTHER_COLOR

  const padding = { top: 16, right: 16, bottom: 24, left: 44 }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom
  const stepX = innerW / buckets.length
  const barW = stepX * 0.75

  const span = buckets[buckets.length - 1]!.time - buckets[0]!.time
  const withDate = span > 2 * DAY_MS

  const svgChildren: React.ReactNode[] = []

  // Horizontal gridlines + Y labels (0, ½, max turns).
  for (const frac of [0, 0.5, 1]) {
    const y = padding.top + innerH * (1 - frac)
    svgChildren.push(
      React.createElement(Line as any, {
        key: `grid-${frac}`,
        x1: padding.left,
        x2: width - padding.right,
        y1: y,
        y2: y,
        stroke: c.border,
        strokeWidth: 1,
      }),
      React.createElement(
        SvgText as any,
        {
          key: `yl-${frac}`,
          x: padding.left - 6,
          y: y + 3,
          fill: c.text3,
          fontSize: 10,
          textAnchor: "end",
        },
        formatCount(maxTotal * frac),
      ),
    )
  }

  // Stacked bars: top models in stable order at the base, "Other" on top.
  buckets.forEach((b, i) => {
    const x = padding.left + i * stepX + (stepX - barW) / 2
    let cumY = padding.top + innerH
    const entries = [...b.perModel.entries()].sort((a, c) => {
      const ai = topSet.has(a[0]) ? topKeys.indexOf(a[0]) : 999
      const ci = topSet.has(c[0]) ? topKeys.indexOf(c[0]) : 999
      return ai - ci
    })
    entries.forEach(([key, n], j) => {
      const h = (n / maxTotal) * innerH
      cumY -= h
      svgChildren.push(
        React.createElement(Rect as any, {
          key: `bar-${i}-${j}`,
          x,
          y: cumY,
          width: barW,
          height: h,
          fill: colorFor(key),
          opacity: 0.85,
        }),
      )
    })
  })

  // X labels: first / middle / last bucket only (density > completeness).
  for (const idx of [0, Math.floor(buckets.length / 2), buckets.length - 1]) {
    if (idx < 0 || idx >= buckets.length) continue
    const b = buckets[idx]!
    svgChildren.push(
      React.createElement(
        SvgText as any,
        {
          key: `xl-${idx}`,
          x: padding.left + idx * stepX + stepX / 2,
          y: height - 6,
          fill: c.text3,
          fontSize: 10,
          textAnchor: "middle",
        },
        fmtTime(b.iso, bucketTimeZone, withDate, bucketUnit),
      ),
    )
  }

  const ariaLabel = `Request volume over ${buckets.length} ${bucketUnit === "day" ? "daily" : "hourly"} buckets, ${formatCount(
    buckets.reduce((a, b) => a + b.total, 0),
  )} turns total`

  return (
    <YStack gap="$2" onLayout={onLayout}>
      <YStack width="100%" height={height} overflow="hidden" aria-label={ariaLabel}>
        {React.createElement(
          Svg as any,
          // Real-pixel canvas at the measured width (no viewBox scale — a scaled
          // 720 canvas would stretch bar/text proportions until onLayout fires).
          { width, height, "aria-hidden": true },
          ...svgChildren,
        )}
      </YStack>
      <XStack gap="$3" flexWrap="wrap">
        {topKeys.map((key) => {
          const meta = modelMeta.get(key)!
          return (
            <XStack key={key} gap="$1" alignItems="center">
              <YStack width={10} height={10} borderRadius={2} backgroundColor={colorFor(key)} />
              <Text fontSize="$1" color={c.text2}>
                {modelLabel(meta.actualProvider, meta.modelId, 24)} ·{" "}
                {formatCount(modelTotals.get(key) ?? 0)}
              </Text>
            </XStack>
          )
        })}
        {modelTotals.size > topKeys.length ? (
          <XStack gap="$1" alignItems="center">
            <YStack width={10} height={10} borderRadius={2} backgroundColor={OTHER_COLOR} />
            <Text fontSize="$1" color={c.text2}>
              Other ({modelTotals.size - topKeys.length})
            </Text>
          </XStack>
        ) : null}
      </XStack>
    </YStack>
  )
}
