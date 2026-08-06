import { useState } from "react"
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "./colors"

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
 * Series colors are stable by identity (caller passes `seriesColor(key)`).
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
  const compact = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)))

  return (
    <YStack gap={12}>
      <YStack width="100%" position="relative">
        {/* svg */}
        <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={undefined} preserveAspectRatio="xMidYMid meet" style={{ aspectRatio: W / H }}>
          {gridVals.map((v, t) => (
            <Line key={`g${t}`} x1={x0} y1={yy(v)} x2={x1} y2={yy(v)} stroke={tokens.border} strokeWidth={1} />
          ))}
          {gridVals.map((v, t) => (
            <SvgText key={`gl${t}`} x={x0 - 8} y={yy(v) + 3} textAnchor="end" fill={tokens.textTertiary} fontSize={9} fontFamily="monospace">
              {compact(v)}
            </SvgText>
          ))}
          {labels.map((hl, h) =>
            h % 4 === 0 ? (
              <SvgText key={`x${h}`} x={cx(h)} y={y1 + 15} textAnchor="middle" fill={tokens.textTertiary} fontSize={9} fontFamily="monospace">
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
                  rx={1}
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
        {active != null ? <Tooltip h={active} cx={cx(active)} series={series} labels={labels} totals={totals} unit={unit} format={format} /> : null}
      </YStack>

      {/* legend */}
      <XStack flexWrap="wrap" gap={4} paddingLeft={46} rowGap={4} columnGap={16}>
        {[...series].reverse().map((s) => (
          <XStack key={s.key} ai="center" gap={6}>
            <YStack width={9} height={9} borderRadius={3} backgroundColor={s.color} />
            <Text fontSize={12} color={tokens.textSecondary}>
              {s.label}
            </Text>
            <Text fontSize={12} fontFamily="$mono" color={tokens.textTertiary}>
              {compact(s.values.reduce((a, b) => a + b, 0))}
            </Text>
          </XStack>
        ))}
      </XStack>
    </YStack>
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
  const leftPct = (cx / W) * 100
  const flip = leftPct > 58
  const rows = series
    .map((s) => ({ s, v: s.values[h] ?? 0 }))
    .filter((r) => r.v > 0)
    .reverse()
  return (
    <YStack
      position="absolute"
      top={4}
      left={`${leftPct}%`}
      x={flip ? "calc(-100% - 12px)" : 12}
      backgroundColor={tokens.bgPress}
      borderWidth={1}
      borderColor={tokens.borderHover}
      borderRadius={6}
      padding={10}
      minWidth={150}
      gap={2}
      pointerEvents="none"
      zIndex={5}
    >
      <Text fontFamily="$mono" fontSize={11} color={tokens.textTertiary} marginBottom={4}>
        {labels[h]}
      </Text>
      {rows.map((r) => (
        <XStack key={r.s.key} ai="center" gap={7}>
          <YStack width={8} height={8} borderRadius={2} backgroundColor={r.s.color} />
          <Text fontSize={11} color={tokens.textSecondary} flex={1} numberOfLines={1}>
            {r.s.label}
          </Text>
          <Text fontSize={11} fontFamily="$mono" fontWeight="600" color={tokens.text}>
            {format(r.v)}
          </Text>
        </XStack>
      ))}
      <XStack jc="space-between" gap={12} marginTop={6} paddingTop={6} borderTopWidth={1} borderTopColor={tokens.border}>
        <Text fontSize={11} color={tokens.textTertiary}>
          Total
        </Text>
        <Text fontSize={11} fontFamily="$mono" fontWeight="700" color={tokens.text}>
          {format(totals[h])} {unit}
        </Text>
      </XStack>
    </YStack>
  )
}
