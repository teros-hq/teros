/**
 * BillingWarningBanner — the 80% agent-hours banner (TER-596 I4 redesign).
 *
 * Lives OUTSIDE the chat flow: mounted globally in the workspace layout next to
 * ImpersonationBanner. Driven by billingStore (fed by billing.usage-warning via
 * useBillingRealtimeSync). Informative and dismissible; a fresh warning
 * re-surfaces it. Its CTA opens the shared BoostModal (which buys for individual
 * users and requests from the admin for team members) — it never blocks anything
 * and never assumes the "request" path up front.
 *
 * Presentation: a full-width tinted strip (amber; red once the hours are gone)
 * with a Phosphor warning glyph, the copy, a small pill CTA and a dismiss.
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getDateLocale } from "../../i18n"
import { useBillingStore } from "../../store/billingStore"
import { useColors } from "../mca/primitives/useColors"
import { Btn, IconBtn, Ph, T } from "../ui/ds"
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
  const exhausted = warning.limit > 0 && warning.used >= warning.limit
  const tint = exhausted ? c.tint.r : c.tint.a
  const renewsAt = warning.periodEnd
    ? new Date(warning.periodEnd).toLocaleDateString(getDateLocale(), {
        day: "numeric",
        month: "short",
      })
    : null

  return (
    <View
      testID="billing-warning-banner"
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
      <Ph name="warning" size={16} color={tint.tx} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T step="sm">
          {warning.planName
            ? t("billing.warning.titlePlan", { pct, plan: warning.planName })
            : t("billing.warning.title", { pct })}
        </T>
        <T testID="billing-warning-usage" step="12" tone="text2">
          {warning.used.toFixed(1)}h / {warning.limit}h
          {renewsAt ? ` · ${t("billing.warning.renews", { date: renewsAt })}` : ""}
        </T>
      </View>

      <Btn
        testID="billing-warning-cta"
        size="sm"
        variant={exhausted ? "primary" : "amber"}
        icon="lightning"
        onPress={() => setBoostOpen(true)}
      >
        {t("billing.warning.getMore")}
      </Btn>
      <IconBtn
        testID="billing-warning-dismiss"
        icon="x"
        plain
        sm
        title={t("common.close")}
        onPress={dismissWarning}
      />

      <BoostModal open={boostOpen} onClose={() => setBoostOpen(false)} />
    </View>
  )
}
