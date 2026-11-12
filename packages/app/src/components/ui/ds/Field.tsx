/**
 * Form controls of the OS prototype (design-testing).
 *
 *   <FieldLabel required>Nombre</FieldLabel>
 *   <Field value onChangeText placeholder icon="magnifying-glass" />
 *   <Field area minHeight={96} />         textarea
 *   <Field lg />                          44px
 *   <FieldHelp>20 por defecto…</FieldHelp>
 *   <SelectField icon="user" label="Personal Assistant" onPress />
 *   <Switch on onToggle />  <Radio on />  <Check on />
 */
import React from "react"
import {
  Platform,
  Pressable,
  type StyleProp,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { colors as semantic } from "../../mca/primitives/colors"
import { FONT_MONO, FONT_SANS } from "../../mca/primitives/fonts"
import { Ph } from "./Icon"
import { T } from "./Text"

export function FieldLabel({
  children,
  required,
  right,
  style,
}: {
  children: React.ReactNode
  required?: boolean
  right?: React.ReactNode
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }, style]}>
      <T step="xs" tone="text2">
        {children}
      </T>
      {required ? (
        <T step="xs" color={c.accent}>
          *
        </T>
      ) : null}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  )
}

export function FieldHelp({
  children,
  error,
  style,
}: {
  children: React.ReactNode
  error?: boolean
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <T step="12" color={error ? c.tint.r.tx : c.text3} style={[{ marginTop: 8 }, style]}>
      {children}
    </T>
  )
}

export function FieldGroup({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ marginTop: 20 }, style]}>{children}</View>
}

export interface FieldProps extends TextInputProps {
  icon?: string
  /** Textarea. */
  area?: boolean
  minHeight?: number
  /** 44px tall, 16px text. */
  lg?: boolean
  mono?: boolean
  error?: boolean
  /** Trailing slot (button, counter…). */
  right?: React.ReactNode
  /** Draw as a plain row (no fill/border) — e.g. inline search in a header. */
  bare?: boolean
  containerStyle?: StyleProp<ViewStyle>
  inputRef?: React.Ref<TextInput>
}

export function Field({
  icon,
  area,
  minHeight = 96,
  lg,
  mono,
  error,
  right,
  bare,
  containerStyle,
  style,
  inputRef,
  onFocus,
  onBlur,
  editable = true,
  ...rest
}: FieldProps) {
  const c = useColors()
  const [focus, setFocus] = React.useState(false)
  const h = lg ? 44 : 36
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: area ? "flex-start" : "center",
          gap: 8,
          minWidth: 0,
          height: area ? undefined : h,
          minHeight: area ? minHeight : undefined,
          paddingHorizontal: bare ? 0 : 14,
          paddingVertical: area ? 12 : 0,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: bare
            ? "transparent"
            : error
              ? semantic.red
              : focus
                ? "rgba(111,39,255,0.45)"
                : c.border,
          backgroundColor: bare ? "transparent" : c.field,
          opacity: editable ? 1 : 0.6,
        },
        Platform.OS === "web"
          ? ({
              transition: "border-color 0.2s, box-shadow 0.2s",
              boxShadow: bare
                ? "none"
                : error
                  ? "0 0 0 3px rgba(239,68,68,0.12)"
                  : focus
                    ? "0 0 0 3px rgba(111,39,255,0.07)"
                    : "none",
            } as any)
          : null,
        containerStyle,
      ]}
    >
      {icon ? (
        <Ph name={icon} size={16} color={c.text3} style={area ? { marginTop: 3 } : undefined} />
      ) : null}
      <TextInput
        ref={inputRef}
        editable={editable}
        multiline={!!area}
        placeholderTextColor={c.text3}
        onFocus={(e) => {
          setFocus(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocus(false)
          onBlur?.(e)
        }}
        {...rest}
        style={[
          {
            flex: 1,
            minWidth: 0,
            color: c.text,
            fontFamily: mono ? FONT_MONO : FONT_SANS,
            fontSize: mono ? 12 : lg ? 16 : 13,
            lineHeight: area ? 20 : undefined,
            paddingVertical: 0,
            height: area ? undefined : h - 2,
            minHeight: area ? minHeight - 26 : undefined,
            textAlignVertical: area ? "top" : "center",
          },
          Platform.OS === "web"
            ? ({ outlineStyle: "none", resize: area ? "vertical" : "none" } as any)
            : null,
          style,
        ]}
      />
      {right}
    </View>
  )
}

/** A select-looking trigger (`.field.select`): icon + label + caret. */
export function SelectField({
  icon,
  label,
  meta,
  onPress,
  lg,
  right,
  style,
  disabled,
}: {
  icon?: string | React.ReactNode
  label: string
  meta?: string
  onPress?: () => void
  lg?: boolean
  right?: React.ReactNode
  style?: ViewStyle
  disabled?: boolean
}) {
  const c = useColors()
  const [hover, setHover] = React.useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          height: lg ? 44 : 36,
          paddingHorizontal: 14,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: hover ? c.borderStrong : c.border,
          backgroundColor: c.field,
          minWidth: 0,
          opacity: disabled ? 0.6 : 1,
        },
        Platform.OS === "web"
          ? ({ cursor: disabled ? "default" : "pointer", transition: "border-color 0.2s" } as any)
          : null,
        style,
      ]}
    >
      {typeof icon === "string" ? <Ph name={icon} size={16} color={c.text3} /> : icon}
      <T step={lg ? "base" : "sm"} ellipsis style={{ flex: 1 }}>
        {label}
      </T>
      {meta ? (
        <T step="codenote" tone="text3">
          {meta}
        </T>
      ) : null}
      {right ?? <Ph name="caret-down" size={13} color={c.text3} />}
    </Pressable>
  )
}

export function Switch({
  on,
  onToggle,
  disabled,
  size = "md",
}: {
  on: boolean
  onToggle?: (next: boolean) => void
  disabled?: boolean
  size?: "sm" | "md"
}) {
  const c = useColors()
  const w = size === "sm" ? 30 : 36
  const h = size === "sm" ? 17 : 20
  const k = h - 4
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={() => onToggle?.(!on)}
      style={[
        {
          width: w,
          height: h,
          borderRadius: 100,
          backgroundColor: on ? semantic.purple300 : c.bgControl,
          padding: 2,
          justifyContent: "center",
          opacity: disabled ? 0.5 : 1,
        },
        Platform.OS === "web"
          ? ({ cursor: "pointer", transition: "background 0.3s" } as any)
          : null,
      ]}
    >
      <View
        style={[
          {
            width: k,
            height: k,
            borderRadius: k / 2,
            backgroundColor: "#FFFFFF",
            transform: [{ translateX: on ? w - k - 4 : 0 }],
          },
          Platform.OS === "web"
            ? ({
                transition: "transform 0.4s cubic-bezier(.16,1,.3,1)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
              } as any)
            : null,
        ]}
      />
    </Pressable>
  )
}

export function Radio({ on }: { on: boolean }) {
  const c = useColors()
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 1.5,
        borderColor: on ? semantic.purple300 : c.borderStrong,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on ? (
        <View
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: semantic.purple300 }}
        />
      ) : null}
    </View>
  )
}

export function Check({ on, round }: { on: boolean; round?: boolean }) {
  const c = useColors()
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: round ? 9 : 5,
        borderWidth: 1.5,
        borderColor: on ? semantic.purple300 : c.borderStrong,
        backgroundColor: on ? semantic.purple300 : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on ? <Ph name="check" size={11} color="#FFFFFF" weight="bold" /> : null}
    </View>
  )
}

/** A choice row: radio/check + title + sub, inside a card list. */
export function OptionRow({
  on,
  title,
  sub,
  onPress,
  kind = "radio",
  right,
}: {
  on: boolean
  title: string
  sub?: string
  onPress?: () => void
  kind?: "radio" | "check"
  right?: React.ReactNode
}) {
  const c = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 10,
          backgroundColor: pressed ? c.wash2 : on ? c.navActive : "transparent",
        },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      {kind === "radio" ? <Radio on={on} /> : <Check on={on} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm" color={on ? c.accent : c.text}>
          {title}
        </T>
        {sub ? (
          <T step="12" tone="text3">
            {sub}
          </T>
        ) : null}
      </View>
      {right}
    </Pressable>
  )
}
