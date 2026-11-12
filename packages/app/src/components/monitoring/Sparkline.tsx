import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg"
import { View } from "react-native"
import { useColors } from "../mca/primitives/useColors"

let gradSeq = 0

/**
 * Minimal responsive sparkline (accent line + violet→transparent area) for the
 * Stat tiles. `values` are plotted left→right, auto-scaled; empty/flat input
 * renders a baseline. `color` defaults to the theme accent.
 */
export function Sparkline({
  values,
  color,
  height = 30,
}: {
  values: number[]
  color?: string
  height?: number
}) {
  const c = useColors()
  const stroke = color ?? c.accent
  const W = 120
  const H = 30
  const pad = 2
  const n = values.length
  if (n < 2) {
    return <View style={{ height }} />
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (n - 1)) * (W - pad * 2)
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2)
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ")
  const area = `${line} L${x(n - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`
  const gid = `spark-${(gradSeq = (gradSeq + 1) % 100000)}`
  return (
    <View style={{ height, width: "100%" }}>
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={stroke} stopOpacity={0.28} />
            <Stop offset="1" stopColor={stroke} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Path d={area} fill={`url(#${gid})`} />
        <Path
          d={line}
          stroke={stroke}
          strokeWidth={1.5}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  )
}
