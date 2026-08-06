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
import { Animated, Easing, Image } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import { TerosLogo } from "../../TerosLogo"
import { colors as semanticColors } from "../../mca/primitives/colors"
import { useColors } from "../../mca/primitives/useColors"
import type { StepFooterConfig } from "../StepFooter"

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

const SETUP_STEP_KEYS = [
  { n: "1", labelKey: "onboarding.setupStep1Label", subKey: "onboarding.setupStep1Sub" },
  { n: "2", labelKey: "onboarding.setupStep2Label", subKey: "onboarding.setupStep2Sub" },
  { n: "3", labelKey: "onboarding.setupStep3Label", subKey: "onboarding.setupStep3Sub" },
]

function SetupPreview() {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <YStack gap={8}>
      <Text
        fontSize={11}
        fontWeight="600"
        color={c.text2}
        textTransform="uppercase"
        letterSpacing={1}
      >
        {t('onboarding.whatWeWillSetUp')}
      </Text>
      {SETUP_STEP_KEYS.map((s) => (
        <XStack
          key={s.n}
          gap={12}
          alignItems="center"
          padding={12}
          backgroundColor={c.bgInner}
          borderWidth={1}
          borderColor={c.border}
          borderRadius={8}
        >
          <YStack
            width={26}
            height={26}
            borderRadius={13}
            backgroundColor={semanticColors.indigoGlow}
            borderWidth={1}
            borderColor={`${semanticColors.indigo}33`}
            justifyContent="center"
            alignItems="center"
            flexShrink={0}
          >
            <Text fontSize={11} fontWeight="700" color={semanticColors.indigo}>
              {s.n}
            </Text>
          </YStack>
          <YStack flex={1}>
            <Text fontSize={13} fontWeight="600" color={c.text}>
              {t(s.labelKey)}
            </Text>
            <Text fontSize={11} color={c.text2}>
              {t(s.subKey)}
            </Text>
          </YStack>
        </XStack>
      ))}
    </YStack>
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
    <YStack
      padding={18}
      backgroundColor={semanticColors.indigoGlow}
      borderWidth={1}
      borderColor={`${semanticColors.indigo}33`}
      borderRadius={14}
      gap={12}
    >
      <XStack gap={14} alignItems="center">
        {agentAvatarUrl ? (
          <Image
            source={{ uri: agentAvatarUrl }}
            style={{ width: 52, height: 52, borderRadius: 26 }}
          />
        ) : (
          <YStack
            width={52}
            height={52}
            borderRadius={26}
            backgroundColor={semanticColors.indigoGlow}
            borderWidth={1.5}
            borderColor={`${semanticColors.indigo}66`}
            justifyContent="center"
            alignItems="center"
          >
            <Text fontSize={18} fontWeight="700" color={semanticColors.indigo}>
              {initials || "AI"}
            </Text>
          </YStack>
        )}
        <YStack flex={1} gap={2}>
          <XStack alignItems="center" gap={6}>
            <Text fontSize={15} fontWeight="700" color={c.text}>
              {agentName}
            </Text>
            <YStack
              paddingHorizontal={7}
              paddingVertical={2}
              borderRadius={4}
              backgroundColor={semanticColors.indigoGlow}
              borderWidth={1}
              borderColor={`${semanticColors.indigo}40`}
            >
              <Text fontSize={10} fontWeight="600" color={semanticColors.indigo} letterSpacing={0.5}>
                {t('onboarding.yourAgent')}
              </Text>
            </YStack>
          </XStack>
          <Text fontSize={12} color={c.text2}>
            {t('onboarding.agentReadyToHelp')}
          </Text>
        </YStack>
      </XStack>

      <Text fontSize={13} color={c.text2} lineHeight={20}>
        {t('onboarding.agentIntro', { agentName })}
      </Text>
    </YStack>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface WelcomeStepProps {
  agentName: string
  agentAvatarUrl?: string
  animateIn: boolean
  setFooterConfig: (config: StepFooterConfig) => void
  registerContinueHandler: (handler: () => void) => void
  onComplete: () => void
}

export function WelcomeStep({
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
      continueLabel: t('onboarding.letsGetStarted'),
      continueDisabled: false,
    })
    registerContinueHandler(onComplete)
  }, [setFooterConfig, registerContinueHandler, onComplete, t])

  return (
    <YStack gap={28} paddingBottom={8}>
      <YStack alignItems="center" gap={16} paddingTop={12}>
        <Animated.View style={logoStyle}>
          <TerosLogo size={80} color={semanticColors.indigo} animated />
        </Animated.View>

        <Animated.View style={titleStyle}>
          <YStack alignItems="center" gap={6}>
            <Text
              fontSize={22}
              fontWeight="800"
              color={c.text}
              textAlign="center"
              letterSpacing={-0.5}
            >
              {t('onboarding.welcomeTitle')}
            </Text>
            <Text fontSize={14} color={c.text2} textAlign="center" lineHeight={22}>
              {t('onboarding.welcomeSubtitle')}
            </Text>
          </YStack>
        </Animated.View>
      </YStack>

      <Animated.View style={iriaStyle}>
        <IriaCard agentName={agentName} agentAvatarUrl={agentAvatarUrl} />
      </Animated.View>

      <Animated.View style={stepsStyle}>
        <SetupPreview />
      </Animated.View>
    </YStack>
  )
}
