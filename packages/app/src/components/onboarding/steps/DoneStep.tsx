/**
 * DoneStep — Step 4 of the onboarding wizard (final)
 *
 * - Persists onboardingCompletedAt via profile.complete-onboarding (with retry).
 * - Shows summary of what was set up.
 * - Footer handled by wizard (special CTA: "Start chatting →").
 *
 * Returns pure content — no footer, no spacers.
 */

import { Check } from '@tamagui/lucide-icons'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'
import { getTerosClient } from '../../../services/terosClientSingleton'
import { useAuthStore } from '../../../store/authStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useTilingStore } from '../../../store/tilingStore'
import { colors as semanticColors } from '../../mca/primitives/colors'
import { useColors } from '../../mca/primitives/useColors'
import type { StepFooterConfig } from '../StepFooter'

interface DoneStepProps {
  userName?: string
  agentName: string
  agentAvatarUrl?: string
  defaultAgentId: string | null
  summaryItems: string[]
  onFinish: () => void
  setFooterConfig: (config: StepFooterConfig) => void
}

export function DoneStep({ userName, agentName, agentAvatarUrl, defaultAgentId, summaryItems, onFinish, setFooterConfig }: DoneStepProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const { completeOnboarding } = useAuthStore()
  const { openWindow } = useTilingStore()
  const { setActiveWorkspace } = useWorkspaceStore()
  const [completed, setCompleted] = useState(false)

  // Complete onboarding on mount — with retry
  useEffect(() => {
    let cancelled = false
    const complete = async () => {
      try {
        await client.send('profile', 'complete-onboarding', {})
        completeOnboarding()
        if (!cancelled) setCompleted(true)
      } catch (err) {
        console.error('[DoneStep] complete-onboarding failed, retrying:', err)
        try {
          await client.send('profile', 'complete-onboarding', {})
          completeOnboarding()
          if (!cancelled) setCompleted(true)
        } catch (retryErr) {
          console.error('[DoneStep] Retry also failed:', retryErr)
          completeOnboarding() // mark locally anyway
          if (!cancelled) setCompleted(true)
        }
      }
    }
    complete()
    return () => { cancelled = true }
  }, [])

  const handleStartChatting = async () => {
    if (!completed) {
      completeOnboarding() // safety net
    }
    try {
      const { workspaces } = await client.workspace.listWorkspaces()
      const privateWs = workspaces.find((ws: any) => ws.type === 'private')
      if (privateWs) {
        setActiveWorkspace(privateWs.workspaceId)
      }
    } catch (err) {
      console.warn('[DoneStep] Failed to preselect private workspace:', err)
    }
    if (defaultAgentId) {
      openWindow('chat', { agentId: defaultAgentId, agentName })
    }
    onFinish()
  }

  // Communicate footer config to wizard — special CTA
  useEffect(() => {
    setFooterConfig({
      specialCta: {
        label: t('onboarding.startChatting'),
        onPress: handleStartChatting,
      },
    })
  }, [completed, defaultAgentId, t])

  const firstName = userName?.split(' ')[0]?.trim() || 'there'

  return (
    <YStack alignItems="center" gap={24} paddingTop={8} paddingBottom={8}>
      {/* Large avatar */}
      {agentAvatarUrl ? (
        <Image
          source={{ uri: agentAvatarUrl }}
          style={{ width: 72, height: 72, borderRadius: 36 }}
        />
      ) : (
        <YStack
          width={72}
          height={72}
          borderRadius={36}
          backgroundColor={semanticColors.indigoGlow}
          borderWidth={2}
          borderColor={`${semanticColors.indigo}4D`}
          justifyContent="center"
          alignItems="center"
        >
          <Text fontSize={24} fontWeight="700" color={semanticColors.indigo}>
            {agentName.slice(0, 2).toUpperCase()}
          </Text>
        </YStack>
      )}

      {/* Star accent + title */}
      <YStack alignItems="center" gap={8}>
        <Text fontSize={32} color={semanticColors.indigo} fontWeight="700">✦</Text>
        <Text fontSize={22} fontWeight="700" color={c.text} textAlign="center">
          {t('onboarding.allSetTitle', { firstName })}
        </Text>
        <Text fontSize={14} color={c.text2} textAlign="center">
          {t('onboarding.hereIsWhatWeSetUp')}
        </Text>
      </YStack>

      {/* Summary */}
      {summaryItems.length > 0 && (
        <YStack gap={8} width="100%">
          {summaryItems.map((item) => (
            <XStack
              key={item}
              alignItems="center"
              gap={10}
              padding={12}
              backgroundColor={c.bgInner}
              borderWidth={1}
              borderColor={c.border}
              borderRadius={8}
            >
              <YStack
                width={20}
                height={20}
                borderRadius={10}
                backgroundColor={`${semanticColors.green}1F`}
                borderWidth={1}
                borderColor={`${semanticColors.green}4D`}
                justifyContent="center"
                alignItems="center"
                flexShrink={0}
              >
                <Check size={10} color={semanticColors.green} />
              </YStack>
              <Text fontSize={13} color={c.text}>{item}</Text>
            </XStack>
          ))}
        </YStack>
      )}

      <Text fontSize={12} color={c.text2} textAlign="center">
        {t('onboarding.addMoreAnytime')}
      </Text>
    </YStack>
  )
}
