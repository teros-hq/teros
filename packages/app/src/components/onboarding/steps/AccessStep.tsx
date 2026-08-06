/**
 * AccessStep — Step 3 of the onboarding wizard (skippable → Done)
 *
 * Shows installed apps with ON/OFF toggles.
 * Returns pure content — no ScrollView, no footer.
 * The wizard handles scroll and footer rendering.
 */

import { Check } from '@tamagui/lucide-icons'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'
import { getTerosClient } from '../../../services/terosClientSingleton'
import type { AppData } from '../../../services/AppApi'
import { colors as semanticColors } from '../../mca/primitives/colors'
import { useColors } from '../../mca/primitives/useColors'
import { StepHeader } from '../StepHeader'
import type { StepFooterConfig } from '../StepFooter'

interface AccessStepProps {
  installedAppIds: string[]
  installedApps: AppData[]
  alreadyGrantedAppIds: string[]
  defaultAgentId: string | null
  agentName: string
  agentAvatarUrl?: string
  onComplete: () => void
  onSkip: () => void
  onBack: () => void
  setFooterConfig: (config: StepFooterConfig) => void
  registerContinueHandler: (handler: () => void) => void
}

// ── App icon ───────────────────────────────────────────────────────────────────

function AppIconSmall({ app, color }: { app: AppData; color: string }) {
  const iconUrl = app.icon
  if (iconUrl) {
    return (
      <Image
        source={{ uri: iconUrl }}
        style={{ width: 18, height: 18, objectFit: 'contain' } as any}
      />
    )
  }
  const initials = (app.name ?? '?').slice(0, 2).toUpperCase()
  return (
    <Text fontSize={10} fontWeight="700" color={color}>{initials}</Text>
  )
}

// ── Custom toggle ──────────────────────────────────────────────────────────────

function Toggle({ value, onChange, disabled, c }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; c: ReturnType<typeof useColors> }) {
  return (
    <XStack
      width={44}
      height={24}
      borderRadius={12}
      backgroundColor={value ? `${semanticColors.indigo}99` : c.borderStrong}
      alignItems="center"
      paddingHorizontal={3}
      cursor={disabled ? 'default' : 'pointer'}
      pressStyle={disabled ? {} : { opacity: 0.8 }}
      animation="quick"
      onPress={() => !disabled && onChange(!value)}
    >
      <YStack
        width={18}
        height={18}
        borderRadius={9}
        backgroundColor={value ? semanticColors.indigo : c.text2}
        marginLeft={value ? 20 : 0}
        animation="quick"
      />
    </XStack>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AccessStep({
  installedAppIds,
  installedApps,
  alreadyGrantedAppIds,
  defaultAgentId,
  onComplete,
  onSkip,
  onBack,
  setFooterConfig,
  registerContinueHandler,
}: AccessStepProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()

  const alreadyGrantedSet = new Set(alreadyGrantedAppIds)

  const apps = useMemo(() => {
    const allInstalledIds = new Set(installedAppIds)
    return installedApps.filter((a) => allInstalledIds.has(a.appId))
  }, [installedApps, installedAppIds])

  const [toggles, setToggles] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const app of apps) {
      init[app.appId] = true
    }
    return init
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

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
      skipDisabled: saving,
      continueLabel: saving ? t('onboarding.grantingAccess') : t('onboarding.continueButton'),
      continueDisabled: saving,
    })
  }, [saving, t])

  const handleToggle = (appId: string, value: boolean) => {
    if (alreadyGrantedSet.has(appId)) return
    setToggles((prev) => ({ ...prev, [appId]: value }))
    setErrors((prev) => { const n = { ...prev }; delete n[appId]; return n })
  }

  const handleContinue = useCallback(async () => {
    if (!defaultAgentId) { onComplete(); return }
    setSaving(true)

    const toGrant = apps.filter((a) => toggles[a.appId] && !alreadyGrantedSet.has(a.appId))
    const newErrors: Record<string, string> = {}

    await Promise.all(
      toGrant.map(async (app) => {
        try {
          await client.app.grantAccess(defaultAgentId, app.appId)
        } catch (err: any) {
          newErrors[app.appId] = err?.message || t('onboarding.failedToGrantAccess')
          setToggles((prev) => ({ ...prev, [app.appId]: false }))
        }
      }),
    )

    setSaving(false)
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
    }
    onComplete()
  }, [defaultAgentId, apps, toggles, onComplete, t])

  useEffect(() => {
    handleContinueRef.current = handleContinue
  }, [handleContinue])

  return (
    <YStack gap={20}>
      <StepHeader
        title={t('onboarding.chooseAppAccess')}
        description={t('onboarding.chooseAppAccessDescription')}
      />

      <YStack gap={8}>
        {apps.map((app) => {
          const err = errors[app.appId]
          const isOn = toggles[app.appId] ?? true
          const isAlreadyGranted = alreadyGrantedSet.has(app.appId)

          return (
            <YStack key={app.appId}>
              <XStack
                alignItems="center"
                gap={12}
                padding={12}
                backgroundColor={c.bgInner}
                borderWidth={1}
                borderColor={err ? `${semanticColors.red}4D` : c.border}
                borderRadius={8}
                opacity={isAlreadyGranted ? 0.7 : 1}
              >
                <YStack
                  width={32}
                  height={32}
                  borderRadius={6}
                  backgroundColor={c.bgCardHover}
                  justifyContent="center"
                  alignItems="center"
                  flexShrink={0}
                >
                  <AppIconSmall app={app} color={c.text2} />
                </YStack>
                <YStack flex={1}>
                  <Text fontSize={13} fontWeight="500" color={c.text}>{app.name}</Text>
                  {isAlreadyGranted && (
                    <XStack alignItems="center" gap={4}>
                      <Check size={10} color={semanticColors.green} />
                      <Text fontSize={11} color={c.text3}>{t('onboarding.alreadyHasAccess')}</Text>
                    </XStack>
                  )}
                </YStack>
                <Toggle
                  value={isOn}
                  onChange={(v) => handleToggle(app.appId, v)}
                  disabled={isAlreadyGranted}
                  c={c}
                />
              </XStack>
              {err && (
                <Text fontSize={11} color={semanticColors.red} paddingHorizontal={4} paddingTop={2}>
                  {err}
                </Text>
              )}
            </YStack>
          )
        })}

        {apps.length === 0 && (
          <Text fontSize={13} color={c.text2} textAlign="center" paddingTop={16}>
            {t('onboarding.noAppsToConfig')}
          </Text>
        )}

        {/* Info note */}
        <XStack
          marginTop={8}
          padding={12}
          backgroundColor={semanticColors.indigoGlow}
          borderWidth={1}
          borderColor={`${semanticColors.indigo}26`}
          borderRadius={8}
        >
          <Text fontSize={12} color={c.text2} flex={1} lineHeight={18}>
            {t('onboarding.changePermissionsAnytime')}
          </Text>
        </XStack>
      </YStack>
    </YStack>
  )
}
