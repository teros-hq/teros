import type React from "react"
import { useTranslation } from "react-i18next"
import { ScrollView, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { Ph, T } from "../../components/ui/ds"

export function StartPage({
  field,
  children,
}: {
  field: React.ReactNode
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <View
      testID="terminal-start"
      style={{
        flex: 1,
        backgroundColor: c.bgSheet,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 20,
      }}
    >
      <View style={{ alignItems: "center", gap: 10 }}>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            backgroundColor: c.tile,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ph name="terminal" size={28} color={c.accent} />
        </View>
        <T step="lg">{t("windows.terminal", { defaultValue: "Terminal" })}</T>
        <T step="sm" tone="text3" style={{ textAlign: "center" }}>
          {t("terminal.window.startSubtitle", {
            defaultValue: "Open a new terminal or go back to a session",
          })}
        </T>
      </View>
      <View style={{ width: "100%", maxWidth: 640, gap: 8, flexShrink: 1, minHeight: 0 }}>
        {field}
        <ScrollView
          testID="terminal-sessions"
          style={{
            flexGrow: 0,
            flexShrink: 1,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.bgStep,
          }}
          contentContainerStyle={{ padding: 4 }}
        >
          {children}
        </ScrollView>
      </View>
    </View>
  )
}
