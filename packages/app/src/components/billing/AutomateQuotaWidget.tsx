/**
 * AutomateQuotaWidget — the chat block shown when an automation that messages
 * this channel was skipped because the creator's daily Automate budget is
 * spent (plan cap on runs per UTC day).
 *
 * The backend posts it once a day, on the first refusal, as a chat error
 * message with errorType 'upgrade_required' and context { reason:
 * 'automate_quota', used, limit, planName, resetsAt, starterName,
 * topStarters } (server-bootstrap, AutomateQuotaService.onExhausted).
 * ErrorBlock special-cases it and renders this widget. Sibling of
 * HoursExhaustedWidget: frames the block around the PLAN and the RESET TIME
 * and offers the ways out — upgrade the plan, or open Automate to space out
 * / disable the automation that ate the budget.
 */

import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useTilingStore } from "../../store/tilingStore"
import { Btn, T, Tile } from "../ui/ds"
import { Card } from "../ui/ds/Card"
import { formatResetTime } from "./automateQuotaCopy"

export interface AutomateQuotaWidgetProps {
  used?: number
  limit?: number
  planName?: string
  /** ISO — next 00:00 UTC. */
  resetsAt?: string
  /** The automation whose run was skipped. */
  starterName?: string
  topStarters?: Array<{ starterId: string; name: string; count: number }>
}

export function AutomateQuotaWidget({ limit, planName, resetsAt, starterName, topStarters }: AutomateQuotaWidgetProps) {
  const { t } = useTranslation()
  const openWindow = useTilingStore((s) => s.openWindow)
  const resetTime = formatResetTime(resetsAt)
  const busiest = topStarters?.[0]

  const body =
    planName && typeof limit === "number"
      ? t("billing.automateQuota.body", { plan: planName, limit, time: resetTime ?? "00:00 UTC" })
      : t("billing.automateQuota.bodyGeneric", { time: resetTime ?? "00:00 UTC" })

  return (
    <View
      testID="automate-quota-widget"
      style={{ marginVertical: 8, marginHorizontal: 8, maxWidth: 420, alignSelf: "flex-start" }}
    >
      <Card pad>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Tile tone="amber" size="sm" icon="lightning" />
          <T step="base" style={{ flex: 1 }}>
            {starterName
              ? t("billing.automateQuota.title", { name: starterName })
              : t("billing.automateQuota.titleGeneric")}
          </T>
        </View>

        <T testID="automate-quota-body" step="sm" tone="text2" style={{ marginTop: 10 }}>
          {body}
        </T>
        {busiest ? (
          <T testID="automate-quota-busiest" step="12" tone="text3" style={{ marginTop: 6 }}>
            {t("billing.automateQuota.busiest", { name: busiest.name, count: busiest.count })}
          </T>
        ) : null}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
          <Btn
            testID="automate-quota-upgrade"
            variant="primary"
            size="sm"
            icon="arrow-up"
            onPress={() => openWindow("profile", { initialMode: "plan" })}
          >
            {t("billing.automateQuota.ctaUpgrade")}
          </Btn>
          <Btn
            testID="automate-quota-open"
            variant="sec"
            size="sm"
            icon="lightning"
            onPress={() => openWindow("automate", {})}
          >
            {t("billing.automateQuota.openAutomate")}
          </Btn>
        </View>
      </Card>
    </View>
  )
}
