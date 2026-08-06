/**
 * AppsStep — Step 2 of the onboarding wizard (skippable → Done)
 *
 * 2x2 grid of featured apps. Click an app card to install it immediately.
 * Returns pure content — no ScrollView, no footer.
 * The wizard handles scroll and footer rendering.
 */

import { Brain, Check, Clock, Cpu, Folder, Globe, Terminal } from '@tamagui/lucide-icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'
import { getTerosClient } from '../../../services/terosClientSingleton'
import type { AppData } from '../../../services/AppApi'
import { colors as semanticColors } from '../../mca/primitives/colors'
import { useColors } from '../../mca/primitives/useColors'
import { TerosLoading } from '../../TerosLoading'
import { StepHeader } from '../StepHeader'
import type { StepFooterConfig } from '../StepFooter'

// ── Featured apps catalogue ────────────────────────────────────────────────────

interface FeaturedApp {
  mcaId: string
  name: string
  description: string
  iconUrl: string | null
  FallbackIcon: React.ComponentType<{ size?: number; color?: string }>
}

const FEATURED_APPS: FeaturedApp[] = [
  {
    mcaId: 'mca.teros.webfetch',
    name: 'Web Fetch',
    description: 'Browse the web and read any page',
    iconUrl: null,
    FallbackIcon: Globe,
  },
  {
    mcaId: 'mca.teros.bash',
    name: 'Bash',
    description: 'Agents can run shell commands directly from your conversations',
    iconUrl: null,
    FallbackIcon: Terminal,
  },
  {
    mcaId: 'mca.teros.filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage files on your virtual workspaces',
    iconUrl: null,
    FallbackIcon: Folder,
  },
  {
    mcaId: 'mca.google.gmail',
    name: 'Gmail',
    description: 'Read and send emails on your behalf',
    iconUrl: 'https://cdn.simpleicons.org/gmail/EA4335',
    FallbackIcon: Globe,
  },
  {
    mcaId: "mca.notion",
    name: "Notion",
    description: "Read and update your Notion pages and databases",
    iconUrl: "https://cdn.simpleicons.org/notion/FFFFFF",
    FallbackIcon: Brain,
  },
  {
    mcaId: 'mca.github',
    name: 'GitHub',
    description: 'Read and modify repos, issues, and pull requests',
    iconUrl: 'https://cdn.simpleicons.org/github/181717',
    FallbackIcon: Cpu,
  },
]

// ── App icon ───────────────────────────────────────────────────────────────────

function AppIcon({ app, installedIconUrl, fallbackColor }: { app: FeaturedApp; installedIconUrl?: string; fallbackColor: string }) {
  const url = installedIconUrl || app.iconUrl
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: 20, height: 20, objectFit: 'contain' } as any}
      />
    )
  }
  return <app.FallbackIcon size={20} color={fallbackColor} />
}

// ── Types ──────────────────────────────────────────────────────────────────────

type AppInstallState = 'idle' | 'installing' | 'done' | 'error'

interface AppsStepProps {
  installedApps: AppData[]
  catalogMcaIds: Set<string>
  agentName: string
  agentAvatarUrl?: string
  onComplete: (installedAppIds: string[]) => void
  onSkip: () => void
  onBack: () => void
  setFooterConfig: (config: StepFooterConfig) => void
  registerContinueHandler: (handler: () => void) => void
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AppsStep({ installedApps, catalogMcaIds, onComplete, onSkip, onBack, setFooterConfig, registerContinueHandler }: AppsStepProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()

  const preInstalled: Record<string, { appId: string; iconUrl?: string }> = {}
  const initialStates: Record<string, AppInstallState> = {}
  const installedAppIdsList: string[] = []
  for (const app of installedApps) {
    preInstalled[app.mcaId] = { appId: app.appId, iconUrl: (app as any).iconUrl }
    initialStates[app.mcaId] = 'done'
    installedAppIdsList.push(app.appId)
  }

  const [appStates, setAppStates] = useState<Record<string, AppInstallState>>(initialStates)
  const [appErrors, setAppErrors] = useState<Record<string, string>>({})
  const [newAppIds, setNewAppIds] = useState<string[]>([])

  const availableMcaIds = catalogMcaIds.size > 0 ? catalogMcaIds : null
  const visibleApps = availableMcaIds
    ? FEATURED_APPS.filter((a) => availableMcaIds.has(a.mcaId))
    : FEATURED_APPS

  const anyInstalling = Object.values(appStates).some((s) => s === 'installing')

  // Register continue handler ref pattern
  const handleContinueRef = useRef<() => void>(() => {})
  useEffect(() => {
    registerContinueHandler(() => handleContinueRef.current())
  }, [])

  // Communicate footer config to wizard
  useEffect(() => {
    setFooterConfig({
      showBack: true,
      showSkip: true,
      skipDisabled: anyInstalling,
      continueLabel: anyInstalling ? t('onboarding.installing') : t('onboarding.continueButton'),
      continueDisabled: anyInstalling,
    })
  }, [anyInstalling, t])

  const handleInstallApp = async (mcaId: string) => {
    const state = appStates[mcaId]
    if (state === 'done' || state === 'installing') return

    setAppStates((prev) => ({ ...prev, [mcaId]: 'installing' }))
    setAppErrors((prev) => { const n = { ...prev }; delete n[mcaId]; return n })

    try {
      const { app } = await client.app.installApp(mcaId)
      setNewAppIds((prev) => [...prev, app.appId])
      setAppStates((prev) => ({ ...prev, [mcaId]: 'done' }))
    } catch (err: any) {
      setAppStates((prev) => ({ ...prev, [mcaId]: 'error' }))
      setAppErrors((prev) => ({ ...prev, [mcaId]: err?.message || t('onboarding.installFailed') }))
    }
  }

  const handleContinue = useCallback(() => {
    const allIds = [...installedAppIdsList, ...newAppIds]
    onComplete(allIds)
  }, [newAppIds, onComplete])

  useEffect(() => {
    handleContinueRef.current = handleContinue
  }, [handleContinue])

  return (
    <YStack gap={20}>
      <StepHeader
        title={t('onboarding.appsStep.title')}
        description={t('onboarding.installAppsDescription')}
      />

      {/* App grid — 2 columns */}
      <XStack flexWrap="wrap" gap={8}>
        {visibleApps.map((app) => {
          const state = appStates[app.mcaId] ?? 'idle'
          const err = appErrors[app.mcaId]
          const isDone = state === 'done'
          const isInstalling = state === 'installing'
          const isError = state === 'error'
          const preInfo = preInstalled[app.mcaId]

          return (
            <YStack
              key={app.mcaId}
              width="47%"
              alignItems="center"
              gap={8}
              padding={16}
              borderRadius={8}
              borderWidth={1}
              borderColor={
                isDone
                  ? `${semanticColors.indigo}59`
                  : isError
                    ? `${semanticColors.red}59`
                    : c.borderStrong
              }
              backgroundColor={
                isDone
                  ? semanticColors.indigoGlow
                  : isError
                    ? `${semanticColors.red}0F`
                    : c.bgInner
              }
              cursor={isDone ? 'default' : isInstalling ? 'wait' : 'pointer'}
              pressStyle={isDone || isInstalling ? {} : { borderColor: c.borderStrong, backgroundColor: c.bgCardHover }}
              animation="quick"
              onPress={() => !isDone && !isInstalling && handleInstallApp(app.mcaId)}
              position="relative"
            >
              {isDone && (
                <YStack
                  position="absolute"
                  top={6}
                  right={6}
                  width={16}
                  height={16}
                  borderRadius={8}
                  backgroundColor={semanticColors.indigo}
                  justifyContent="center"
                  alignItems="center"
                >
                  <Check size={9} color={c.bgPage} />
                </YStack>
              )}

              <YStack
                width={36}
                height={36}
                borderRadius={8}
                backgroundColor={c.bgCardHover}
                justifyContent="center"
                alignItems="center"
              >
                <AppIcon app={app} installedIconUrl={preInfo?.iconUrl} fallbackColor={c.text2} />
              </YStack>

              <Text fontSize={12} fontWeight="500" color={c.text} textAlign="center">
                {app.name}
              </Text>

              <Text fontSize={11} color={c.text2} textAlign="center">
                {app.description}
              </Text>

              {isInstalling && (
                <XStack alignItems="center" gap={4}>
                  <TerosLoading size={14} color={semanticColors.indigo} />
                  <Text fontSize={11} color={semanticColors.indigo}>{t('onboarding.installing')}</Text>
                </XStack>
              )}
              {isDone && <Text fontSize={11} color={semanticColors.indigo}>{t('onboarding.installed')}</Text>}
              {!isDone && !isInstalling && !isError && (
                <Text fontSize={11} color={c.text2}>{t('onboarding.addApp')}</Text>
              )}
              {isError && (
                <Text fontSize={10} color={semanticColors.red} textAlign="center" numberOfLines={2}>
                  {err || t('common.error')}
                </Text>
              )}
            </YStack>
          )
        })}
      </XStack>
    </YStack>
  )
}
