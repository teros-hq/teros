/**
 * BillingWarningBanner — the non-invasive 80% usage notice (FASE 6, decision #11;
 * refreshed in TER-596 I4).
 *
 * Lives OUTSIDE the chat flow: mounted globally in the workspace layout next to
 * ImpersonationBanner. Driven by billingStore (fed by billing.usage-warning via
 * useBillingRealtimeSync). Informative and dismissible; a fresh warning
 * re-surfaces it. Its CTA opens the shared BoostModal (which buys for individual
 * users and requests from the admin for team members) — it never blocks anything
 * and never assumes the "request" path up front.
 */

import { X } from "@tamagui/lucide-icons"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button, Text, XStack, YStack } from "tamagui"
import { getDateLocale } from "../../i18n"
import { useBillingStore } from "../../store/billingStore"
import { useColors } from "../mca/primitives/useColors"
import { indicators } from "../mca/primitives/colors"
import { BoostModal } from "./BoostModal"

export function BillingWarningBanner() {
  const { t } = useTranslation()
  const c = useColors()
  const warning = useBillingStore((s) => s.warning)
  const dismissed = useBillingStore((s) => s.warningDismissed)
  const dismissWarning = useBillingStore((s) => s.dismissWarning)
  const [boostOpen, setBoostOpen] = useState(false)

  if (!warning || dismissed) return null

  const pct = warning.limit > 0 ? Math.round((warning.used / warning.limit) * 100) : 0
  const renewsAt = warning.periodEnd
    ? new Date(warning.periodEnd).toLocaleDateString(getDateLocale(), {
        day: "numeric",
        month: "short",
      })
    : null

  return (
    <YStack
      testID="billing-warning-banner"
      backgroundColor={indicators.risk.bg}
      borderBottomWidth={1}
      borderBottomColor={indicators.risk.border}
      paddingHorizontal="$3"
      paddingVertical="$2"
    >
      <XStack alignItems="center" justifyContent="space-between" gap="$3">
        <YStack flex={1} gap="$0.5">
          <Text color={c.text} fontSize="$2" fontWeight="600">
            {warning.planName
              ? t("billing.warning.titlePlan", { pct, plan: warning.planName })
              : t("billing.warning.title", { pct })}
          </Text>
          <Text testID="billing-warning-usage" color={c.text2} fontSize="$1">
            {warning.used.toFixed(1)}h / {warning.limit}h
            {renewsAt ? ` · ${t("billing.warning.renews", { date: renewsAt })}` : ""}
          </Text>
        </YStack>

        <XStack alignItems="center" gap="$1">
          <Button
            testID="billing-warning-cta"
            size="$2"
            backgroundColor={indicators.risk.bg}
            color={indicators.risk.fg}
            pressStyle={{ backgroundColor: "rgba(245, 158, 11, 0.22)" }}
            onPress={() => setBoostOpen(true)}
          >
            {t("billing.warning.getMore")}
          </Button>
          <Button
            testID="billing-warning-dismiss"
            size="$2"
            circular
            chromeless
            icon={<X size={16} color={c.text3} />}
            onPress={dismissWarning}
          />
        </XStack>
      </XStack>

      <BoostModal open={boostOpen} onClose={() => setBoostOpen(false)} />
    </YStack>
  )
}
