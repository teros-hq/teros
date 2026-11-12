/**
 * MenuRow — the `.mi` row of the OS prototype's `.menu` card, local to the
 * voice surfaces (the orb popover, the mode picker).
 *
 *   radius 10 · min-height 34 · gap 10 · padding 6/14/6/10 · 13px 400
 *   hover → wash + text · on → nav-active + accent · danger → red tint
 *
 * Icon + label (+ description) always travel together (UX §11.2).
 */
import React from "react"
import { Platform, Pressable, View, type ViewStyle } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Ph, T } from "../ui/ds"

export interface MenuRowProps {
  /** Phosphor icon name. */
  icon: string
  label: string
  description?: string
  /** Active row — nav-active wash + accent glyph/label (+ trailing check). */
  on?: boolean
  /** Destructive row — red tint. */
  danger?: boolean
  onPress?: () => void
  accessibilityLabel?: string
  testID?: string
  style?: ViewStyle
}

export function MenuRow({
  icon,
  label,
  description,
  on,
  danger,
  onPress,
  accessibilityLabel,
  testID,
  style,
}: MenuRowProps) {
  const c = useColors()
  const [hover, setHover] = React.useState(false)

  const fg = danger ? c.tint.r.tx : on ? c.accent : hover ? c.text : c.text2
  const iconFg = danger ? c.tint.r.tx : on ? c.accent : c.text3
  const bg = on ? c.navActive : hover ? (danger ? c.tint.r.bg : c.wash) : "transparent"

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={on != null ? { selected: on } : undefined}
      onPress={onPress}
      testID={testID}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 34,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 14,
          borderRadius: 10,
          backgroundColor: bg,
          transform: pressed ? [{ scale: 0.985 }] : undefined,
        },
        Platform.OS === "web"
          ? ({
              cursor: "pointer",
              transition: "background 0.2s, color 0.2s, transform 0.35s",
              userSelect: "none",
            } as any)
          : null,
        style,
      ]}
    >
      <Ph name={icon} size={16} color={iconFg} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm" color={fg} numberOfLines={1}>
          {label}
        </T>
        {description ? (
          <T step="12" tone="text3" numberOfLines={1}>
            {description}
          </T>
        ) : null}
      </View>
      {on ? <Ph name="check" size={14} color={c.accent} /> : null}
    </Pressable>
  )
}

/** `.msec` — the small section label inside a menu. */
export function MenuSection({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ paddingTop: 8, paddingBottom: 4, paddingHorizontal: 10 }}>
      <T step="codenote" tone="text3">
        {children}
      </T>
    </View>
  )
}
