/**
 * PrePublishWarningDialog — shared warning dialog shown when a user tries to
 * make a conversation public and personal apps were used (MUW-10 / MUW-15).
 *
 * Extracted from ConversationsWindowContent so that both the conversation list
 * and the open-chat window (ChatView) render the exact same dialog.
 *
 * Props match the return shape of useScopeToggle:
 *   - open, personalApps, onConfirm, onCancel
 */

import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { Dialog } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import { Btn, Ph, T } from "../ui/ds"
import type { PersonalApp } from "../../hooks/chat/useScopeToggle"

interface PrePublishWarningDialogProps {
  open: boolean
  personalApps: PersonalApp[]
  onConfirm: () => void
  onCancel: () => void
}

export function PrePublishWarningDialog({
  open,
  personalApps,
  onConfirm,
  onCancel,
}: PrePublishWarningDialogProps) {
  const { t } = useTranslation()
  const c = useColors()
  const amber = c.tint.a.tx

  return (
    <Dialog
      modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          key="overlay-warn"
          animation="card"
          backgroundColor="rgba(32,28,39,0.45)"
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content-warn"
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
          <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                backgroundColor: c.tint.a.bg,
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Ph name="warning" size={18} color={amber} />
            </View>
            <View style={{ flex: 1, gap: 12 }}>
              <Dialog.Title asChild>
                <T step="hsm">{t("conversations.prePublishWarningTitle")}</T>
              </Dialog.Title>
              <Dialog.Description asChild>
                <T step="sm" tone="text2">
                  {t("conversations.prePublishWarningBody")}
                </T>
              </Dialog.Description>
              {/* List of personal apps used in this conversation */}
              <View style={{ gap: 6 }}>
                {personalApps.map((app) => (
                  <View
                    key={app.appId}
                    style={{
                      backgroundColor: c.nest,
                      borderRadius: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <Ph name="lock" size={13} color={amber} />
                    <T step="sm">{app.name}</T>
                  </View>
                ))}
              </View>
              <T step="12" tone="text3">
                {t("conversations.prePublishWarningAdvice")}
              </T>
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onPress={onCancel}>
              {t("conversations.prePublishCancel")}
            </Btn>
            <Btn variant="amber" icon="users-three" onPress={onConfirm}>
              {t("conversations.prePublishConfirm")}
            </Btn>
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
