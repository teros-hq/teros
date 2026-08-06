/**
 * StepFooter — Reusable footer with Back / Skip / Continue buttons.
 *
 * Rendered by OnboardingWizard OUTSIDE the ScrollView, fixed at the bottom.
 * Steps communicate footer state via setFooterConfig callback.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Text, XStack } from 'tamagui'
import { colors as semanticColors } from '../mca/primitives/colors'
import { useColors } from '../mca/primitives/useColors'

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

export function StepFooter({
  config,
  onBack,
  onSkip,
  onContinue,
}: StepFooterProps) {
  const { t } = useTranslation()
  const c = useColors()
  const {
    continueLabel = t('onboarding.continueButton'),
    continueDisabled = false,
    showBack = false,
    showSkip = false,
    skipDisabled = false,
    specialCta,
  } = config

  // Special CTA mode (used by DoneStep)
  if (specialCta) {
    return (
      <Button
        testID="step-footer-cta"
        width="100%"
        size="$5"
        height={52}
        onPress={specialCta.onPress}
        backgroundColor={semanticColors.indigo}
        borderColor={semanticColors.indigo}
        borderWidth={1}
      >
        <Text color={c.bgPage} fontSize={15} fontWeight="700">
          {specialCta.label}
        </Text>
      </Button>
    )
  }

  return (
    <XStack gap={10} alignItems="center">
      {showBack && onBack && (
        <Button
          testID="step-footer-back"
          size="$4"
          backgroundColor="transparent"
          borderWidth={1}
          borderColor={c.borderStrong}
          onPress={onBack}
        >
          <Text color={c.text2} fontSize={13} fontWeight="600">{t('onboarding.backButton')}</Text>
        </Button>
      )}
      {showSkip && onSkip && (
        <Button
          testID="step-footer-skip"
          size="$4"
          backgroundColor="transparent"
          onPress={onSkip}
          disabled={skipDisabled}
        >
          <Text color={c.text2} fontSize={12}>{t('onboarding.skipButton')}</Text>
        </Button>
      )}
      <Button
        testID="step-footer-continue"
        flex={1}
        size="$4"
        disabled={continueDisabled}
        onPress={onContinue}
        backgroundColor={continueDisabled ? c.bgInner : semanticColors.indigo}
        borderColor={continueDisabled ? c.border : semanticColors.indigo}
        borderWidth={1}
      >
        <Text
          color={continueDisabled ? c.text3 : c.bgPage}
          fontSize={13}
          fontWeight="600"
        >
          {continueLabel}
        </Text>
      </Button>
    </XStack>
  )
}
