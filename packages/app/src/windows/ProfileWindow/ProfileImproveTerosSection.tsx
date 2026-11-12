/**
 * ProfileImproveTerosSection — the "Help improve Teros" opt-in toggle.
 *
 * One row in the Profile account group: a Switch that turns the user's consent
 * for anonymized conversation evaluation ON/OFF. Default OFF; only the user
 * themself can change it (profile.set-evaluation-consent is self-service
 * server-side — the flag always applies to the caller).
 *
 * Copy rules (Pablo, 2026-10-26 — do not soften):
 *   - Honest about anonymization ≠ not stored: the platform always persists
 *     conversations; the consent is about their use for evaluation.
 *   - Identities are protected (anonymized) — never promise "nothing is stored".
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import { LGroup, LRow, Switch, T, Tile } from "../../components/ui/ds"

export function ProfileImproveTerosSection({
  initialOptIn,
  onOptInChange,
}: {
  /** Current consent state, loaded from profile.get */
  initialOptIn: boolean
  /** Notifies the parent (ProfileWindowContent) so state survives view/edit flips */
  onOptInChange?: (optIn: boolean) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const client = getTerosClient()
  const [optIn, setOptIn] = useState(initialOptIn)
  const [saving, setSaving] = useState(false)

  const toggle = async (next: boolean) => {
    if (saving) return
    setSaving(true)
    // Optimistic flip; reverts to the server's truth on failure — the toggle
    // never lies about consent.
    setOptIn(next)
    try {
      const state = await client.profile.setEvaluationConsent(next)
      setOptIn(state.evaluationOptIn)
      onOptInChange?.(state.evaluationOptIn)
      toast.success(
        state.evaluationOptIn ? t("profile.improveTeros.on") : t("profile.improveTeros.off"),
      )
    } catch (err) {
      setOptIn(!next)
      console.error("Failed to set evaluation consent:", err)
      toast.error(t("profile.improveTeros.error"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <LGroup>
      <LRow testID="profile-improve-teros">
        <Tile sm icon="sparkle" tone="mint" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="sm">{t("profile.improveTeros.title")}</T>
          <T step="12" tone="text3">{t("profile.improveTeros.sub")}</T>
        </View>
        <Switch on={optIn} onToggle={toggle} disabled={saving} />
      </LRow>
    </LGroup>
  )
}
