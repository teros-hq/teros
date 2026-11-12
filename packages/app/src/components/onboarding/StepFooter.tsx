/**
 * StepFooter — Reusable footer with Back / Skip / Continue pills.
 *
 * Rendered by OnboardingWizard OUTSIDE the ScrollView, fixed at the bottom.
 * Steps communicate footer state via setFooterConfig callback.
 *
 * Visual (`.stepper__nav`): ghost "Back" on the left, ghost "Skip", and the
 * violet primary pill (44px) stretching to the right.
 */

import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { Btn } from "../ui/ds"

export interface StepFooterConfig {
  continueLabel?: string
  continueDisabled?: boolean
  showBack?: boolean
  showSkip?: boolean
  skipDisabled?: boolean
  /** When set, renders a single large CTA button instead of the standard layout */
  specialCta?: {
    label: string
    onPress: () => void
  }
}

interface StepFooterProps {
  config: StepFooterConfig
  onBack?: () => void
  onSkip?: () => void
  onContinue: () => void
}

export function StepFooter({ config, onBack, onSkip, onContinue }: StepFooterProps) {
  const { t } = useTranslation()
  const {
    continueLabel = t("onboarding.continueButton"),
    continueDisabled = false,
    showBack = false,
    showSkip = false,
    skipDisabled = false,
    specialCta,
  } = config

  // Special CTA mode (used by DoneStep) — THE CTA, unconditional.
  if (specialCta) {
    return (
      <Btn
        testID="step-footer-cta"
        variant="primary"
        size="lg"
        full
        iconRight="arrow-right"
        onPress={specialCta.onPress}
      >
        {specialCta.label}
      </Btn>
    )
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {showBack && onBack && (
        <Btn testID="step-footer-back" variant="ghost" size="md" icon="caret-left" onPress={onBack}>
          {t("onboarding.backButton").replace(/^←\s*/, "")}
        </Btn>
      )}
      {showSkip && onSkip && (
        <Btn
          testID="step-footer-skip"
          variant="ghost"
          size="md"
          onPress={onSkip}
          disabled={skipDisabled}
        >
          {t("onboarding.skipButton")}
        </Btn>
      )}
      <View style={{ flex: 1 }} />
      <Btn
        testID="step-footer-continue"
        variant="primary"
        size="lg"
        iconRight="arrow-right"
        disabled={continueDisabled}
        onPress={onContinue}
        style={{ minWidth: 160 }}
      >
        {continueLabel.replace(/\s*→$/, "")}
      </Btn>
    </View>
  )
}
