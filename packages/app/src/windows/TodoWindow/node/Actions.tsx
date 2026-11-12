/**
 * The inline "complete all / only this" prompt when completing a task whose
 * child tasks are still open (the actions live in ActionBar, TODODH-REQ-3).
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { Btn, Tx } from "../ui/kit"
import { useTd } from "../ui/tokens"

export function CompleteChildrenPrompt({
  open,
  onAll,
  onOne,
  onCancel,
}: {
  open: string[]
  onAll: () => void
  onOne: () => void
  onCancel: () => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const list = open.slice(0, 3).join(", ") + (open.length > 3 ? "…" : "")
  return (
    <View accessibilityRole="alert" style={{ marginTop: 12, borderRadius: 14, backgroundColor: td.step, paddingVertical: 10, paddingHorizontal: 12, gap: 8 }}>
      <Tx s={12.5} lh={18} c={td.text2}>
        {t("todo.complete.openChildren", { count: open.length, list })}
      </Tx>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Btn sm tone="pri" onPress={onAll}>
          {t("todo.complete.all")}
        </Btn>
        <Btn sm tone="out" onPress={onOne}>
          {t("todo.complete.onlyThis")}
        </Btn>
        <Btn sm tone="ghost" onPress={onCancel}>
          {t("todo.complete.cancel")}
        </Btn>
      </View>
    </View>
  )
}
