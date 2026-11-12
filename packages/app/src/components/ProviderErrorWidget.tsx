import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Animated, Platform, Pressable, View } from "react-native"
import { usePulseAnimation } from "../hooks/usePulseAnimation"
import { getDateLocale } from "../i18n"
import { useColors } from "./mca/primitives/useColors"
import { Btn, Ph, T } from "./ui/ds"

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
 * Follows the RateLimitWidget grammar (card, 380 max-width, dot, disclosure)
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

  // Tone → the theme's status tints (amber / neutral hairline / red).
  const tone =
    config.tone === "amber"
      ? { accent: c.tint.a.tx, edge: c.tint.a.bd, bg: c.tint.a.bg }
      : config.tone === "danger"
        ? { accent: c.tint.r.tx, edge: c.tint.r.bd, bg: c.tint.r.bg }
        : { accent: c.text2, edge: c.borderStrong, bg: c.wash }
  const isTransient = config.variant === "transient"
  const detail = upstreamMessage || technicalMessage
  const showCountdown = isTransient && hasTimeInfo

  return (
    <View
      testID={`provider-error-card-${config.variant}`}
      style={{
        backgroundColor: c.bgStep,
        borderWidth: 1,
        borderColor: c.border,
        borderLeftWidth: 2,
        borderLeftColor: tone.edge,
        borderRadius: 16,
        padding: 16,
        paddingHorizontal: 18,
        marginVertical: 8,
        marginHorizontal: 8,
        maxWidth: 380,
        alignSelf: "flex-start",
      }}
    >
      {/* Header: indicator + title */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
        {isTransient ? (
          <PulsingDot color={tone.accent} />
        ) : (
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 7,
              backgroundColor: tone.bg,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ph
              name={config.tone === "danger" ? "lock-simple" : "warning"}
              size={13}
              color={tone.accent}
            />
          </View>
        )}
        <T step="sm">{t(`errors.provider.${config.copyKey}.title`)}</T>
      </View>

      {/* Hint */}
      <T step="12" tone="text2" style={{ lineHeight: 18, marginBottom: showCountdown ? 12 : 0 }}>
        {t(`errors.provider.${config.copyKey}.hint`)}
      </T>

      {/* Countdown — transient only */}
      {showCountdown && (
        <>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <T step="codenote" tone="text3">
              {t("errors.remaining", { time: timeLeft })}
            </T>
            {resetTime ? (
              <T step="codenote" tone="text3">
                {t("errors.availableAt", { time: resetTime })}
              </T>
            ) : null}
          </View>
          <View
            style={{ height: 3, backgroundColor: c.wash2, borderRadius: 2, overflow: "hidden" }}
          >
            <View
              style={{
                height: "100%",
                width: `${progress}%`,
                borderRadius: 2,
                backgroundColor: tone.accent,
                ...(Platform.OS === "web" ? ({ transition: "width 1s linear" } as any) : null),
              }}
            />
          </View>
        </>
      )}

      {/* Actions */}
      {(isTransient && onRetry) || onChangeModel ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginTop: 13,
            flexWrap: "wrap",
          }}
        >
          {isTransient && onRetry ? (
            <Btn
              testID="provider-error-retry"
              variant="primary"
              size="sm"
              icon="arrow-clockwise"
              onPress={onRetry}
            >
              {t("common.retry")}
            </Btn>
          ) : null}
          {onChangeModel ? (
            <Btn
              testID="provider-error-change-model"
              variant={isTransient ? "sec" : "primary"}
              size="sm"
              icon="swap"
              onPress={onChangeModel}
            >
              {t("errors.changeModel")}
            </Btn>
          ) : null}
        </View>
      ) : null}

      {/* Technical details — the literal upstream text lives here, never in the body */}
      {detail ? (
        <View style={{ marginTop: 11 }}>
          <Pressable
            onPress={() => setShowTechnical((v) => !v)}
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
              {showTechnical ? t("errors.hideTechnicalDetails") : t("errors.showTechnicalDetails")}
            </T>
            <Ph name={showTechnical ? "caret-up" : "caret-down"} size={11} color={c.text3} />
          </Pressable>
          {showTechnical ? (
            <T step="code" tone="text2" style={{ marginTop: 6, fontSize: 11, lineHeight: 16 }}>
              {detail}
            </T>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
