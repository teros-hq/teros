import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from "@tamagui/lucide-icons"
import type React from "react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { TouchableOpacity } from "react-native"
import { Button, Text, XStack, YStack } from "tamagui"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors } from "./mca/primitives/colors"
import { getDateLocale } from "../i18n"
import { HoursExhaustedWidget } from "./billing/HoursExhaustedWidget"
import { PaymentDueWidget } from "./billing/PaymentDueWidget"
import { ProviderErrorWidget, isProviderErrorClass } from "./ProviderErrorWidget"

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
  const isHoursExhausted =
    errorType === "upgrade_required" && context?.reason === "hours_exhausted"
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

  // Transversal payment block (FASE 9, decision B): the turn was rejected because
  // the account has an unpaid invoice past grace. Carried on the same
  // 'upgrade_required' errorType, disambiguated by reason === 'payment_due'.
  const isPaymentDue =
    errorType === "upgrade_required" && context?.reason === "payment_due"
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

  return (
    <YStack
      backgroundColor={c.bgInner}
      borderColor={c.border}
      borderWidth={1}
      borderRadius="$3"
      padding="$3"
      marginVertical="$2"
      marginHorizontal="$2"
      maxWidth="85%"
      alignSelf="flex-start"
    >
      {/* Header with icon and title */}
      <XStack alignItems="center" gap="$2" marginBottom="$2">
        <AlertTriangle size={16} color={semanticColors.amber} />
        <Text color={c.text2} fontWeight="500" fontSize="$2">
          {getErrorTitle(errorType)}
        </Text>
      </XStack>

      {/* Mensaje principal para el usuario */}
      <Text color={c.text2} fontSize="$2" lineHeight="$4" marginBottom="$2">
        {resolvedMessage}
      </Text>

      {/* Non-recoverable hint */}
      {!recoverable && !onRetry && (
        <Text color={c.text3} fontSize="$1" marginBottom="$2">
          {t("errors.contactSupport")}
        </Text>
      )}

      {/* Technical message — collapsed by default */}
      {technicalMessage && (
        <TouchableOpacity onPress={() => setShowTechnical(!showTechnical)}>
          <XStack alignItems="center" gap="$2" marginBottom="$2">
            <Text color={c.text3} fontSize="$1">
              {showTechnical
                ? t("errors.hideTechnicalDetails")
                : t("errors.showTechnicalDetails")}
            </Text>
            {showTechnical ? (
              <ChevronUp size={12} color={c.text3} />
            ) : (
              <ChevronDown size={12} color={c.text3} />
            )}
          </XStack>
        </TouchableOpacity>
      )}
      {showTechnical && technicalMessage && (
        <Text
          color={c.text3}
          fontSize="$1"
          fontFamily="$mono"
          lineHeight="$3"
          marginBottom="$2"
        >
          {technicalMessage}
        </Text>
      )}

      {/* Additional context (only visible when technical details expanded) */}
      {showTechnical && context && Object.keys(context).length > 0 && (
        <TouchableOpacity onPress={() => setShowDetails(!showDetails)}>
          <XStack alignItems="center" gap="$2" marginBottom="$2">
            <Text color={c.text3} fontSize="$1">
              {showDetails ? t("errors.hideContext") : t("errors.showContext")}
            </Text>
            {showDetails ? (
              <ChevronUp size={12} color={c.text3} />
            ) : (
              <ChevronDown size={12} color={c.text3} />
            )}
          </XStack>
        </TouchableOpacity>
      )}
      {showDetails && showTechnical && context && Object.keys(context).length > 0 && (
        <YStack
          backgroundColor={c.bgInner}
          borderRadius="$2"
          padding="$2"
          marginBottom="$2"
        >
          <Text color={c.text3} fontSize="$1" fontWeight="500" marginBottom="$1">
            {t("errors.context")}
          </Text>
          <Text color={c.text3} fontSize="$1" fontFamily="$mono" lineHeight="$3">
            {JSON.stringify(context, null, 2)}
          </Text>
        </YStack>
      )}

      {/* Acciones */}
      <XStack gap="$2" alignItems="center">
        {onRetry && (
          <Button
            size="$2"
            backgroundColor={c.bgInner}
            borderColor={c.border}
            color={c.text2}
            onPress={onRetry}
            icon={RefreshCw}
            fontSize="$1"
          >
            {t("common.retry")}
          </Button>
        )}

        {timestamp && (
          <Text fontSize="$1" color={c.text3}>
            {timestamp.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit" })}
          </Text>
        )}
      </XStack>
    </YStack>
  )
}
