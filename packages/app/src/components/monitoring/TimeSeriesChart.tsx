import { useState } from "react"
import { Platform, View } from "react-native"
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg"
import { useColors } from "../mca/primitives/useColors"
import { FONT_MONO } from "../mca/primitives/fonts"
import { T } from "../ui/ds/Text"

export interface Series {
  key: string
  label: string
  color: string
  /** One value per bucket; length must match `labels`. */
  values: number[]
}

const W = 720
const H = 236
const PAD = { l: 46, r: 14, t: 14, b: 26 }

/**
 * Unified stacked-bar time series (the design's `StackedBars`) — replaces the
 * per-window hand-rolled charts. Responsive (viewBox + width 100%), with a
 * click-to-inspect tooltip (RN-Web has no reliable SVG hover) and a legend.
 * Series colors are stable by identity (caller passes `seriesColor(key)`);
 * grid, axes and tooltip follow the theme (Main/300 grid, mono text3 axes).
 */
export function TimeSeriesChart({
  series,
  labels,
  unit = "",
  format = (v: number) => Math.round(v).toLocaleString("en-US"),
  onBarPress,
}: {
  series: Series[]
  labels: string[]
  unit?: string
  format?: (v: number) => string
  /**
   * Drill callback (A5.3/TER-672). When set, tapping a bar both toggles the
   * tooltip AND fires `onBarPress(index)` so the caller can open that bucket's
   * sessions. Optional — omit it and the chart stays tooltip-only.
   */
  onBarPress?: (index: number) => void
}) {
  const c = useColors()
  const [active, setActive] = useState<number | null>(null)

  const n = labels.length
  const x0 = PAD.l
  const x1 = W - PAD.r
  const y0 = PAD.t
  const y1 = H - PAD.b
  const plotW = x1 - x0
  const plotH = y1 - y0
  const step = n > 0 ? plotW / n : plotW
  const barW = Math.min(17, step * 0.6)
  const cx = (h: number) => x0 + (h + 0.5) * step

  const totals = labels.map((_, h) => series.reduce((a, s) => a + (s.values[h] ?? 0), 0))
  const maxT = Math.max(1, ...totals)
  const mag = 10 ** Math.floor(Math.log10(maxT))
  const niceMax = Math.ceil(maxT / (mag / 2)) * (mag / 2) || maxT
  const yy = (v: number) => y1 - (v / niceMax) * plotH

  const gridVals = [0, 1, 2, 3, 4].map((t) => (niceMax * t) / 4)
  const compact = (v: number) =>
    v >= 1e6
      ? `${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(1)}k`
        : String(Math.round(v))

  return (
    <View style={{ gap: 12 }}>
      <View style={{ width: "100%", position: "relative" }}>
        {/* svg */}
        <Svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={undefined}
          preserveAspectRatio="xMidYMid meet"
          style={{ aspectRatio: W / H }}
        >
          {gridVals.map((v, t) => (
            <Line
              key={`g${t}`}
              x1={x0}
              y1={yy(v)}
              x2={x1}
              y2={yy(v)}
              stroke={c.border}
              strokeWidth={1}
            />
          ))}
          {gridVals.map((v, t) => (
            <SvgText
              key={`gl${t}`}
              x={x0 - 8}
              y={yy(v) + 3}
              textAnchor="end"
              fill={c.text3}
              fontSize={9}
              fontFamily={FONT_MONO}
            >
              {compact(v)}
            </SvgText>
          ))}
          {labels.map((hl, h) =>
            h % 4 === 0 ? (
              <SvgText
                key={`x${h}`}
                x={cx(h)}
                y={y1 + 15}
                textAnchor="middle"
                fill={c.text3}
                fontSize={9}
                fontFamily={FONT_MONO}
              >
                {hl}
              </SvgText>
            ) : null,
          )}
          {labels.map((_, h) => {
            let acc = 0
            const dim = active != null && active !== h
            return series.map((s) => {
              const v = s.values[h] ?? 0
              if (v <= 0) return null
              const hgt = (v / niceMax) * plotH
              const yTop = yy(acc + v)
              acc += v
              return (
                <Rect
                  key={`${s.key}-${h}`}
                  x={cx(h) - barW / 2}
                  y={yTop}
                  width={barW}
                  height={Math.max(0.5, hgt - 0.8)}
                  fill={s.color}
                  rx={2}
                  opacity={dim ? 0.32 : 1}
                />
              )
            })
          })}
          {labels.map((_, h) => (
            <Rect
              key={`hit${h}`}
              x={x0 + h * step}
              y={y0}
              width={step}
              height={plotH}
              fill="transparent"
              onPress={() => {
                setActive((cur) => (cur === h ? null : h))
                onBarPress?.(h)
              }}
            />
          ))}
        </Svg>

        {/* tooltip */}
        {active != null ? (
          <Tooltip
            h={active}
            cx={cx(active)}
            series={series}
            labels={labels}
            totals={totals}
            unit={unit}
            format={format}
          />
        ) : null}
      </View>

      {/* legend */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          paddingLeft: 46,
          rowGap: 4,
          columnGap: 16,
        }}
      >
        {[...series].reverse().map((s) => (
          <View key={s.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: s.color }} />
            <T step="12" tone="text2">
              {s.label}
            </T>
            <T step="code" tone="text3">
              {compact(s.values.reduce((a, b) => a + b, 0))}
            </T>
          </View>
        ))}
      </View>
    </View>
  )
}

function Tooltip({
  h,
  cx,
  series,
  labels,
  totals,
  unit,
  format,
}: {
  h: number
  cx: number
  series: Series[]
  labels: string[]
  totals: number[]
  unit: string
  format: (v: number) => string
}) {
  const c = useColors()
  const leftPct = (cx / W) * 100
  const flip = leftPct > 58
  const rows = series
    .map((s) => ({ s, v: s.values[h] ?? 0 }))
    .filter((r) => r.v > 0)
    .reverse()
  return (
    <View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: 4,
          left: `${leftPct}%`,
          backgroundColor: c.bgStep,
          borderRadius: 12,
          padding: 12,
          minWidth: 150,
          gap: 2,
          zIndex: 5,
        },
        Platform.OS === "web"
          ? ({
              transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
              boxShadow: c.elevRaised,
            } as any)
          : { transform: [{ translateX: flip ? -170 : 12 }] },
      ]}
    >
      <T step="codenote" tone="text3" style={{ marginBottom: 4 }}>
        {labels[h]}
      </T>
      {rows.map((r) => (
        <View key={r.s.key} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: r.s.color }} />
          <T step="12" tone="text2" numberOfLines={1} style={{ flex: 1 }}>
            {r.s.label}
          </T>
          <T step="code">{format(r.v)}</T>
        </View>
      ))}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 6,
          paddingTop: 6,
          borderTopWidth: 1,
          borderTopColor: c.border,
        }}
      >
        <T step="12" tone="text3">
          Total
        </T>
        <T step="code">
          {format(totals[h])} {unit}
        </T>
      </View>
    </View>
  )
}
