/**
 * In-app delete confirmation (audit F6: no more window.confirm). A small card
 * over a scrim inside the window; Esc / Cancel close it, Enter confirms.
 */
import React, { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View, type ViewStyle } from "react-native"
import { Btn, Tx } from "./kit"
import { tdx, web } from "./todoFx"
import { useTd } from "./tokens"

export function ConfirmDelete({
  title,
  childCount,
  onCancel,
  onConfirm,
}: {
  title: string
  childCount: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  useEffect(() => {
    if (Platform.OS !== "web") return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onCancel])
  return (
    <View
      style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 80, alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <Pressable
        accessibilityLabel={t("todo.cancel")}
        onPress={onCancel}
        style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: td.dark ? "rgba(13,11,17,0.5)" : "rgba(52,47,61,0.18)" }}
      />
      <View
        accessibilityRole="alert"
        {...tdx("pop")}
        style={[
          { width: 340, maxWidth: "100%", backgroundColor: td.card, borderRadius: 16, padding: 18, gap: 10 },
          web({ boxShadow: `${td.elevRaised}, 0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
        ]}
      >
        <Tx f="serif" s={18} lh={24} c={td.text}>
          {t("todo.delete.title", { title })}
        </Tx>
        <Tx s={12.5} lh={18} c={td.text2}>
          {childCount > 0 ? t("todo.delete.withChildren", { count: childCount }) : t("todo.delete.noChildren")}
        </Tx>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
          <Btn sm tone="ghost" onPress={onCancel}>
            {t("todo.cancel")}
          </Btn>
          <Btn sm tone="pri" style={{ backgroundColor: "#D92D20" }} onPress={onConfirm}>
            {t("todo.delete.confirm")}
          </Btn>
        </View>
      </View>
    </View>
  )
}
