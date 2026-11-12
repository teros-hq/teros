/**
 * Profile row: a Switch for the agent's summary on a new conversation
 * (CSUM-REQ-3). On (default): the letter — the agent's summary and starter
 * prompts. Off: the empty conversation only greets the user.
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import { LGroup, LRow, Switch, T, Tile } from "../../components/ui/ds"
import { useAuthStore } from "../../store/authStore"

/** @spec CSUM-REQ-3 */
export function ProfileConversationSummarySection() {
  const { t } = useTranslation()
  const toast = useToast()
  const on = useAuthStore((s) => s.user?.conversationSummary !== false)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const [saving, setSaving] = useState(false)

  const toggle = async (next: boolean) => {
    if (saving) return
    setSaving(true)
    updateProfile({ conversationSummary: next })
    try {
      const saved = await getTerosClient().profile.updateProfile({ conversationSummary: next })
      updateProfile({ conversationSummary: saved.conversationSummary })
    } catch (err) {
      updateProfile({ conversationSummary: !next })
      console.error("Failed to save the conversation summary setting:", err)
      toast.error(t("profile.conversationSummary.error"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <LGroup>
      <LRow testID="profile-conversation-summary">
        <Tile sm icon="feather" tone="accent" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="sm">{t("profile.conversationSummary.title")}</T>
          <T step="12" tone="text3">{t("profile.conversationSummary.sub")}</T>
        </View>
        <Switch on={on} onToggle={toggle} disabled={saving} />
      </LRow>
    </LGroup>
  )
}
