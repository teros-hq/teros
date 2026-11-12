/**
 * Tile (`.tile`) — the rounded icon tile of the OS prototype: violet wash +
 * accent glyph by default; mint / amber / pink / muted tones.
 *   <Tile icon="cube" />  <Tile sm tone="mint" icon="check" />  <Tile lg><Image…/></Tile>
 */
import React from "react"
import { View, type ViewStyle } from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { Ph } from "./Icon"

export type TileTone = "accent" | "mint" | "amber" | "pink" | "muted"
export type TileSize = "xs" | "sm" | "md" | "lg"

const SIZE: Record<TileSize, { box: number; radius: number; icon: number }> = {
  xs: { box: 28, radius: 6, icon: 14 },
  sm: { box: 36, radius: 10, icon: 18 },
  md: { box: 44, radius: 10, icon: 22 },
  lg: { box: 72, radius: 16, icon: 34 },
}

export function Tile({
  icon,
  tone = "accent",
  size = "md",
  xs,
  sm,
  lg,
  children,
  style,
  weight,
}: {
  icon?: string
  tone?: TileTone
  size?: TileSize
  xs?: boolean
  sm?: boolean
  lg?: boolean
  children?: React.ReactNode
  style?: ViewStyle
  weight?: "regular" | "bold" | "fill"
}) {
  const c = useColors()
  const s = SIZE[xs ? "xs" : sm ? "sm" : lg ? "lg" : size]
  const bg =
    tone === "mint"
      ? c.tint.m.bg
      : tone === "amber"
        ? c.tint.a.bg
        : tone === "pink"
          ? c.tint.r.bg
          : tone === "muted"
            ? c.wash
            : c.tile
  const fg =
    tone === "mint"
      ? c.tint.m.tx
      : tone === "amber"
        ? c.tint.a.tx
        : tone === "pink"
          ? c.tint.r.tx
          : tone === "muted"
            ? c.text2
            : c.accent
  return (
    <View
      style={[
        {
          width: s.box,
          height: s.box,
          borderRadius: s.radius,
          backgroundColor: bg,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {icon ? <Ph name={icon} size={s.icon} color={fg} weight={weight} /> : children}
    </View>
  )
}
