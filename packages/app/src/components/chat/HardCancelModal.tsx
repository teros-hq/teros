import React from "react"
import { View } from "react-native"
import { Dialog } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import { Btn, T } from "../ui/ds"
import { t } from "../../lib/i18n"

interface HardCancelModalProps {
  open: boolean
  hasIrreversibleToolInFlight?: boolean
  irreversibleToolName?: string
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

/** The hard-cancel confirmation — a card (one step off the sheet) with serif title, sans body and pill actions. */
export function HardCancelModal({
  open,
  hasIrreversibleToolInFlight = false,
  irreversibleToolName,
  onConfirm,
  onCancel,
}: HardCancelModalProps): React.ReactElement {
  const c = useColors()
  const body = hasIrreversibleToolInFlight
    ? t("chat.stop.hardConfirm.bodyWithIrreversible", {
        toolName: irreversibleToolName ?? "tool",
      })
    : t("chat.stop.hardConfirm.bodyNoIrreversible")

  const confirmLabel = hasIrreversibleToolInFlight
    ? t("chat.stop.hardConfirm.confirmWait")
    : t("chat.stop.hardConfirm.confirm")

  return (
    <Dialog modal open={open} onOpenChange={(o) => (!o ? onCancel() : null)}>
      <Dialog.Portal>
        <Dialog.Overlay
          key="overlay"
          animation="card"
          backgroundColor="rgba(32,28,39,0.45)"
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content"
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={460}
          maxWidth="92%"
          padding={24}
          gap={16}
          borderWidth={0}
          borderRadius={16}
          backgroundColor={c.bgStep}
          // @ts-ignore web-only lift
          style={{ boxShadow: c.elevRaised }}
        >
          <Dialog.Title asChild>
            <T step="hsm">{t("chat.stop.hardConfirm.title")}</T>
          </Dialog.Title>
          <Dialog.Description asChild>
            <T step="sm" tone="text2">
              {body}
            </T>
          </Dialog.Description>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onPress={onCancel}>
              {t("chat.stop.hardConfirm.deny")}
            </Btn>
            <Btn variant="danger" icon="stop" onPress={onConfirm}>
              {confirmLabel}
            </Btn>
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
