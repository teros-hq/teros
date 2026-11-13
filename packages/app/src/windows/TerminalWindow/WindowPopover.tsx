import type React from "react"
import { useState } from "react"
import { Pressable, ScrollView, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { Ph, T } from "../../components/ui/ds"

export function WindowPopover({
  side,
  top = 46,
  onClose,
  testID,
  header,
  children,
}: {
  side: "left" | "right" | "center"
  top?: number
  onClose: () => void
  testID: string
  header?: React.ReactNode
  children: React.ReactNode
}) {
  const c = useColors()
  const place =
    side === "center"
      ? { alignSelf: "center" as const, marginTop: top, width: 480 }
      : { position: "absolute" as const, top, [side]: 8, width: 300 }
  return (
    <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 30 }}>
      <Pressable
        testID={`${testID}-scrim`}
        accessibilityLabel="Close"
        onPress={onClose}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      />
      <View
        testID={testID}
        style={{
          ...place,
          maxWidth: "94%",
          maxHeight: "80%",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: c.borderStrong,
          backgroundColor: c.bgCard,
          boxShadow: c.elevRaised,
          overflow: "hidden",
        }}
      >
        {header}
        <ScrollView contentContainerStyle={{ padding: 6 }}>{children}</ScrollView>
      </View>
    </View>
  )
}

export function PopoverLabel({ children }: { children: string }) {
  return (
    <T
      step="codenote"
      tone="text3"
      style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4, textTransform: "uppercase" }}
    >
      {children}
    </T>
  )
}

export function PopoverRow({
  icon,
  label,
  detail,
  trailing,
  danger,
  current,
  focused,
  checked,
  disabled,
  mark,
  end,
  onPress,
  testID,
}: {
  icon: string
  label: string
  detail?: string
  trailing?: string
  mark?: React.ReactNode
  danger?: boolean
  current?: boolean
  focused?: boolean
  checked?: boolean
  end?: RowEnd
  disabled?: boolean
  onPress: () => void
  testID: string
}) {
  const c = useColors()
  const color = danger ? c.tint.r.tx : c.text
  const [over, setOver] = useState(false)
  const row = (
    <Pressable
      testID={testID}
      onPress={onPress}
      onHoverIn={() => setOver(true)}
      onHoverOut={() => setOver(false)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-current={current ? "true" : undefined}
      aria-selected={focused ? true : undefined}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingLeft: 10,
        paddingRight: end ? (end.armed ? 84 : 40) : 10,
        paddingVertical: 8,
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: current
          ? c.navActive
          : !disabled && (focused || over || (state as { hovered?: boolean }).hovered)
            ? c.nestHover
            : "transparent",
      })}
    >
      <Ph name={icon} size={15} color={danger ? c.tint.r.tx : current ? c.accent : c.text3} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm" numberOfLines={1} style={{ color }}>
          {label}
        </T>
        {detail ? (
          <T step="codenote" tone="text3" numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      {mark}
      {trailing ? (
        <T step="codenote" tone="text3">
          {trailing}
        </T>
      ) : null}
      {checked ? <Ph name="check" size={14} color={c.accent} /> : null}
    </Pressable>
  )
  if (!end) return row
  return (
    <View style={{ justifyContent: "center" }}>
      {row}
      <View style={{ position: "absolute", right: 8 }}>
        <RowEndButton
          end={end}
          shown={over || focused === true || end.always === true}
          onHover={setOver}
          testID={`${testID}-end`}
        />
      </View>
    </View>
  )
}

export interface RowEnd {
  label: string
  armedLabel: string
  armed: boolean
  always?: boolean
  onPress: () => void
}

function RowEndButton({
  end,
  shown,
  onHover,
  testID,
}: {
  end: RowEnd
  shown: boolean
  onHover: (over: boolean) => void
  testID: string
}) {
  const c = useColors()
  return (
    <Pressable
      testID={testID}
      onPress={end.onPress}
      onHoverIn={() => onHover(true)}
      onHoverOut={() => onHover(false)}
      accessibilityRole="button"
      accessibilityLabel={end.label}
      style={(state) => ({
        height: 24,
        minWidth: 24,
        paddingHorizontal: end.armed ? 8 : 0,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: shown || end.armed ? 1 : 0,
        backgroundColor: end.armed
          ? c.tint.r.bg
          : (state as { hovered?: boolean }).hovered
            ? c.wash
            : "transparent",
        transitionProperty: "opacity, background-color",
        transitionDuration: "120ms",
      })}
    >
      {end.armed ? (
        <T step="codenote" style={{ color: c.tint.r.tx }}>
          {end.armedLabel}
        </T>
      ) : (
        <Ph name="x" size={13} color={c.text3} />
      )}
    </Pressable>
  )
}

export function PopoverSeparator() {
  const c = useColors()
  return <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
}
