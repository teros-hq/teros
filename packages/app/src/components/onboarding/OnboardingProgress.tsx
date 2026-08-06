/**
 * OnboardingProgress — Progress pills header
 *
 * Matches the prototype design: horizontal pills with connectors.
 * Active pill is wider. Done pills use accent with reduced opacity.
 * Always visible at the top of the wizard.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Text, XStack, YStack } from 'tamagui'
import { colors as semanticColors } from '../mca/primitives/colors'
import { useColors } from '../mca/primitives/useColors'

export interface OnboardingStep {
  id: string
  label: string
}

interface OnboardingProgressProps {
  steps: OnboardingStep[]
  currentStep: number // 0-based index
}

export function OnboardingProgress({ steps, currentStep }: OnboardingProgressProps) {
  const { t } = useTranslation()
  const c = useColors()
  const stepNumber = currentStep + 1
  const totalSteps = steps.length
  const currentLabel = steps[currentStep]?.label ?? ''

  return (
    <YStack gap={8} paddingHorizontal={24} paddingTop={20} paddingBottom={0}>
      {/* Pills row */}
      <XStack alignItems="center" gap={6}>
        {steps.map((step, idx) => {
          const isDone = idx < currentStep
          const isActive = idx === currentStep
          return (
            <React.Fragment key={step.id}>
              <YStack
                height={6}
                borderRadius={3}
                width={isActive ? 40 : 28}
                backgroundColor={
                  isDone
                    ? `${semanticColors.indigo}80`
                    : isActive
                      ? semanticColors.indigo
                      : c.borderStrong
                }
              />
              {idx < steps.length - 1 && (
                <YStack
                  width={8}
                  height={1}
                  backgroundColor={c.border}
                />
              )}
            </React.Fragment>
          )
        })}
      </XStack>

      {/* Step label */}
      <Text fontSize={11} color={c.text2} letterSpacing={0.5}>
        {t('onboarding.stepProgress', { stepNumber, totalSteps, label: currentLabel })}
      </Text>
    </YStack>
  )
}
