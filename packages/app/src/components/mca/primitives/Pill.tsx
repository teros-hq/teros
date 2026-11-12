/**
 * PillBtn — the OS prototype's pill button, local to the MCA primitives.
 *
 * Mirrors `ui/ds` `Btn` (HEIGHT IS THE TOKEN: sm 28 · md 36; radius 100;
 * weight 400; primary violet / sec outlined / ghost / ghost-danger / danger)
 * but takes its glyph as a component from `./icons`, so the render tests keep
 * cutting the Phosphor graph at the icon barrel the way `vitest.config.ts`
 * documents — importing `ui/ds/Icon` from here would pull
 * `phosphor-react-native` into the jsdom worker.
 */
import type React from "react"
import { useState } from "react"
import { Platform, Pressable, View, type ViewStyle } from "react-native"
import { Halo } from "../../ui/ds/Halo"
import { T } from "../../ui/ds/Text"
import { colors as semantic } from "./colors"
import { useColors } from "./useColors"

export type PillVariant = "primary" | "sec" | "ghost" | "ghostDanger" | "danger"
export type PillSize = "sm" | "md"

export type PillIcon = React.ComponentType<{ size?: number; color?: string }>

const H: Record<PillSize, number> = { sm: 28, md: 36 }
const PX: Record<PillSize, number> = { sm: 12, md: 16 }
const ICON: Record<PillSize, number> = { sm: 13, md: 15 }

export interface PillBtnProps {
  variant?: PillVariant
  size?: PillSize
  /** Glyph drawn before the label, tinted with the label colour. */
  icon?: PillIcon
  label: string
  onPress: () => void
  /** Defaults to `label`. */
  accessibilityLabel?: string
  testID?: string
  disabled?: boolean
  style?: ViewStyle
}

export function PillBtn({
  variant = "sec",
  size = "sm",
  icon: Icon,
  label,
  onPress,
  accessibilityLabel,
  testID,
  disabled,
  style,
}: PillBtnProps) {
  const c = useColors()
  const [hover, setHover] = useState(false)

  let bg = "transparent"
  let fg = c.text
  let border = "transparent"
  switch (variant) {
    case "primary":
      bg = semantic.purple300
      fg = "#FFFFFF"
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
    case "ghostDanger":
      bg = hover ? c.tint.r.bg : "transparent"
      fg = c.tint.r.tx
      break
    case "danger":
      bg = semantic.red
      fg = "#FFFFFF"
      break
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          height: H[size],
          paddingHorizontal: PX[size],
          borderRadius: 100,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: bg,
          flexShrink: 0,
          opacity: disabled ? 0.5 : 1,
          transform: pressed ? [{ scale: 0.96 }] : undefined,
        },
        Platform.OS === "web"
          ? ({
              cursor: disabled ? "default" : "pointer",
              transition: "background 0.2s, border-color 0.2s, color 0.2s, transform 0.2s",
              userSelect: "none",
            } as any)
          : null,
        style,
      ]}
    >
      {variant === "primary" ? <Halo color={bg} size={size} disabled={disabled} /> : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          minWidth: 0,
          zIndex: 1,
        }}
      >
        {Icon ? <Icon size={ICON[size]} color={fg} /> : null}
        <T step={size === "sm" ? "12" : "sm"} color={fg} numberOfLines={1}>
          {label}
        </T>
      </View>
    </Pressable>
  )
}
