/**
 * StepHeader — Reusable title + description for onboarding steps.
 */

import React from 'react'
import { Text, YStack } from 'tamagui'
import { useColors } from '../mca/primitives/useColors'

interface StepHeaderProps {
  title: string
  description: string
}

export function StepHeader({ title, description }: StepHeaderProps) {
  const c = useColors()
  return (
    <YStack gap={4}>
      <Text fontSize={17} fontWeight="700" color={c.text}>{title}</Text>
      <Text fontSize={13} color={c.text2} lineHeight={20}>{description}</Text>
    </YStack>
  )
}
