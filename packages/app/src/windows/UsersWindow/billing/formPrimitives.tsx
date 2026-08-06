/**
 * formPrimitives — token-only form building blocks shared by the billing edit
 * form and the provider-config modal (single source, no duplication). Every
 * colour comes from `monitoring/colors`; there is no stylesheet factory and no
 * hardcoded hex/rgba, so theme work touches one file. All controls are
 * cross-native (RN `TextInput` + Tamagui) and expose accessible roles.
 */

import type { ReactNode } from "react"
import { TextInput } from "react-native"
import { Text, XStack } from "tamagui"
import { tokens } from "../../../components/monitoring/colors"

type ButtonTone = "default" | "primary" | "danger" | "positive"

/** Accent per tone (lookup, not a nested ternary — keeps `Button` under budget). */
const TONE_ACCENT: Record<ButtonTone, string | null> = {
  default: null,
  primary: tokens.accent,
  danger: tokens.error,
  positive: tokens.success,
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <Text
      fontSize={10}
      fontWeight="600"
      letterSpacing={0.6}
      textTransform="uppercase"
      color={tokens.textTertiary}
      marginBottom={5}
    >
      {children}
    </Text>
  )
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <Text fontSize={11} color={tokens.textMuted} marginTop={4}>
      {children}
    </Text>
  )
}

export function TextField({
  value,
  onChangeText,
  placeholder,
  testID,
  secure = false,
  multiline = false,
  numeric = false,
  invalid = false,
}: {
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  testID?: string
  secure?: boolean
  multiline?: boolean
  numeric?: boolean
  /** Draw the field in an error state (red border) — pairs with a FormError. */
  invalid?: boolean
}) {
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={tokens.textMuted}
      secureTextEntry={secure}
      multiline={multiline}
      keyboardType={numeric ? "numeric" : "default"}
      autoCapitalize="none"
      autoCorrect={false}
      style={
        {
          backgroundColor: tokens.bgInner,
          borderWidth: 1,
          borderColor: invalid ? tokens.error : tokens.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: tokens.text,
          fontSize: 13,
          minHeight: multiline ? 60 : undefined,
          textAlignVertical: multiline ? "top" : "auto",
          outlineStyle: "none",
        } as object
      }
    />
  )
}

/** Inline, accessible error banner (replaces the old native alert). */
export function FormError({ message, testID }: { message: string; testID?: string }) {
  return (
    <XStack
      testID={testID}
      paddingHorizontal={12}
      paddingVertical={9}
      borderRadius={10}
      borderWidth={1}
      borderColor={`${tokens.error}38`}
      backgroundColor={`${tokens.error}1A`}
      {...({ role: "alert" } as Record<string, unknown>)}
    >
      <Text fontSize={13} color={tokens.error} numberOfLines={3}>
        {message}
      </Text>
    </XStack>
  )
}

/** A selectable pill (plan / status chips). */
export function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string
  active: boolean
  onPress: () => void
  testID?: string
}) {
  return (
    <XStack
      testID={testID}
      ai="center"
      paddingVertical={6}
      paddingHorizontal={11}
      borderRadius={7}
      borderWidth={1}
      borderColor={active ? `${tokens.accent}66` : tokens.border}
      backgroundColor={active ? `${tokens.accent}1A` : tokens.bgInner}
      cursor="pointer"
      hoverStyle={active ? {} : { backgroundColor: tokens.bgHover }}
      onPress={onPress}
      {...({ role: "button", tabIndex: 0, "aria-pressed": active } as Record<string, unknown>)}
    >
      <Text
        fontSize={12}
        fontWeight={active ? "600" : "500"}
        color={active ? tokens.accent : tokens.textSecondary}
      >
        {label}
      </Text>
    </XStack>
  )
}

/** Action button; `tone` picks the accent, `disabled`/`busy` dim + block it. */
export function Button({
  label,
  onPress,
  tone = "default",
  disabled = false,
  busy = false,
  testID,
}: {
  label: string
  onPress: () => void
  tone?: ButtonTone
  disabled?: boolean
  busy?: boolean
  testID?: string
}) {
  const accent = TONE_ACCENT[tone]
  const blocked = disabled || busy
  const fg = accent ?? tokens.textSecondary
  const border = accent ? `${accent}55` : tokens.border
  const bg = accent ? `${accent}1A` : tokens.bgInner
  const hoverBg = accent ? `${accent}26` : tokens.bgHover
  return (
    <XStack
      testID={testID}
      ai="center"
      jc="center"
      paddingVertical={8}
      paddingHorizontal={14}
      borderRadius={8}
      borderWidth={1}
      borderColor={border}
      backgroundColor={bg}
      opacity={blocked ? 0.5 : 1}
      cursor={blocked ? "default" : "pointer"}
      hoverStyle={blocked ? {} : { backgroundColor: hoverBg }}
      onPress={blocked ? undefined : onPress}
      {...({ role: "button", tabIndex: blocked ? -1 : 0, "aria-disabled": blocked } as Record<
        string,
        unknown
      >)}
    >
      <Text fontSize={13} fontWeight="600" color={fg}>
        {label}
      </Text>
    </XStack>
  )
}
