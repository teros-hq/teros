import type React from "react"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, View, type ViewStyle } from "react-native"
import { floatsSupported } from "../../../../store/tilingFloats"
import { T } from "../../../ui/ds"
import { useColors } from "../../primitives/useColors"

export interface CardPalette {
  bg: string
  border: string
  text: string
  title: string
  muted: string
  accent: string
  code: string
  codeBorder: string
  btn: string
  btnBorder: string
  btnText: string
  pri: string
  priText: string
  danger: string
}

export function useCardPalette(): CardPalette {
  const c = useColors()
  return useMemo(
    () => ({
      bg: c.nest,
      border: c.border,
      text: c.text,
      title: c.text,
      muted: c.text3,
      accent: c.accent,
      code: c.field,
      codeBorder: c.border,
      btn: c.bgInner,
      btnBorder: c.borderStrong,
      btnText: c.text,
      pri: c.inkPill,
      priText: c.inkPillText,
      danger: c.tint.r.tx,
    }),
    [c],
  )
}

export function CardShell({
  children,
  active,
  row,
  testID,
}: {
  children: React.ReactNode
  active: boolean
  row?: boolean
  testID?: string
}) {
  const p = useCardPalette()
  const layout: ViewStyle = row ? { flexDirection: "row", gap: 10, alignItems: "flex-start" } : {}
  return (
    <View
      testID={testID}
      style={{
        ...layout,
        borderWidth: 1,
        borderColor: p.border,
        backgroundColor: p.bg,
        borderRadius: 14,
        paddingVertical: 11,
        paddingHorizontal: 13,
        marginTop: 6,
        opacity: active ? 1 : 0.8,
      }}
    >
      {children}
    </View>
  )
}

export function CardButtons({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>{children}</View>
  )
}

export function CardNote({
  children,
  error,
  testID,
}: {
  children: React.ReactNode
  error?: boolean
  testID?: string
}) {
  return (
    <T testID={testID} step="12" tone={error ? "danger" : "text3"} style={{ marginTop: 6 }}>
      {children}
    </T>
  )
}

export function CardButton({
  children,
  onPress,
  primary,
  disabled,
  title,
  icon,
  testID,
}: {
  children: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
  title?: string
  icon?: React.ReactNode
  testID?: string
}) {
  const p = useCardPalette()
  const pri = primary && !disabled
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title ?? children}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 28,
        paddingHorizontal: 12,
        borderRadius: 100,
        borderWidth: 1,
        borderColor: pri ? p.pri : p.btnBorder,
        backgroundColor: pri ? p.pri : p.btn,
        opacity: disabled ? 0.5 : (state as { hovered?: boolean }).hovered ? 0.88 : 1,
      })}
    >
      {icon}
      <T step="12" color={pri ? p.priText : p.btnText} numberOfLines={1}>
        {children}
      </T>
    </Pressable>
  )
}

export function SessionOpenButtons({
  testID,
  onFloat,
  onShow,
}: {
  testID: string
  onFloat: () => void
  onShow: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {floatsSupported() ? (
        <CardButton
          testID={`${testID}-float`}
          title={t("terminal.chat.floatTitle", {
            defaultValue: "Open it floating over what you are doing",
          })}
          onPress={onFloat}
        >
          {t("terminal.chat.float", { defaultValue: "Float" })}
        </CardButton>
      ) : null}
      <CardButton testID={`${testID}-goto`} onPress={onShow}>
        {t("terminal.chat.showTerminal", { defaultValue: "Show the terminal" })}
      </CardButton>
    </>
  )
}
