/**
 * Surfaces of the OS prototype (design-testing).
 *
 *   <Card pad>…</Card>                 16px radius, one step off the sheet, violet lift (web)
 *   <Card hov onPress>…</Card>         lifts on hover, scales on press
 *   <LGroup><LRow>…</LRow></LGroup>    list rows inside one card (`.lgroup > .lrow`)
 *   <LRow hov onPress>…</LRow>         standalone row card
 *   <Stats><Stat v="141.740" label="Créditos" sub="este periodo" /></Stats>
 */
import React from "react"
import {
  Platform,
  Pressable,
  type PressableProps,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { T } from "./Text"
import { fx } from "../../../styles/fx"

export interface CardProps extends Omit<PressableProps, "style" | "children"> {
  /** 16px padding (compact density). Pass a number for custom padding. */
  pad?: boolean | number
  /** Hover lift + pointer. Implied by onPress. */
  hov?: boolean
  /** Accent border on hover. */
  accent?: boolean
  /** 24px radius hero card. */
  xl?: boolean
  /** Draw the hairline instead of the lift (inside another card). */
  nested?: boolean
  /** Background override. */
  bg?: string
  style?: ViewStyle
  children?: React.ReactNode
}

export function Card({
  pad,
  hov,
  accent,
  xl,
  nested,
  bg,
  style,
  children,
  onPress,
  ...rest
}: CardProps) {
  const c = useColors()
  const [hover, setHover] = React.useState(false)
  const interactive = !!onPress || hov
  // No border: the prototype's 1px transparent border painted the card's own
  // background under it while `overflow: hidden` clipped children at the
  // padding box, leaving a 1px ring around full-bleed content. The accent
  // hover border is an inset shadow instead, and the padding absorbs the
  // missing 1px so the content metrics stay identical.
  const padding = typeof pad === "number" ? pad : pad ? 16 : 0
  const base: ViewStyle = {
    borderRadius: xl ? 24 : 16,
    backgroundColor: bg ?? (nested ? c.nest : xl ? c.bgBox : c.bgStep),
    padding: padding > 0 ? padding + 1 : 0,
    overflow: "hidden",
  }
  const lift = nested ? "none" : interactive && hover ? c.liftSmHover : c.liftSm
  const ring = accent && hover ? `inset 0 0 0 1px ${c.borderAccentStrong}` : null
  const web =
    Platform.OS === "web"
      ? ({
          boxShadow: ring ? (lift === "none" ? ring : `${ring}, ${lift}`) : lift,
          transition:
            "box-shadow 0.35s cubic-bezier(.16,1,.3,1), transform 0.35s cubic-bezier(.16,1,.3,1), background 0.25s",
          cursor: interactive ? "pointer" : undefined,
        } as any)
      : null
  // data-fx hooks for the OS effects layer; callers may add their own
  // (the home cards pass "hc" + a stagger index) via `{...fx(...)}`.
  const extra = (rest as any).dataSet as Record<string, string> | undefined
  const fxAttrs = {
    dataSet: {
      ...extra,
      fx: [nested ? "card" : `card glow${interactive ? " hov" : ""}`, extra?.fx]
        .filter(Boolean)
        .join(" "),
    },
  } as unknown as Record<string, never>
  if (!interactive) {
    return (
      <View {...fxAttrs} style={[base, web, style]}>
        {children}
      </View>
    )
  }
  return (
    <Pressable
      {...fxAttrs}
      onPress={onPress}
      {...rest}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        base,
        nested && hover ? { backgroundColor: c.nestHover } : null,
        web,
        pressed ? { transform: [{ scale: 0.99 }] } : null,
        style,
      ]}
    >
      {children}
    </Pressable>
  )
}

// ─── List rows ──────────────────────────────────────────────────────────────
const LGroupCtx = React.createContext(false)

export function LGroup({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const c = useColors()
  return (
    <LGroupCtx.Provider value>
      <View
        style={[
          {
            borderRadius: 16,
            backgroundColor: c.bgStep,
            overflow: "hidden",
          },
          Platform.OS === "web" ? ({ boxShadow: c.liftSm } as any) : null,
          style,
        ]}
      >
        {React.Children.toArray(children)
          .filter(Boolean)
          .map((child, i) => (
            <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: c.border } : null}>
              {child}
            </View>
          ))}
      </View>
    </LGroupCtx.Provider>
  )
}

export interface LRowProps extends Omit<PressableProps, "style" | "children"> {
  hov?: boolean
  /** Vertical/horizontal padding (compact density defaults 12 / 16). */
  padV?: number
  padH?: number
  gap?: number
  style?: ViewStyle
  children?: React.ReactNode
}

export function LRow({
  hov,
  padV = 12,
  padH = 16,
  gap = 14,
  style,
  children,
  onPress,
  ...rest
}: LRowProps) {
  const c = useColors()
  const inGroup = React.useContext(LGroupCtx)
  const [hover, setHover] = React.useState(false)
  const interactive = !!onPress || hov
  const base: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap,
    paddingVertical: padV,
    paddingHorizontal: padH,
    width: "100%",
    borderRadius: inGroup ? 0 : 16,
    backgroundColor: inGroup ? (hover ? c.nestHover : "transparent") : c.bgStep,
  }
  const web =
    Platform.OS === "web"
      ? ({
          boxShadow: inGroup ? "none" : interactive && hover ? c.liftSmHover : c.liftSm,
          transition: "background 0.25s, box-shadow 0.35s cubic-bezier(.16,1,.3,1)",
          cursor: interactive ? "pointer" : undefined,
        } as any)
      : null
  const fxAttrs = (inGroup ? {} : fx(`glow${interactive ? " hov" : ""}`)) as Record<string, never>
  if (!interactive) {
    return (
      <View {...fxAttrs} style={[base, web, style]}>
        {children}
      </View>
    )
  }
  return (
    <Pressable
      {...fxAttrs}
      onPress={onPress}
      {...rest}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={[base, web, style]}
    >
      {children}
    </Pressable>
  )
}

// ─── Stats ──────────────────────────────────────────────────────────────────
export function Stats({
  children,
  cols = 3,
  style,
}: {
  children: React.ReactNode
  cols?: number
  style?: ViewStyle
}) {
  const items = React.Children.toArray(children).filter(Boolean)
  return (
    <View style={[styles.statsRow, style]}>
      {items.map((child, i) => (
        <View
          key={i}
          style={{ flexBasis: `${100 / cols}%`, flexGrow: 1, minWidth: 160, padding: 5 }}
        >
          {child}
        </View>
      ))}
    </View>
  )
}

export function Stat({
  v,
  label,
  sub,
  accent,
}: {
  v: string | number
  label: string
  sub?: string
  accent?: boolean
}) {
  return (
    <Card pad={20} style={{ minHeight: 100 }}>
      <T step="sm" tone="text2">
        {label}
      </T>
      <T step="2xl" tone={accent ? "accent" : "text"} style={{ marginTop: 10, marginBottom: 6 }}>
        {String(v)}
      </T>
      {sub ? (
        <T step="sm" tone="text3">
          {sub}
        </T>
      ) : null}
    </Card>
  )
}

/** The dark "danger zone" row of the agent window (`.danger-zone`). */
export function DangerZone({
  title,
  text,
  action,
}: {
  title: string
  text: string
  action: React.ReactNode
}) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        padding: 16,
        borderRadius: 16,
        backgroundColor: c.tint.r.bg,
        borderWidth: 1,
        borderColor: c.tint.r.bd,
        flexWrap: "wrap",
      }}
    >
      <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
        <T step="sm">{title}</T>
        <T step="12" tone="text2">
          {text}
        </T>
      </View>
      {action}
    </View>
  )
}

const styles = StyleSheet.create({
  statsRow: { flexDirection: "row", flexWrap: "wrap", margin: -5 },
})
