/**
 * Badge (`.badge`) — the small status label of the OS prototype.
 *   tone: g (green) · a (amber) · r (red) · i (info/violet) · m (mint) · muted · neutral
 *   <Badge tone="g" dot>Lista</Badge>  <Badge mono sm>v1.2</Badge>  <Badge pill cap>beta</Badge>
 */
import React from "react"
import { View, type ViewStyle } from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { colors as semantic } from "../../mca/primitives/colors"
import { Ph } from "./Icon"
import { T } from "./Text"
import { fx } from "../../../styles/fx"

export type BadgeTone = "g" | "a" | "r" | "i" | "m" | "muted" | "neutral"

export interface BadgeProps {
  tone?: BadgeTone
  pill?: boolean
  sm?: boolean
  lg?: boolean
  mono?: boolean
  /** 9px uppercase tracked label. */
  cap?: boolean
  dot?: boolean
  icon?: string
  /** Dashed "Propuesta" style. */
  dashed?: boolean
  style?: ViewStyle
  children?: React.ReactNode
}

const DOT: Record<BadgeTone, string> = {
  g: semantic.green,
  a: semantic.amber,
  r: semantic.red,
  i: semantic.purple300,
  m: semantic.mint300,
  muted: semantic.main500,
  neutral: semantic.main500,
}

export function Badge({
  tone = "neutral",
  pill,
  sm,
  lg,
  mono,
  cap,
  dot,
  icon,
  dashed,
  style,
  children,
}: BadgeProps) {
  const c = useColors()
  const tinted = tone === "g" || tone === "a" || tone === "r" || tone === "i" || tone === "m"
  const bg = tinted ? c.tint[tone].bg : c.wash
  const fg = tinted ? c.tint[tone].tx : tone === "muted" ? c.text3 : c.text2
  const bd = dashed ? c.borderStrong : "transparent"
  const fs = lg ? 13 : cap ? 9 : 10
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          alignSelf: "flex-start",
          flexShrink: 0,
          paddingVertical: lg ? 4 : sm ? 2 : 3,
          paddingHorizontal: lg ? 12 : sm ? 7 : 9,
          borderRadius: pill ? 100 : 5,
          backgroundColor: bg,
          borderWidth: 1,
          borderColor: bd,
          borderStyle: dashed ? "dashed" : "solid",
        },
        style,
      ]}
    >
      {dot ? (
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: DOT[tone] }} />
      ) : null}
      {icon ? <Ph name={icon} size={11} color={fg} /> : null}
      {typeof children === "string" || typeof children === "number" ? (
        <T
          step={mono ? "code" : "sm"}
          color={fg}
          numberOfLines={1}
          style={[
            { fontSize: fs, lineHeight: fs + 3 },
            cap ? { textTransform: "uppercase", letterSpacing: 1.3 } : null,
            mono ? { letterSpacing: 0.2 } : null,
          ]}
        >
          {children}
        </T>
      ) : (
        children
      )}
    </View>
  )
}

/** Small round status dot (`.sdot`). */
export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  )
}

/** The "4" count pill on tabs/items (`.tab-count` / `.unread-n`). */
export function CountPill({
  n,
  tone = "violet",
}: {
  n: number | string
  tone?: "violet" | "mint"
}) {
  const bg = tone === "mint" ? semantic.mint200 : semantic.purple300
  const fg = tone === "mint" ? semantic.mint500 : semantic.purple100
  return (
    <View
      {...fx("pop")}
      style={{
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        borderRadius: 100,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <T step="code" color={fg} style={{ fontSize: 10, lineHeight: 12 }}>
        {String(n)}
      </T>
    </View>
  )
}

/** Keyboard key (`.kbd`). */
export function Kbd({ children }: { children: React.ReactNode }) {
  const c = useColors()
  return (
    <View
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 5,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: c.borderStrong,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T step="code" tone="text3" style={{ fontSize: 10, lineHeight: 12 }}>
        {children}
      </T>
    </View>
  )
}
