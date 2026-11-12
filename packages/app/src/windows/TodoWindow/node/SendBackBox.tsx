/**
 * Sending a task back from review asks why (TODOAP-REQ-21): the blocked
 * task's note card with "Send back with a note" (disabled while empty) and
 * Cancel. The note travels as `set-state { state: 'working', reply }`.
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { Btn, Tx } from "../ui/kit"
import { useTd } from "../ui/tokens"
import { NoteBox } from "./NoteBox"

/** @spec TODOAP-REQ-21 */
export function SendBackBox({
  onSend,
  onCancel,
  onError,
}: {
  onSend: (note: string) => void
  onCancel: () => void
  /** A voice note that failed (TODOAP-REQ-26). */
  onError?: (message: string) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  return (
    <NoteBox
      region={t("todo.sendBack.region")}
      dot="review"
      header={t("todo.sendBack.header")}
      title={t("todo.sendBack.title")}
      placeholder={t("todo.sendBack.placeholder")}
      submitLabel={t("todo.sendBack.submit")}
      requireText
      autoFocus
      onSubmit={onSend}
      onCancel={onCancel}
      onError={onError}
      footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Tx f="mono" s={10} lh={14} c={td.txs}>
            {t("todo.sendBack.footer")}
          </Tx>
          <View style={{ marginLeft: "auto" }}>
            <Btn sm tone="ghost" onPress={onCancel}>
              {t("todo.sendBack.cancel")}
            </Btn>
          </View>
        </View>
      }
    />
  )
}
