/**
 * formPrimitives — the billing form building blocks shared by the billing edit
 * form, the period-hours card and the provider-config modal (single source, no
 * duplication). Thin adapters over the ds primitives (`FieldLabel` / `Field` /
 * `FieldHelp` / `ChipBtn` / `Btn`) that keep the old props + testID contract.
 * Every colour comes from `useColors()`; all controls are cross-native and
 * expose accessible roles.
 */

import type { ReactNode } from "react"
import { View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import {
  Btn,
  type BtnVariant,
  ChipBtn,
  Field,
  FieldHelp,
  FieldLabel as DsFieldLabel,
  T,
} from "../../../components/ui/ds"

type ButtonTone = "default" | "primary" | "danger" | "positive"

/** ds variant per tone (lookup, not a nested ternary — keeps `Button` under budget). */
const TONE_VARIANT: Record<ButtonTone, BtnVariant> = {
  default: "sec",
  primary: "primary",
  danger: "dangerSoft",
  positive: "mint",
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <DsFieldLabel>{children}</DsFieldLabel>
}

export function Hint({ children }: { children: ReactNode }) {
  return <FieldHelp>{children}</FieldHelp>
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
    <Field
      testID={testID}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      secureTextEntry={secure}
      area={multiline}
      minHeight={multiline ? 80 : undefined}
      mono={numeric}
      keyboardType={numeric ? "numeric" : "default"}
      autoCapitalize="none"
      autoCorrect={false}
      error={invalid}
    />
  )
}

/** Inline, accessible error banner (replaces the old native alert). */
export function FormError({ message, testID }: { message: string; testID?: string }) {
  const c = useColors()
  return (
    <View
      testID={testID}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.tint.r.bd,
        backgroundColor: c.tint.r.bg,
      }}
      {...({ role: "alert" } as Record<string, unknown>)}
    >
      <T step="sm" color={c.tint.r.tx} numberOfLines={3}>
        {message}
      </T>
    </View>
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
    <ChipBtn
      testID={testID}
      on={active}
      onPress={onPress}
      {...({ "aria-pressed": active } as Record<string, unknown>)}
    >
      {label}
    </ChipBtn>
  )
}

/** Action button; `tone` picks the variant, `disabled`/`busy` dim + block it. */
export function Button({
  label,
  onPress,
  tone = "default",
  disabled = false,
  busy = false,
  testID,
  icon,
}: {
  label: string
  onPress: () => void
  tone?: ButtonTone
  disabled?: boolean
  busy?: boolean
  testID?: string
  icon?: string
}) {
  const blocked = disabled || busy
  return (
    <Btn
      testID={testID}
      variant={TONE_VARIANT[tone]}
      size="sm"
      icon={icon}
      disabled={blocked}
      loading={busy}
      onPress={blocked ? undefined : onPress}
      {...({ "aria-disabled": blocked } as Record<string, unknown>)}
    >
      {label}
    </Btn>
  )
}
