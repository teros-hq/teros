/**
 * In-app archive confirmation (TODODH): archiving a node that still has
 * non-archived children asks first — the backend rejects it otherwise
 * (HAS_ACTIVE_CHILDREN). Same card-over-scrim pattern as ConfirmDelete;
 * Esc / Cancel close it, the confirm goes through set-archived.
 */
import React, { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View, type ViewStyle } from "react-native"
import { Btn, Tx } from "./kit"
import { tdx, web } from "./todoFx"
import { useTd } from "./tokens"

export function ConfirmArchive({
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
          {t("todo.archive.nodeConfirmTitle")}
        </Tx>
        <Tx s={12.5} lh={18} c={td.text2}>
          {t("todo.archive.confirmChildren", { title, count: childCount })}
        </Tx>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
          <Btn sm tone="ghost" onPress={onCancel}>
            {t("todo.cancel")}
          </Btn>
          <Btn sm tone="pri" onPress={onConfirm}>
            {t("todo.archive.confirmGo")}
          </Btn>
        </View>
      </View>
    </View>
  )
}
