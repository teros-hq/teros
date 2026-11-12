/**
 * HoursExhaustedWidget — the hard-block CTA shown inside the chat ErrorBlock when
 * a Teros-model turn is rejected with HoursExhaustedError (FASE 6, decision #10;
 * redesigned in TER-596 I4).
 *
 * The backend propagates the block as a chat error message with errorType
 * 'upgrade_required' and context { reason:'hours_exhausted', used, limit, tier,
 * planName, periodEnd } (agent-loop.ts). ErrorBlock special-cases it and renders
 * this widget. It frames the block around the ACTIVE PLAN and the RESET DATE (not
 * a raw hour count) and offers two ways forward: upgrade the plan (opens
 * Profile → Plan) or get a boost (opens the BoostModal, which buys for individual
 * users and requests from the admin for team members).
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getDateLocale } from "../../i18n"
import { useTilingStore } from "../../store/tilingStore"
import { Btn, Card, T, Tile } from "../ui/ds"
import { BoostModal } from "./BoostModal"

export interface HoursExhaustedWidgetProps {
  used?: number
  limit?: number
  tier?: string
  /** Human-readable plan name (displayName). */
  planName?: string
  /** ISO date the hours reset (currentPeriodEnd). */
  periodEnd?: string
}

export function HoursExhaustedWidget({ planName, periodEnd }: HoursExhaustedWidgetProps) {
  const { t } = useTranslation()
  const openWindow = useTilingStore((s) => s.openWindow)
  const [boostOpen, setBoostOpen] = useState(false)

  const resetDate = periodEnd
    ? new Date(periodEnd).toLocaleDateString(getDateLocale(), { day: "numeric", month: "long" })
    : null

  let body: string
  if (planName && resetDate) {
    body = t("billing.exhausted.body", { plan: planName, date: resetDate })
  } else if (resetDate) {
    body = t("billing.exhausted.bodyNoPlan", { date: resetDate })
  } else {
    body = t("billing.exhausted.bodyGeneric")
  }

  return (
    <View
      testID="hours-exhausted-widget"
      style={{ marginVertical: 8, marginHorizontal: 8, maxWidth: 400, alignSelf: "flex-start" }}
    >
      <Card pad>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Tile tone="amber" size="sm" icon="warning" />
          <T step="base" style={{ flex: 1 }}>
            {t("billing.exhausted.title")}
          </T>
        </View>

        <T testID="hours-exhausted-body" step="sm" tone="text2" style={{ marginTop: 10 }}>
          {body}
        </T>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
          {/* Upgrade is the primary path out of exhaustion. */}
          <Btn
            testID="exhausted-upgrade"
            variant="primary"
            size="sm"
            icon="arrow-up"
            onPress={() => openWindow("profile", { initialMode: "plan" })}
          >
            {t("billing.exhausted.ctaUpgrade")}
          </Btn>
          {/* Secondary, outlined: an alternative path. */}
          <Btn
            testID="exhausted-boost"
            variant="sec"
            size="sm"
            icon="lightning"
            onPress={() => setBoostOpen(true)}
          >
            {t("billing.exhausted.ctaBoost")}
          </Btn>
        </View>
      </Card>

      <BoostModal open={boostOpen} onClose={() => setBoostOpen(false)} />
    </View>
  )
}
