/**
 * Buttons of the OS prototype (design-testing): pills, 400 weight, Phosphor
 * glyphs. HEIGHT IS THE TOKEN — sm 28 · md 36 · lg 44.
 *
 *   <Btn variant="primary" icon="check">Permitir</Btn>     violet pill
 *   <Btn variant="sec">Denegar</Btn>                         outlined pill
 *   <Btn variant="ghost">Cancelar</Btn>                      text pill
 *   <Btn variant="ink" icon="storefront">Explorar catálogo</Btn>  inverted pill
 *   <Btn variant="mint" icon="chat-circle">Abrir chat</Btn>  mint pill
 *   <Btn variant="danger" / "dangerSoft">Eliminar</Btn>
 *   <IconBtn icon="x" plain sm />                            36/28 round
 *   <ChipBtn on count={3}>Activas</ChipBtn>                   28 filter chip
 *   <Chip icon="lightning">Skills</Chip>                     36 chip
 */
import React from "react"
import {
  ActivityIndicator,
  Platform,
  Pressable,
  type PressableProps,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { colors as semantic } from "../../mca/primitives/colors"
import { Halo, type HaloSize } from "./Halo"
import { Ph } from "./Icon"
import { T } from "./Text"
import { fx } from "../../../styles/fx"

export type BtnVariant =
  | "primary"
  | "sec"
  | "ghost"
  | "danger"
  | "dangerSoft"
  | "ink"
  | "mint"
  | "amber"
export type BtnSize = "sm" | "md" | "lg"

const H: Record<BtnSize, number> = { sm: 28, md: 36, lg: 44 }
const PX: Record<BtnSize, number> = { sm: 12, md: 16, lg: 20 }
const FS: Record<BtnSize, "sm" | "12" | "base"> = { sm: "12", md: "sm", lg: "base" }
const ICON: Record<BtnSize, number> = { sm: 13, md: 15, lg: 17 }
const HALO: Record<BtnSize, HaloSize> = { sm: "sm", md: "md", lg: "lg" }

export interface BtnProps extends Omit<PressableProps, "style" | "children"> {
  variant?: BtnVariant
  size?: BtnSize
  /** Phosphor icon name, drawn before the label. */
  icon?: string
  /** Phosphor icon name, drawn after the label. */
  iconRight?: string
  loading?: boolean
  /** Stretch to the row. */
  full?: boolean
  /** Mono uppercase label (the prototype's "+ TAREA" style). */
  caps?: boolean
  style?: ViewStyle
  children?: React.ReactNode
  testID?: string
}

export function Btn({
  variant = "sec",
  size = "md",
  icon,
  iconRight,
  loading,
  full,
  caps,
  disabled,
  style,
  children,
  ...rest
}: BtnProps) {
  const c = useColors()
  const [hover, setHover] = React.useState(false)

  let bg = "transparent"
  let fg = c.text
  let border = "transparent"
  // Solid pills bloom under the pointer (the prototype's TerosButton halo)
  // instead of lifting on a shadow.
  let halo = false
  switch (variant) {
    case "primary":
      bg = semantic.purple300
      fg = "#FFFFFF"
      halo = true
      break
    case "sec":
      bg = hover ? c.wash : "transparent"
      fg = c.text
      border = hover ? semantic.main500 : c.borderStrong
      break
    case "ghost":
      bg = hover ? c.wash : "transparent"
      fg = hover ? c.accent : c.text2
      break
    case "danger":
      bg = semantic.red
      fg = "#FFFFFF"
      break
    case "dangerSoft":
      bg = c.tint.r.bg
      fg = c.tint.r.tx
      border = c.tint.r.bd
      break
    case "ink":
      bg = c.inkPill
      fg = c.inkPillText
      halo = true
      break
    case "mint":
      bg = semantic.mint200
      fg = semantic.mint500
      halo = true
      break
    case "amber":
      bg = c.tint.a.bg
      fg = c.tint.a.tx
      border = c.tint.a.bd
      break
  }

  const h = H[size]
  const isDisabled = !!disabled || !!loading

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isDisabled}
      {...rest}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        styles.base,
        {
          height: h,
          paddingHorizontal: children ? PX[size] : 0,
          width: children ? undefined : h,
          borderRadius: 100,
          backgroundColor: bg,
          borderColor: border,
          gap: 8,
          opacity: isDisabled ? 0.5 : 1,
          transform: pressed ? [{ scale: 0.96 }] : undefined,
        },
        full ? { alignSelf: "stretch" } : null,
        Platform.OS === "web"
          ? ({
              cursor: isDisabled ? "default" : "pointer",
              transition: "background 0.2s, border-color 0.2s, color 0.2s, transform 0.2s",
              userSelect: "none",
            } as any)
          : null,
        style,
      ]}
    >
      {halo ? <Halo color={bg} size={HALO[size]} disabled={isDisabled} /> : null}
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <View style={styles.content}>
          {icon ? <Ph name={icon} size={ICON[size]} color={fg} /> : null}
          {children != null ? (
            typeof children === "string" || typeof children === "number" ? (
              <T step={caps ? "codenote" : FS[size]} color={fg} numberOfLines={1}>
                {children}
              </T>
            ) : (
              children
            )
          ) : null}
          {iconRight ? <Ph name={iconRight} size={ICON[size]} color={fg} /> : null}
        </View>
      )}
    </Pressable>
  )
}

// ─── IconBtn (`.ibtn`) ────────────────────────────────────────────────────
export interface IconBtnProps extends Omit<PressableProps, "style"> {
  icon: string
  /** No border — the quiet variant. */
  plain?: boolean
  /** 28px instead of 36px. */
  sm?: boolean
  /** Active: accent glyph on the nav-active wash. */
  on?: boolean
  color?: string
  weight?: "regular" | "bold" | "fill"
  danger?: boolean
  style?: ViewStyle
  /** Tooltip (web `title`). */
  title?: string
}

export function IconBtn({
  icon,
  plain,
  sm,
  on,
  color,
  weight,
  danger,
  disabled,
  style,
  title,
  ...rest
}: IconBtnProps) {
  const c = useColors()
  const [hover, setHover] = React.useState(false)
  const size = sm ? 28 : 36
  const fg = danger ? c.tint.r.tx : on ? c.accent : hover ? c.text : (color ?? c.text2)
  const bg = on ? c.navActive : hover ? (plain ? c.wash : c.wash2) : "transparent"
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      {...rest}
      {...(Platform.OS === "web"
        ? ({ onHoverIn: () => setHover(true), onHoverOut: () => setHover(false), title } as any)
        : {})}
      style={({ pressed }) => [
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: 100,
          backgroundColor: bg,
          borderColor: plain || on ? "transparent" : c.borderStrong,
          opacity: disabled ? 0.4 : 1,
          transform: pressed ? [{ scale: 0.94 }] : undefined,
        },
        Platform.OS === "web"
          ? ({
              cursor: disabled ? "default" : "pointer",
              transition: "background 0.2s, color 0.2s",
            } as any)
          : null,
        style,
      ]}
    >
      <Ph name={icon} size={sm ? 14 : 16} color={fg} weight={weight} />
    </Pressable>
  )
}

// ─── ChipBtn (`.chipbtn`, 28px) and Chip (`.chip`, 36px) ──────────────────
export interface ChipProps extends Omit<PressableProps, "style" | "children"> {
  on?: boolean
  icon?: string
  count?: number | string
  /** 36px chip instead of the 28px filter chip. */
  lg?: boolean
  /** Mono + caps label. */
  mono?: boolean
  style?: ViewStyle
  children?: React.ReactNode
}

export function ChipBtn({
  on,
  icon,
  count,
  lg,
  mono,
  disabled,
  style,
  children,
  ...rest
}: ChipProps) {
  const c = useColors()
  const [hover, setHover] = React.useState(false)
  const h = lg ? 36 : 28
  const fg = on ? c.accent : hover ? c.text : c.text2
  const solid = on && lg
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      {...rest}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        styles.base,
        {
          height: h,
          paddingHorizontal: lg ? 14 : 12,
          borderRadius: 100,
          gap: 6,
          backgroundColor: solid ? semantic.purple300 : on ? c.navActive : hover ? c.wash2 : c.wash,
          borderColor: hover && !on ? c.borderStrong : "transparent",
          opacity: disabled ? 0.5 : 1,
          transform: pressed ? [{ scale: 0.96 }] : undefined,
        },
        Platform.OS === "web" ? ({ cursor: "pointer", transition: "all 0.2s" } as any) : null,
        style,
      ]}
    >
      {icon ? <Ph name={icon} size={lg ? 14 : 13} color={solid ? semantic.purple100 : fg} /> : null}
      {typeof children === "string" ? (
        <T
          step={mono ? "codenote" : lg ? "sm" : "12"}
          color={solid ? semantic.purple100 : fg}
          numberOfLines={1}
        >
          {children}
        </T>
      ) : (
        children
      )}
      {count != null ? (
        <T step="codenote" color={solid ? semantic.purple100 : on ? c.accent : c.text3}>
          {String(count)}
        </T>
      ) : null}
    </Pressable>
  )
}

export function Chip(props: ChipProps) {
  return <ChipBtn lg {...props} />
}

/** The round inverted toggle (theme switch) — `.toggle`. */
export function InkToggle({
  icon,
  onPress,
  title,
  size = 36,
}: {
  icon: string
  onPress?: () => void
  title?: string
  size?: number
}) {
  const c = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      {...fx("toggle")}
      {...(Platform.OS === "web" ? ({ title } as any) : {})}
      style={({ pressed }) => [
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: 100,
          // Inverted ink: the pill takes the ink's text colour and the glyph
          // the ink itself, so the toggle sits quietly on the frame instead
          // of reading as a solid button.
          backgroundColor: c.inkPillText,
          borderColor: "transparent",
          transform: pressed ? [{ scale: 0.94 }] : undefined,
        },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      <Ph name={icon} size={16} color={c.inkPill} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    flexShrink: 0,
  },
  // Above the halo (which is a positioned, z-less first child).
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minWidth: 0,
    zIndex: 1,
  },
})

export { View as BtnRow }
