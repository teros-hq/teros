import { AlertTriangle, Lock, RefreshCw, Repeat } from "@tamagui/lucide-icons"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Animated } from "react-native"
import { Button, Text, View, XStack, YStack } from "tamagui"
import { usePulseAnimation } from "../hooks/usePulseAnimation"
import { getDateLocale } from "../i18n"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors, surface } from "./mca/primitives/colors"

/**
 * ProviderErrorWidget — the honest, warm error card for Teros LLM-provider
 * failures (Fireworks/Together), keyed on `context.errorClass` (+ `errorSubReason`).
 *
 * Two variants along one axis — will it recover on its own?
 *   • transient  (rate_limited / overloaded): amber, pulsing dot, live countdown,
 *     primary action Retry. Copy owns a busy moment lightly ("lots of activity"),
 *     never blames the user, never says the platform is down.
 *   • persistent (spend_gate / model_unavailable / auth): no countdown, neutral or
 *     red, primary action Change model. The precise cause (billing vs missing
 *     model) is NEVER surfaced to the user — it lives in the ops dashboard.
 *
 * Follows the RateLimitWidget grammar (dark card, 360 max-width, dot, disclosure)
 * so it reads as the same product surface. See docs mockup (TER-699).
 */

type Tone = "amber" | "neutral" | "danger"
type Primary = "retry" | "changeModel"

interface ClassConfig {
  variant: "transient" | "persistent"
  /** i18n sub-key under `errors.provider.*`. */
  copyKey: "capacity" | "overloaded" | "billing" | "modelUnavailable" | "auth"
  tone: Tone
  primary: Primary
}

/**
 * errorClass → presentation. Sub-reasons (`account_rate_limit` / `token_rate_limit`)
 * intentionally collapse into the same user-facing copy as `provider_capacity`:
 * the user doesn't need the distinction, only ops does.
 */
const CLASS_CONFIG: Record<string, ClassConfig> = {
  rate_limited: { variant: "transient", copyKey: "capacity", tone: "amber", primary: "retry" },
  overloaded: { variant: "transient", copyKey: "overloaded", tone: "amber", primary: "retry" },
  spend_gate: {
    variant: "persistent",
    copyKey: "billing",
    tone: "neutral",
    primary: "changeModel",
  },
  not_found: {
    variant: "persistent",
    copyKey: "modelUnavailable",
    tone: "neutral",
    primary: "changeModel",
  },
  auth: { variant: "persistent", copyKey: "auth", tone: "danger", primary: "changeModel" },
}

/** The errorClasses this widget owns. Others fall through to the generic ErrorBlock. */
export function isProviderErrorClass(errorClass?: unknown): boolean {
  return typeof errorClass === "string" && errorClass in CLASS_CONFIG
}

const TONE_COLORS: Record<Tone, { accent: string; edge: string }> = {
  amber: { accent: semanticColors.amber, edge: "rgba(245,158,11,0.5)" },
  neutral: { accent: surface.dark.text2, edge: surface.dark.borderStrong },
  danger: { accent: semanticColors.red, edge: "rgba(239,68,68,0.45)" },
}

export interface ProviderErrorWidgetProps {
  errorClass: string
  errorSubReason?: string
  resetAt?: number
  retryAfterSecs?: number
  source?: string
  /** Literal upstream text — shown ONLY inside the collapsed technical disclosure. */
  upstreamMessage?: string
  technicalMessage?: string
  onRetry?: () => void
  onChangeModel?: () => void
}

/** Pulsing dot for the transient variant (busy, will recover). */
function PulsingDot({ color }: { color: string }) {
  const opacity = usePulseAnimation(true, { minOpacity: 0.4, duration: 1100 })
  return (
    <Animated.View
      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity }}
    />
  )
}

/**
 * Countdown for the transient variant. Returns the formatted time-left, the
 * reset clock string, and a 0–100 progress. Mirrors RateLimitWidget's logic.
 */
function useCountdown(resetAt?: number, retryAfterSecs?: number) {
  const { t } = useTranslation()
  const [timeLeft, setTimeLeft] = useState("")
  const [resetTime, setResetTime] = useState("")
  const [progress, setProgress] = useState(0)
  const initialDiff = useRef<number | null>(null)
  const hasTimeInfo = Boolean(resetAt || retryAfterSecs)

  useEffect(() => {
    if (resetAt) {
      setResetTime(
        new Date(resetAt).toLocaleTimeString(getDateLocale(), {
          hour: "2-digit",
          minute: "2-digit",
        }),
      )
    }
    const tick = () => {
      const target = resetAt || (retryAfterSecs ? Date.now() + retryAfterSecs * 1000 : 0)
      if (!target) {
        setTimeLeft(t("errors.aFewMinutes"))
        setProgress(0)
        return
      }
      const diff = target - Date.now()
      if (initialDiff.current === null && diff > 0) initialDiff.current = diff
      if (diff <= 0) {
        setTimeLeft(t("errors.now"))
        setProgress(100)
        return
      }
      if (initialDiff.current) {
        setProgress(Math.min(100, ((initialDiff.current - diff) / initialDiff.current) * 100))
      }
      const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
      const s = Math.floor((diff % (1000 * 60)) / 1000)
      setTimeLeft(`${m}:${s.toString().padStart(2, "0")}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [resetAt, retryAfterSecs, t])

  return { timeLeft, resetTime, progress, hasTimeInfo }
}

export function ProviderErrorWidget({
  errorClass,
  resetAt,
  retryAfterSecs,
  upstreamMessage,
  technicalMessage,
  onRetry,
  onChangeModel,
}: ProviderErrorWidgetProps) {
  const { t } = useTranslation()
  const c = useColors()
  const [showTechnical, setShowTechnical] = useState(false)
  const config = CLASS_CONFIG[errorClass]
  const { timeLeft, resetTime, progress, hasTimeInfo } = useCountdown(resetAt, retryAfterSecs)

  // Defensive: only rendered for known provider classes (isProviderErrorClass).
  if (!config) return null

  const tone = TONE_COLORS[config.tone]
  const isTransient = config.variant === "transient"
  const detail = upstreamMessage || technicalMessage
  const showCountdown = isTransient && hasTimeInfo

  return (
    <YStack
      testID={`provider-error-card-${config.variant}`}
      backgroundColor={c.bgInner}
      borderColor={c.border}
      borderWidth={1}
      borderLeftWidth={2}
      borderLeftColor={tone.edge}
      borderRadius={12}
      padding={16}
      paddingHorizontal={20}
      marginVertical="$2"
      marginHorizontal="$2"
      maxWidth={380}
      alignSelf="flex-start"
    >
      {/* Header: indicator + title */}
      <XStack alignItems="center" gap={10} marginBottom={8}>
        {isTransient ? (
          <PulsingDot color={tone.accent} />
        ) : config.tone === "danger" ? (
          <Lock size={15} color={tone.accent} />
        ) : (
          <AlertTriangle size={15} color={tone.accent} />
        )}
        <Text color={c.text} fontWeight="600" fontSize={13}>
          {t(`errors.provider.${config.copyKey}.title`)}
        </Text>
      </XStack>

      {/* Hint */}
      <Text
        color={c.text2}
        fontSize={12}
        lineHeight={18}
        marginBottom={showCountdown ? 12 : 0}
      >
        {t(`errors.provider.${config.copyKey}.hint`)}
      </Text>

      {/* Countdown — transient only */}
      {showCountdown && (
        <>
          <XStack justifyContent="space-between" alignItems="center" marginBottom={12}>
            <Text color={c.text3} fontSize={12}>
              {t("errors.remaining", { time: timeLeft })}
            </Text>
            {resetTime ? (
              <Text color={c.text3} fontSize={12}>
                {t("errors.availableAt", { time: resetTime })}
              </Text>
            ) : null}
          </XStack>
          <View
            height={3}
            backgroundColor={c.border}
            borderRadius={2}
            overflow="hidden"
          >
            <View
              height="100%"
              width={`${progress}%`}
              borderRadius={2}
              backgroundColor={tone.accent}
            />
          </View>
        </>
      )}

      {/* Actions */}
      <XStack gap="$2" alignItems="center" marginTop={13} flexWrap="wrap">
        {isTransient && onRetry ? (
          <Button
            testID="provider-error-retry"
            size="$2"
            backgroundColor={c.badges.info.bg}
            borderColor={c.badges.info.border}
            color={c.badges.info.text}
            onPress={onRetry}
            icon={RefreshCw}
            fontSize="$1"
          >
            {t("common.retry")}
          </Button>
        ) : null}
        {onChangeModel ? (
          <Button
            testID="provider-error-change-model"
            size="$2"
            backgroundColor={isTransient ? c.bgInner : c.badges.info.bg}
            borderColor={isTransient ? c.border : c.badges.info.border}
            color={isTransient ? c.text2 : c.badges.info.text}
            onPress={onChangeModel}
            icon={Repeat}
            fontSize="$1"
          >
            {t("errors.changeModel")}
          </Button>
        ) : null}
      </XStack>

      {/* Technical details — the literal upstream text lives here, never in the body */}
      {detail ? (
        <YStack marginTop={11}>
          <Text
            color={c.text3}
            fontSize={11}
            onPress={() => setShowTechnical((v) => !v)}
          >
            {showTechnical ? t("errors.hideTechnicalDetails") : t("errors.showTechnicalDetails")}
          </Text>
          {showTechnical ? (
            <Text
              marginTop={6}
              color={c.text2}
              fontSize={11}
              fontFamily="$mono"
              lineHeight={16}
            >
              {detail}
            </Text>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  )
}
