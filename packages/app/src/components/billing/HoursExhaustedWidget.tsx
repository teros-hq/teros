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

import { AlertTriangle } from "@tamagui/lucide-icons"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button, Text, XStack, YStack } from "tamagui"
import { getDateLocale } from "../../i18n"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors, indicators } from "../mca/primitives/colors"
import { BoostModal } from "./BoostModal"

const ACCENT = "#06B6D4"

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
  const c = useColors()
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
    <YStack
      testID="hours-exhausted-widget"
      backgroundColor={c.bgInner}
      borderColor={indicators.irreversible.border}
      borderWidth={1}
      borderRadius="$3"
      padding="$3"
      marginVertical="$2"
      marginHorizontal="$2"
      maxWidth={400}
      alignSelf="flex-start"
      gap="$3"
    >
      <XStack alignItems="center" gap="$2">
        <AlertTriangle size={16} color={semanticColors.red} />
        <Text color={c.text} fontWeight="600" fontSize="$3">
          {t("billing.exhausted.title")}
        </Text>
      </XStack>

      <Text
        testID="hours-exhausted-body"
        color={c.text2}
        fontSize="$2"
        lineHeight="$4"
      >
        {body}
      </Text>

      <XStack gap="$2" flexWrap="wrap">
        <Button
          testID="exhausted-upgrade"
          size="$3"
          backgroundColor="rgba(6,182,212,0.15)"
          borderWidth={1}
          borderColor="rgba(6,182,212,0.4)"
          pressStyle={{ backgroundColor: "rgba(6,182,212,0.25)" }}
          onPress={() => openWindow("profile", { initialMode: "plan" })}
        >
          <Text color={ACCENT} fontSize="$2" fontWeight="600">
            {t("billing.exhausted.ctaUpgrade")}
          </Text>
        </Button>
        <Button
          testID="exhausted-boost"
          size="$3"
          backgroundColor={c.bgCardHover}
          borderWidth={1}
          borderColor={c.borderStrong}
          pressStyle={{ backgroundColor: c.bgCardHover }}
          onPress={() => setBoostOpen(true)}
        >
          <Text color={c.text} fontSize="$2" fontWeight="600">
            {t("billing.exhausted.ctaBoost")}
          </Text>
        </Button>
      </XStack>

      <BoostModal open={boostOpen} onClose={() => setBoostOpen(false)} />
    </YStack>
  )
}
