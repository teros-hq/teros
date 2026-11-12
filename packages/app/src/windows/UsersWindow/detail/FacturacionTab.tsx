/**
 * FacturacionTab — the billing view of the admin per-user detail drill-in
 * (TER-685 · PR4). Container that renders the fragmented billing pieces:
 *   - no subscription → a create action,
 *   - otherwise the read `BillingSummary`, toggling to `BillingEditForm`.
 *
 * It threads the row patch up: a create/edit resolves to fresh `BillingInfo`,
 * which becomes `onUpdate({ billing })` so the list + identity reflect it
 * without a re-fetch. Presentation: one ds `Card`; colours from `useColors()`.
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { Btn, Card, T } from "../../../components/ui/ds"
import type { BillingInfo, UserDetailEnrichment, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { BillingEditForm } from "../billing/BillingEditForm"
import { BillingSummary } from "../billing/BillingSummary"
import { FormError } from "../billing/formPrimitives"

export interface FacturacionTabProps {
  /** List row merged with the lazy enrichment (billing + stats). */
  user: UserSummary
  /** Raw enrichment (null until loaded). */
  detail: UserDetailEnrichment | null
  /** Patch the row after a billing edit so the list + identity reflect it. */
  onUpdate: (patch: Partial<UserSummary>) => void
  /** Refetch the user detail after a period hour-boost grant/revoke (fresh
   *  effectiveLimit + usage). */
  onChanged?: () => void
}

export function FacturacionTab({ user, onUpdate, onChanged }: FacturacionTabProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const billing = user.billing

  const applyBilling = (next: BillingInfo) => {
    onUpdate({ billing: next })
    setEditing(false)
  }

  return (
    <View testID="facturacion-tab">
      <Card pad>
        <T step="base" style={{ marginBottom: 12 }}>
          {t("windows.usersPanel.detail.tabs.billing")}
        </T>
        {billing == null ? (
          <NoBilling user={user} onCreated={applyBilling} />
        ) : editing ? (
          <BillingEditForm
            user={user}
            billing={billing}
            onCancel={() => setEditing(false)}
            onSaved={applyBilling}
          />
        ) : (
          <BillingSummary
            user={user}
            billing={billing}
            onEdit={() => setEditing(true)}
            onChanged={onChanged}
          />
        )}
      </Card>
    </View>
  )
}

function NoBilling({
  user,
  onCreated,
}: {
  user: UserSummary
  onCreated: (billing: BillingInfo) => void
}) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await client.admin.updateBillingSubscription({ targetUserId: user.userId })
      onCreated(result.subscription)
    } catch (e) {
      setError((e as { message?: string })?.message ?? t("windows.usersPanel.billing.createFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ gap: 12, paddingVertical: 4 }}>
      <T step="sm" tone="text3">
        {t("windows.usersPanel.billing.noSubscription")}
      </T>
      {error ? <FormError message={error} testID="billing-create-error" /> : null}
      <View style={{ alignItems: "flex-start" }}>
        <Btn testID="billing-create-btn" variant="mint" icon="plus" loading={busy} onPress={create}>
          {t("windows.usersPanel.billing.createSubscription")}
        </Btn>
      </View>
    </View>
  )
}
