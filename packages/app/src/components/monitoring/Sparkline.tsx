import Svg, { Path } from "react-native-svg"
import { YStack } from "tamagui"
import { tokens } from "./colors"

/**
 * Minimal responsive sparkline (line + soft area) for KPI tiles. `values` are
 * plotted left→right, auto-scaled; empty/flat input renders a baseline.
 */
export function Sparkline({
  values,
  color = tokens.accent,
  height = 30,
}: {
  values: number[]
  color?: string
  height?: number
}) {
  const W = 120
  const H = 30
  const pad = 2
  const n = values.length
  if (n < 2) {
    return <YStack height={height} />
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (n - 1)) * (W - pad * 2)
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2)
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
  const area = `${line} L${x(n - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`
  return (
    <YStack height={height} width="100%">
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none">
        <Path d={area} fill={color} opacity={0.12} />
        <Path d={line} stroke={color} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      </Svg>
    </YStack>
  )
}
