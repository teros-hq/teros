/**
 * AutomateQuotaBanner — the "today's Automate runs are spent" strip.
 *
 * Mounted globally next to BillingWarningBanner, driven by billingStore
 * (fed by the automate.quota-exhausted WS event, sent once a day on the
 * first refused run). Red, dismissible; a fresh notice re-surfaces it. Two
 * ways out, both one tap away: upgrade the plan, or open Automate to space
 * out / disable the automation that ate the budget.
 */

import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useBillingStore } from "../../store/billingStore"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../mca/primitives/useColors"
import { Btn, IconBtn, Ph, T } from "../ui/ds"
import { formatResetTime } from "./automateQuotaCopy"

export function AutomateQuotaBanner() {
  const { t } = useTranslation()
  const c = useColors()
  const notice = useBillingStore((s) => s.automateQuota)
  const dismissed = useBillingStore((s) => s.automateQuotaDismissed)
  const dismiss = useBillingStore((s) => s.dismissAutomateQuota)
  const openWindow = useTilingStore((s) => s.openWindow)

  if (!notice || dismissed) return null

  const tint = c.tint.r
  const resetTime = formatResetTime(notice.resetsAt) ?? "00:00 UTC"
  const busiest = notice.topStarters[0]

  return (
    <View
      testID="automate-quota-banner"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: tint.bg,
        borderBottomWidth: 1,
        borderBottomColor: tint.bd,
      }}
    >
      <Ph name="lightning" size={16} color={tint.tx} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T step="sm">
          {t("billing.automateQuota.bannerTitle", { limit: notice.limit, plan: notice.planName })}
        </T>
        <T testID="automate-quota-banner-detail" step="12" tone="text2">
          {busiest
            ? t("billing.automateQuota.bannerDetailBusiest", { name: busiest.name, count: busiest.count, time: resetTime })
            : t("billing.automateQuota.bannerDetail", { time: resetTime })}
        </T>
      </View>

      <Btn
        testID="automate-quota-banner-open"
        size="sm"
        variant="sec"
        icon="lightning"
        onPress={() => openWindow("automate", {})}
      >
        {t("billing.automateQuota.openAutomate")}
      </Btn>
      <Btn
        testID="automate-quota-banner-upgrade"
        size="sm"
        variant="primary"
        icon="arrow-up"
        onPress={() => openWindow("profile", { initialMode: "plan" })}
      >
        {t("billing.automateQuota.ctaUpgrade")}
      </Btn>
      <IconBtn testID="automate-quota-banner-dismiss" icon="x" plain sm title={t("common.close")} onPress={dismiss} />
    </View>
  )
}
