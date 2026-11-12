import type React from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { useColors } from "./mca/primitives/useColors"
import { getDateLocale } from "../i18n"
import { AutomateQuotaWidget } from "./billing/AutomateQuotaWidget"
import { HoursExhaustedWidget } from "./billing/HoursExhaustedWidget"
import { PaymentDueWidget } from "./billing/PaymentDueWidget"
import { ProviderErrorWidget, isProviderErrorClass } from "./ProviderErrorWidget"
import { Btn, Ph, T } from "./ui/ds"

export interface ErrorBlockProps {
  errorType: "llm" | "tool" | "session" | "validation" | "network" | "unknown" | "upgrade_required"
  userMessage: string
  technicalMessage?: string
  context?: Record<string, any>
  onRetry?: () => void
  onChangeModel?: () => void
  timestamp?: Date
}

// ============================================================================
// Main ErrorBlock Component
// ============================================================================

/** A quiet disclosure row ("Show technical details" + caret). */
function Disclosure({
  open,
  onPress,
  label,
}: {
  open: boolean
  onPress: () => void
  label: string
}) {
  const c = useColors()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          opacity: pressed ? 0.7 : 1,
        },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      <T step="12" tone="text3">
        {label}
      </T>
      <Ph name={open ? "caret-up" : "caret-down"} size={11} color={c.text3} />
    </Pressable>
  )
}

export const ErrorBlock: React.FC<ErrorBlockProps> = ({
  errorType,
  userMessage,
  technicalMessage,
  context,
  onRetry,
  onChangeModel,
  timestamp,
}) => {
  const { t } = useTranslation()
  const c = useColors()
  const [showDetails, setShowDetails] = useState(false)
  const [showTechnical, setShowTechnical] = useState(false)

  const recoverable = context?.recoverable !== false

  // Resolve i18n key if available
  const resolvedMessage =
    context?.i18nKey && t(context.i18nKey) !== context.i18nKey ? t(context.i18nKey) : userMessage

  // Provider (LLM) errors get the honest, warm, per-class widget (TER-699):
  // capacity/overloaded → transient with a countdown + Retry; billing/model/auth
  // → persistent with Change model. The precise cause stays in the ops dashboard.
  if (errorType === "llm" && isProviderErrorClass(context?.errorClass)) {
    return (
      <ProviderErrorWidget
        errorClass={context?.errorClass}
        errorSubReason={context?.errorSubReason}
        resetAt={context?.resetAt}
        retryAfterSecs={context?.retryAfterSecs}
        source={context?.source}
        upstreamMessage={context?.upstreamMessage}
        technicalMessage={technicalMessage}
        onRetry={onRetry}
        onChangeModel={onChangeModel}
      />
    )
  }

  // Agent-hours hard block (FASE 6, decision #10): the turn was rejected because
  // the user exhausted their plan's agent-hours. Render the request-access CTA
  // instead of a plain error so they can ask for a boost without leaving the chat.
  const isHoursExhausted = errorType === "upgrade_required" && context?.reason === "hours_exhausted"
  if (isHoursExhausted) {
    return (
      <HoursExhaustedWidget
        used={context?.used}
        limit={context?.limit}
        tier={context?.tier}
        planName={context?.planName}
        periodEnd={context?.periodEnd}
      />
    )
  }

  // Automate daily quota (2026-10-15): the automation that messages this channel
  // was skipped because the creator's plan budget of runs per day is spent.
  // Same 'upgrade_required' carrier, disambiguated by reason === 'automate_quota'.
  const isAutomateQuota = errorType === "upgrade_required" && context?.reason === "automate_quota"
  if (isAutomateQuota) {
    return (
      <AutomateQuotaWidget
        used={context?.used}
        limit={context?.limit}
        planName={context?.planName}
        resetsAt={context?.resetsAt}
        starterName={context?.starterName}
        topStarters={context?.topStarters}
      />
    )
  }

  // Transversal payment block (FASE 9, decision B): the turn was rejected because
  // the account has an unpaid invoice past grace. Carried on the same
  // 'upgrade_required' errorType, disambiguated by reason === 'payment_due'.
  const isPaymentDue = errorType === "upgrade_required" && context?.reason === "payment_due"
  if (isPaymentDue) {
    return (
      <PaymentDueWidget
        amount={context?.amount}
        currency={context?.currency}
        hostedInvoiceUrl={context?.hostedInvoiceUrl}
      />
    )
  }

  const getErrorTitle = (type: string) => {
    switch (type) {
      case "llm":
        return t("errors.assistantError")
      case "tool":
        return t("errors.toolError")
      case "session":
        return t("errors.sessionError")
      case "validation":
        return t("errors.validationError")
      case "network":
        return t("errors.connectionError")
      default:
        return t("errors.unknownError")
    }
  }

  const hasContext = !!context && Object.keys(context).length > 0

  return (
    <View
      style={{
        backgroundColor: c.bgStep,
        borderWidth: 1,
        borderColor: c.border,
        borderLeftWidth: 2,
        borderLeftColor: c.tint.a.bd,
        borderRadius: 16,
        padding: 14,
        paddingHorizontal: 16,
        marginVertical: 8,
        marginHorizontal: 8,
        maxWidth: "85%",
        alignSelf: "flex-start",
        gap: 8,
      }}
    >
      {/* Header with icon tile and title */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            backgroundColor: c.tint.a.bg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ph name="warning" size={13} color={c.tint.a.tx} />
        </View>
        <T step="sm">{getErrorTitle(errorType)}</T>
      </View>

      {/* Mensaje principal para el usuario */}
      <T step="sm" tone="text2" style={{ lineHeight: 19 }}>
        {resolvedMessage}
      </T>

      {/* Non-recoverable hint */}
      {!recoverable && !onRetry && (
        <T step="12" tone="text3">
          {t("errors.contactSupport")}
        </T>
      )}

      {/* Technical message — collapsed by default */}
      {technicalMessage && (
        <Disclosure
          open={showTechnical}
          onPress={() => setShowTechnical(!showTechnical)}
          label={
            showTechnical ? t("errors.hideTechnicalDetails") : t("errors.showTechnicalDetails")
          }
        />
      )}
      {showTechnical && technicalMessage && (
        <T step="code" tone="text3" style={{ lineHeight: 17 }}>
          {technicalMessage}
        </T>
      )}

      {/* Additional context (only visible when technical details expanded) */}
      {showTechnical && hasContext && (
        <Disclosure
          open={showDetails}
          onPress={() => setShowDetails(!showDetails)}
          label={showDetails ? t("errors.hideContext") : t("errors.showContext")}
        />
      )}
      {showDetails && showTechnical && hasContext && (
        <View style={{ backgroundColor: c.nest, borderRadius: 10, padding: 10, gap: 4 }}>
          <T step="codenote" tone="text3">
            {t("errors.context")}
          </T>
          <T step="code" tone="text3" style={{ lineHeight: 17 }}>
            {JSON.stringify(context, null, 2)}
          </T>
        </View>
      )}

      {/* Acciones */}
      {(onRetry || timestamp) && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 }}>
          {onRetry && (
            <Btn variant="sec" size="sm" icon="arrow-clockwise" onPress={onRetry}>
              {t("common.retry")}
            </Btn>
          )}

          {timestamp && (
            <T step="codenote" tone="text3">
              {timestamp.toLocaleTimeString(getDateLocale(), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </T>
          )}
        </View>
      )}
    </View>
  )
}
