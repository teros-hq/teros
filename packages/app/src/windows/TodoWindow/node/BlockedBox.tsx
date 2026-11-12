/**
 * The question a blocked task waits on, with the reply field. "Reply and
 * continue" logs the reply and moves the task back to In progress; "Back to
 * planning" lives in the action bar (TODODH-REQ-3). A violet cloud sits
 * behind the card (live box).
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { Tx } from "../ui/kit"
import { useTd } from "../ui/tokens"
import { NoteBox } from "./NoteBox"

export function BlockedBox({
  reason,
  at,
  onReply,
  onError,
}: {
  reason: string | null
  at: string | null
  onReply: (text: string) => void
  /** A voice note that failed (TODOAP-REQ-26). */
  onError?: (message: string) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  return (
    <NoteBox
      region={t("todo.a11y.blockedRegion")}
      dot="blocked"
      header={t("todo.blocked.header")}
      headerColor={td.rTx}
      at={at}
      title={reason || t("todo.blocked.noReason")}
      placeholder={t("todo.blocked.replyPlaceholder")}
      submitLabel={t("todo.blocked.reply")}
      onSubmit={onReply}
      onError={onError}
      footer={
        <Tx f="mono" s={10} lh={14} c={td.txs}>
          {t("todo.blocked.footer")}
        </Tx>
      }
    />
  )
}
