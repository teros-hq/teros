/**
 * AgentHeader — Avatar + contextual quote, shown below the progress bar.
 *
 * Extracted from OnboardingWizard for clarity.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Image } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'
import { colors as semanticColors } from '../mca/primitives/colors'
import { useColors } from '../mca/primitives/useColors'

// Indexed by `currentStep` — MUST stay aligned with OnboardingWizard's STEP_IDS
// (welcome, agent, apps, access, done). Provider/plan/payment steps were removed.
// Exported so onboardingStepAlignment.render.test.tsx can guard the alignment.
export const STEP_QUOTE_KEYS = [
  'onboarding.quoteWelcome',
  'onboarding.quoteAboutYou',
  'onboarding.quoteApps',
  'onboarding.quoteAccess',
  'onboarding.quoteDone',
]

interface AgentHeaderProps {
  agentName: string
  avatarUrl?: string
  currentStep: number
}

function AgentAvatar({ avatarUrl, name }: { avatarUrl?: string; name: string }) {
  const c = useColors()
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        style={{ width: 36, height: 36, borderRadius: 18 }}
      />
    )
  }
  const initials = name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <YStack
      width={36}
      height={36}
      borderRadius={18}
      backgroundColor={semanticColors.indigoGlow}
      borderWidth={1}
      borderColor={`${semanticColors.indigo}66`}
      justifyContent="center"
      alignItems="center"
    >
      <Text fontSize={13} fontWeight="700" color={semanticColors.indigo}>{initials || '?'}</Text>
    </YStack>
  )
}

export function AgentHeader({ agentName, avatarUrl, currentStep }: AgentHeaderProps) {
  const { t } = useTranslation()
  const c = useColors()
  const quoteKey = STEP_QUOTE_KEYS[currentStep]
  return (
    <XStack
      alignItems="center"
      gap={12}
      paddingHorizontal={24}
      paddingVertical={16}
      borderBottomWidth={1}
      borderBottomColor={c.border}
    >
      <AgentAvatar avatarUrl={avatarUrl} name={agentName} />
      <YStack>
        <Text fontSize={13} fontWeight="600" color={c.text}>{agentName}</Text>
        <Text fontSize={12} color={c.text2} fontStyle="italic">
          {quoteKey ? t(quoteKey) : ''}
        </Text>
      </YStack>
    </XStack>
  )
}
