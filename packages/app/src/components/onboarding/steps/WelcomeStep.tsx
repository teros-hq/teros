/**
 * WelcomeStep — Step 0 content, revealed after WelcomeSplash completes.
 *
 * All animated values start at 0 (invisible). Entrance animations fire only
 * when `animateIn` flips to true (i.e. the splash overlay has finished).
 *
 * No Skip, no Back — just "Get started →".
 */

import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Animated, Easing, Image, View } from "react-native"
import { TerosLogo } from "../../TerosLogo"
import { useColors } from "../../mca/primitives/useColors"
import { Badge, SectionLabel, T } from "../../ui/ds"
import type { StepFooterConfig } from "../StepFooter"
import { type OnboardingStepId, setupItems } from "../onboardingSteps"

// ── Animation hooks ────────────────────────────────────────────────────────────

function useFadeSlide(delayMs: number, trigger: boolean) {
  const opacity = useRef(new Animated.Value(0)).current
  const translateY = useRef(new Animated.Value(18)).current

  useEffect(() => {
    if (!trigger) return
    const anim = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 420,
        delay: delayMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 420,
        delay: delayMs,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ])
    anim.start()
    return () => anim.stop()
  }, [trigger, opacity, translateY, delayMs])

  return { opacity, transform: [{ translateY }] }
}

function useInstantIn(trigger: boolean) {
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!trigger) return
    opacity.setValue(1) // instant — splash logo "becomes" this logo
  }, [trigger, opacity])

  return { opacity }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/** ONB-REQ-9: exactly the steps of this run after Welcome. */
function SetupPreview({ steps }: { steps: OnboardingStepId[] }) {
  const { t } = useTranslation()
  const c = useColors()
  const SETUP_STEP_KEYS = setupItems(steps).map((it, i) => ({
    n: String(i + 1),
    labelKey: it.labelKey,
    subKey: it.subKey,
  }))
  if (SETUP_STEP_KEYS.length === 0) return null
  return (
    <View>
      <SectionLabel
        label={t("onboarding.whatWeWillSetUp")}
        count={SETUP_STEP_KEYS.length}
        style={{ marginTop: 0, marginBottom: 10 }}
      />
      <View style={{ borderRadius: 16, backgroundColor: c.nest, overflow: "hidden" }}>
        {SETUP_STEP_KEYS.map((s, i) => (
          <View
            key={s.n}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderTopWidth: i > 0 ? 1 : 0,
              borderTopColor: c.border,
            }}
          >
            <View
              style={{
                width: 26,
                height: 26,
                borderRadius: 13,
                backgroundColor: c.tile,
                justifyContent: "center",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <T step="code" tone="accent" style={{ fontSize: 11 }}>
                {s.n}
              </T>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T step="sm">{t(s.labelKey)}</T>
              <T step="12" tone="text3">
                {t(s.subKey)}
              </T>
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

interface IriaCardProps {
  agentName: string
  agentAvatarUrl?: string
}

function IriaCard({ agentName, agentAvatarUrl }: IriaCardProps) {
  const { t } = useTranslation()
  const c = useColors()
  const initials = agentName
    .split(" ")
    .map((w) => w[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase()

  return (
    <View
      style={{
        padding: 16,
        backgroundColor: c.tint.i.bg,
        borderWidth: 1,
        borderColor: c.tint.i.bd,
        borderRadius: 16,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        {agentAvatarUrl ? (
          <Image
            source={{ uri: agentAvatarUrl }}
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              borderWidth: 2,
              borderColor: c.borderAccent,
            }}
          />
        ) : (
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              backgroundColor: c.bgStep,
              borderWidth: 2,
              borderColor: c.borderAccent,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <T step="hsm" tone="accent">
              {initials || "AI"}
            </T>
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <T step="base">{agentName}</T>
            <Badge tone="i" pill cap>
              {t("onboarding.yourAgent")}
            </Badge>
          </View>
          <T step="12" tone="text3">
            {t("onboarding.agentReadyToHelp")}
          </T>
        </View>
      </View>

      <T step="sm" tone="text2" style={{ lineHeight: 19 }}>
        {t("onboarding.agentIntro", { agentName })}
      </T>
    </View>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface WelcomeStepProps {
  /** Steps of this run (ONB-REQ-5), for the setup list. */
  steps: OnboardingStepId[]
  agentName: string
  agentAvatarUrl?: string
  animateIn: boolean
  setFooterConfig: (config: StepFooterConfig) => void
  registerContinueHandler: (handler: () => void) => void
  onComplete: () => void
}

export function WelcomeStep({
  steps,
  agentName,
  agentAvatarUrl,
  animateIn,
  setFooterConfig,
  registerContinueHandler,
  onComplete,
}: WelcomeStepProps) {
  const { t } = useTranslation()
  const c = useColors()
  const logoStyle = useInstantIn(animateIn)
  const titleStyle = useFadeSlide(80, animateIn)
  const iriaStyle = useFadeSlide(300, animateIn)
  const stepsStyle = useFadeSlide(500, animateIn)

  useEffect(() => {
    setFooterConfig({
      showBack: false,
      showSkip: false,
      continueLabel: t("onboarding.letsGetStarted"),
      continueDisabled: false,
    })
    registerContinueHandler(onComplete)
  }, [setFooterConfig, registerContinueHandler, onComplete, t])

  return (
    <View style={{ gap: 24, paddingBottom: 8 }}>
      <View style={{ alignItems: "center", gap: 16, paddingTop: 8 }}>
        <Animated.View style={logoStyle}>
          <TerosLogo size={80} color={c.accent} animated />
        </Animated.View>

        <Animated.View style={titleStyle}>
          <View style={{ alignItems: "center", gap: 6 }}>
            <T step="2xl" center style={{ fontSize: 30, lineHeight: 34 }}>
              {t("onboarding.welcomeTitle")}
            </T>
            <T step="sm" tone="text2" center style={{ lineHeight: 19 }}>
              {t("onboarding.welcomeSubtitle")}
            </T>
          </View>
        </Animated.View>
      </View>

      <Animated.View style={iriaStyle}>
        <IriaCard agentName={agentName} agentAvatarUrl={agentAvatarUrl} />
      </Animated.View>

      <Animated.View style={stepsStyle}>
        <SetupPreview steps={steps} />
      </Animated.View>
    </View>
  )
}
