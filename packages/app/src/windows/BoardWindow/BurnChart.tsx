/**
 * BurnChart — Burn Up / Burn Down SVG chart component with velocity projection
 *
 * Displays a 7-day project trajectory chart with two modes:
 *  - Burn Up (default): shows cumulative completed tasks rising toward total scope
 *  - Burn Down (toggle): shows remaining tasks decreasing toward zero
 *
 * Both modes also visualize blocked-by-dependency events as a separate series.
 *
 * Velocity projection (Burn Down only):
 *  - Calculates completion velocity (tasks/day) from the historical data
 *  - If ≥3 data points and velocity > 0, extrapolates a dashed projection line
 *    showing the remaining tasks trending toward zero
 *  - The estimated completion date is shown in the summary footer
 *  - The projection line starts at the last real data point and extends
 *    beyond the chart's right edge (clipped by SVG viewBox — the chart
 *    width is NOT extended)
 *  - If <3 points or velocity ≤ 0, shows "Not enough data for projection"
 *
 * Data is derived from `computeBurnup()` in board-utils — no additional API
 * calls or stored snapshots are needed. The function reconstructs the timeline
 * from task.activity[] events already loaded in the board store.
 *
 * The chart uses inline SVG (compatible with React Native Web) and follows
 * the OS prototype language: hairline grid, mono axis labels, accent violet,
 * status green/red — all read from `useColors()` + the semantic ramps.
 */

import React, { useState } from "react"
import { View } from "react-native"
import { useTranslation } from "react-i18next"
import type { BurnupPoint } from "./board-utils"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { FONT_MONO } from "../../components/mca/primitives/fonts"
import { PTabs, T } from "../../components/ui/ds"

type ChartMode = "up" | "down"

// ── Projection calculation ──────────────────────────────────────────────────

interface Projection {
  /** Days from today to estimated completion */
  daysToCompletion: number
  /** Estimated completion date as timestamp */
  completionTs: number
  /** Estimated completion date label (short format) */
  completionLabel: string
  /** Velocity in tasks/day */
  velocity: number
  /** Number of projected future data points (for SVG rendering) */
  futurePoints: { dayOffset: number; value: number }[]
}

/**
 * Calculate velocity projection from burnup data.
 *
 * Velocity = (completed_last - completed_first) / days_between
 * where we use the full data window (up to 7 days).
 *
 * Returns null if:
 *  - fewer than 3 data points (not enough history)
 *  - velocity ≤ 0 (no progress)
 *  - no remaining work (already done)
 */
function computeProjection(points: BurnupPoint[], mode: ChartMode): Projection | null {
  // Projection only makes sense in Burn Down mode
  if (mode !== "down") return null
  if (points.length < 3) return null

  const first = points[0]
  const last = points[points.length - 1]

  // Days spanned by the data (at least 1 to avoid division by zero)
  const daysSpanned = Math.max(1, (last.timestamp - first.timestamp) / (1000 * 60 * 60 * 24))

  // Velocity = tasks completed per day
  const completedDelta = last.cumulativeDone - first.cumulativeDone
  const velocity = completedDelta / daysSpanned

  if (velocity <= 0) return null

  const remaining = last.totalAtDate - last.cumulativeDone
  if (remaining <= 0) return null

  // Days to completion
  const daysToCompletion = remaining / velocity
  const completionTs = last.timestamp + daysToCompletion * 24 * 60 * 60 * 1000

  // Cap projection at 30 days to avoid absurd charts
  const cappedDays = Math.min(daysToCompletion, 30)

  // Generate future points (daily steps) — remaining decreases toward zero
  const futurePoints: { dayOffset: number; value: number }[] = []
  const steps = Math.ceil(cappedDays)
  for (let d = 1; d <= steps; d++) {
    const val = Math.max(0, remaining - velocity * d)
    futurePoints.push({ dayOffset: d, value: val })
    if (val <= 0) break
  }

  const completionDate = new Date(completionTs)
  const completionLabel = completionDate.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
  })

  return {
    daysToCompletion,
    completionTs,
    completionLabel,
    velocity,
    futurePoints,
  }
}

// ── Legend swatch ───────────────────────────────────────────────────────────

function Swatch({ color, area, dashed }: { color: string; area?: boolean; dashed?: boolean }) {
  if (area)
    return <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color }} />
  return (
    <View
      style={
        dashed
          ? { width: 16, height: 0, borderTopWidth: 2, borderColor: color, borderStyle: "dashed" }
          : { width: 16, height: 2, borderRadius: 1, backgroundColor: color }
      }
    />
  )
}

function LegendItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {children}
      <T step="12" tone="text2">
        {label}
      </T>
    </View>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export function BurnChart({ points }: { points: BurnupPoint[] }) {
  const { t } = useTranslation()
  const c = useColors()
  const [mode, setMode] = useState<ChartMode>("up")

  const accent = c.accent
  const scopeLine = c.text3
  const doneColor = semantic.green
  const blockedColor = semantic.red
  const remainingFill = "rgba(111,39,255,0.12)"
  const blockedFill = "rgba(239,68,68,0.18)"

  if (points.length < 2) {
    return (
      <View
        style={{
          backgroundColor: c.nest,
          borderRadius: 12,
          paddingVertical: 28,
          paddingHorizontal: 16,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <T step="sm" tone="text3" center>
          {t("board.burnNoData")}
        </T>
      </View>
    )
  }

  // ── Compute projection ────────────────────────────────────────────────────
  const projection = computeProjection(points, mode)

  // ── SVG dimensions ────────────────────────────────────────────────────────
  // Fixed width — projection line is clipped at the right edge, chart does NOT extend
  const W = 460
  const H = 200
  const padL = 30,
    padR = 10,
    padT = 20,
    padB = 20
  const chartW = W - padL - padR
  const chartH = H - padT - padB

  // X-axis spans only historical points
  const totalPoints = points.length
  const maxVal = Math.max(
    ...points.map((p) => Math.max(p.totalAtDate, p.cumulativeDone + p.blockedByDep)),
    1,
  )
  // Round up to nearest 10
  const yMax = Math.ceil(maxVal / 10) * 10

  const xStep = chartW / Math.max(totalPoints - 1, 1)
  const yScale = (v: number) => padT + chartH - (v / yMax) * chartH
  const xPos = (i: number) => padL + i * xStep

  // ── Compute series based on mode ───────────────────────────────────────────
  const scopeValues = points.map((p) => p.totalAtDate)
  const doneValues = points.map((p) => p.cumulativeDone)
  const remainingValues = points.map((p) => p.totalAtDate - p.cumulativeDone)

  const topLineValues = mode === "up" ? scopeValues : remainingValues

  // Build polyline points for historical data
  const topPts = topLineValues.map((v, i) => `${xPos(i)},${yScale(v)}`).join(" ")
  const donePts = doneValues.map((v, i) => `${xPos(i)},${yScale(v)}`).join(" ")
  const blockedPts = points
    .map((p, i) => `${xPos(i)},${yScale(p.cumulativeDone + p.blockedByDep)}`)
    .join(" ")

  // Remaining area path (between top line and done+blocked)
  const remainingPath = `M ${points.map((p, i) => `${xPos(i)},${yScale(mode === "up" ? p.totalAtDate : p.totalAtDate - p.cumulativeDone)}`).join(" L ")} L ${points
    .slice()
    .reverse()
    .map((p, i) => `${xPos(points.length - 1 - i)},${yScale(p.cumulativeDone + p.blockedByDep)}`)
    .join(" L ")} Z`

  // Blocked area path (between done and done+blocked)
  const blockedPath = `M ${points.map((p, i) => `${xPos(i)},${yScale(p.cumulativeDone)}`).join(" L ")} L ${points
    .slice()
    .reverse()
    .map((p, i) => `${xPos(points.length - 1 - i)},${yScale(p.cumulativeDone + p.blockedByDep)}`)
    .join(" L ")} Z`

  // ── Projection polylines (Burn Down only) ─────────────────────────────────
  // The projection line starts at the last real data point and extends
  // beyond the chart's right edge using the same xStep. The SVG viewBox
  // clips it — we don't extend the chart width.
  let projectionTopPts = ""

  if (projection && projection.futurePoints.length > 0 && mode === "down") {
    const lastIdx = points.length - 1
    const lastPoint = points[lastIdx]

    // Project remaining line from last point toward zero
    // Use same xStep so the line continues at the same scale, extending
    // past the right edge where it gets clipped by the viewBox
    const projVals = projection.futurePoints.map((fp) => fp.value)
    projectionTopPts = [
      `${xPos(lastIdx)},${yScale(lastPoint.totalAtDate - lastPoint.cumulativeDone)}`,
      ...projVals.map((v, i) => `${xPos(lastIdx + 1 + i)},${yScale(v)}`),
    ].join(" ")
  }

  // Y-axis labels (5 ticks)
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0].map((f) => Math.round(yMax * f))

  // Today marker (last historical point)
  const todayX = xPos(points.length - 1)

  const lastPoint = points[points.length - 1]
  const remaining = lastPoint.totalAtDate - lastPoint.cumulativeDone

  return (
    <View>
      {/* Header: title + mode toggle */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <T step="sm" tone="text2">
          {mode === "up" ? t("board.burnUpTitle") : t("board.burnDownTitle")}
        </T>
        <PTabs
          sm
          value={mode}
          onChange={setMode}
          items={[
            { key: "up", label: t("board.burnUp") },
            { key: "down", label: t("board.burnDown") },
          ]}
        />
      </View>

      {/* Legend */}
      <View style={{ flexDirection: "row", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        {mode === "up" ? (
          <>
            <LegendItem label={t("board.burnScope")}>
              <Swatch color={scopeLine} dashed />
            </LegendItem>
            <LegendItem label={t("board.burnCompleted")}>
              <Swatch color={doneColor} />
            </LegendItem>
          </>
        ) : (
          <>
            <LegendItem label={t("board.burnRemaining")}>
              <Swatch color={accent} />
            </LegendItem>
            <LegendItem label={t("board.burnCompleted")}>
              <Swatch color={doneColor} />
            </LegendItem>
          </>
        )}
        <LegendItem label={mode === "up" ? t("board.burnRemaining") : t("board.burnScope")}>
          <Swatch color={remainingFill} area />
        </LegendItem>
        <LegendItem label={t("board.burnBlocked")}>
          <Swatch color={blockedFill} area />
        </LegendItem>
        {projection && (
          <LegendItem label={t("board.burnProjection")}>
            <Swatch color={accent} dashed />
          </LegendItem>
        )}
      </View>

      {/* SVG chart */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 200 }}>
        {/* Grid lines */}
        {yTicks.map((tick, i) => {
          const y = yScale(tick)
          return (
            <g key={i}>
              <line
                x1={padL}
                y1={y}
                x2={W - padR}
                y2={y}
                stroke={c.borderStrong}
                strokeWidth={1}
                strokeDasharray={i === 0 ? "" : "2,3"}
              />
              <text
                x={padL - 8}
                y={y + 3}
                fill={c.text3}
                fontSize={9}
                fontFamily={FONT_MONO}
                textAnchor="end"
              >
                {tick}
              </text>
            </g>
          )
        })}

        {/* X-axis labels — historical */}
        {points.map((p, i) => (
          <text
            key={i}
            x={xPos(i)}
            y={H - 5}
            fill={c.text3}
            fontSize={9}
            fontFamily={FONT_MONO}
            textAnchor="middle"
          >
            {i === 0 || i === points.length - 1 ? p.label : p.label.split(" ")[1]}
          </text>
        ))}

        {/* Remaining/Scope area */}
        <path d={remainingPath} fill={remainingFill} />

        {/* Blocked area */}
        <path d={blockedPath} fill={blockedFill} />

        {/* Top line (scope for burn-up, remaining for burn-down) */}
        <polyline
          points={topPts}
          fill="none"
          stroke={mode === "up" ? scopeLine : accent}
          strokeWidth={2}
          strokeDasharray={mode === "up" ? "4,3" : "none"}
        />

        {/* Completed line (solid green) */}
        <polyline points={donePts} fill="none" stroke={doneColor} strokeWidth={2.5} />

        {/* Blocked line (dashed red) */}
        <polyline
          points={blockedPts}
          fill="none"
          stroke={blockedColor}
          strokeWidth={1.5}
          strokeDasharray="3,2"
          opacity={0.7}
        />

        {/* Projection line (dashed accent) — Burn Down only, clipped at right edge */}
        {projection && projectionTopPts && (
          <polyline
            points={projectionTopPts}
            fill="none"
            stroke={accent}
            strokeWidth={2}
            strokeDasharray="5,4"
            opacity={0.7}
          />
        )}

        {/* Completed dots */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xPos(i)}
            cy={yScale(p.cumulativeDone)}
            r={i === points.length - 1 ? 4 : 3}
            fill={doneColor}
            stroke={i === points.length - 1 ? c.bgStep : "none"}
            strokeWidth={i === points.length - 1 ? 2 : 0}
          />
        ))}

        {/* Today marker */}
        <line
          x1={todayX}
          y1={padT}
          x2={todayX}
          y2={padT + chartH}
          stroke={accent}
          strokeWidth={1}
          strokeDasharray="2,2"
          opacity={0.5}
        />
        <text
          x={todayX}
          y={padT - 4}
          fill={accent}
          fontSize={8}
          fontFamily={FONT_MONO}
          textAnchor="middle"
        >
          {t("board.burnToday")}
        </text>
      </svg>

      {/* Summary + projection info */}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginTop: 10,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <T step="codenote" tone="text3">
          {t("board.burnScope")}: {lastPoint.totalAtDate}
        </T>
        <T step="codenote" tone="text3">
          {t("board.burnCompleted")}: {lastPoint.cumulativeDone}
        </T>
        {lastPoint.blockedByDep > 0 && (
          <T step="codenote" color={c.tint.r.tx}>
            {t("board.burnBlocked")}: {lastPoint.blockedByDep}
          </T>
        )}
        <T step="codenote" tone="text3">
          {t("board.burnRemaining")}: {remaining}
        </T>
      </View>

      {/* Projection summary line — Burn Down only */}
      {mode === "down" && projection ? (
        <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }}>
          <T step="code" tone="accent">
            {t("board.burnEstCompletion")}: {projection.completionLabel} (
            {projection.velocity.toFixed(1)} {t("board.burnTasksDay")})
          </T>
        </View>
      ) : mode === "down" && points.length >= 3 ? (
        <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }}>
          <T step="code" tone="text3">
            {t("board.burnNoProjection")}
          </T>
        </View>
      ) : null}
    </View>
  )
}
