/**
 * FacturacionTab — the billing view of the admin per-user detail drill-in
 * (TER-685 · PR4). Container that renders the fragmented billing pieces:
 *   - no subscription → a create action,
 *   - otherwise the read `BillingSummary`, toggling to `BillingEditForm`.
 *
 * It threads the row patch up: a create/edit resolves to fresh `BillingInfo`,
 * which becomes `onUpdate({ billing })` so the list + identity reflect it
 * without a re-fetch. Colours are monitoring tokens only.
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Text, YStack } from "tamagui"
import { tokens } from "../../../components/monitoring/colors"
import { SectionCard } from "../../../components/monitoring/Kpi"
import type { BillingInfo, UserDetailEnrichment, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { BillingEditForm } from "../billing/BillingEditForm"
import { BillingSummary } from "../billing/BillingSummary"
import { Button, FormError } from "../billing/formPrimitives"

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
    <YStack paddingTop={4} testID="facturacion-tab">
      <SectionCard title={t("windows.usersPanel.detail.tabs.billing")}>
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
      </SectionCard>
    </YStack>
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
    <YStack gap={12} paddingVertical={8}>
      <Text fontSize={13} color={tokens.textTertiary}>
        {t("windows.usersPanel.billing.noSubscription")}
      </Text>
      {error ? <FormError message={error} testID="billing-create-error" /> : null}
      <YStack ai="flex-start">
        <Button
          testID="billing-create-btn"
          label={t("windows.usersPanel.billing.createSubscription")}
          tone="positive"
          busy={busy}
          onPress={create}
        />
      </YStack>
    </YStack>
  )
}
