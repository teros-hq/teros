/**
 * GettingStartedWidget — Navbar checklist widget
 *
 * Shows an icon with a numeric badge (pending steps).
 * On click, opens a dropdown with 5 checklist items.
 * Each item links to the relevant window.
 *
 * State is computed in real-time via profile.onboarding-status.
 * The widget disappears silently when all 5 items are complete.
 * The user can also dismiss it manually.
 */

import { CheckCircle, ChevronRight, Circle, Rocket, X } from '@tamagui/lucide-icons'
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'
import { getTerosClient } from '../../services/terosClientSingleton'
import type { OnboardingStatus } from '../../services/ProfileApi'
import { storage, STORAGE_KEYS } from '../../services/storage'
import { useTilingStore } from '../../store/tilingStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { colors as semanticColors } from '../mca/primitives/colors'
import { useColors } from '../mca/primitives/useColors'

interface ChecklistItem {
  id: keyof OnboardingStatus
  label: string
  action: () => void
}

interface GettingStartedWidgetProps {
  /** Called when the user opens a window so the navbar can close mobile menu */
  onOpenWindow?: () => void
}

export function GettingStartedWidget({ onOpenWindow }: GettingStartedWidgetProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const { openWindow } = useTilingStore()
  const { activeWorkspaceId } = useWorkspaceStore()

  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    storage.get<string>(STORAGE_KEYS.GETTING_STARTED).then((val) => {
      if (val === '1') setDismissed(true)
    })
  }, [])

  // ── Load status ─────────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const s = await client.profile.getOnboardingStatus()
      setStatus(s)
    } catch (err) {
      console.warn('[GettingStartedWidget] Failed to load onboarding status:', err)
    }
  }, [client])

  useEffect(() => {
    if (dismissed) return
    if (client.isConnected()) {
      loadStatus()
    } else {
      const onConnected = () => { loadStatus(); client.off('connected', onConnected) }
      client.on('connected', onConnected)
      return () => client.off('connected', onConnected)
    }
  }, [dismissed, loadStatus])

  // Refresh every 30s while open
  useEffect(() => {
    if (!open || dismissed) return
    const id = setInterval(loadStatus, 30_000)
    return () => clearInterval(id)
  }, [open, dismissed, loadStatus])

  // Close dropdown on outside click (web)
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return
    const handler = (e: MouseEvent) => {
      const el = document.getElementById('getting-started-widget')
      if (el && !el.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // ── Actions ──────────────────────────────────────────────────────────────

  const openW = (type: string, props: Record<string, any> = {}) => {
    onOpenWindow?.()
    setOpen(false)
    openWindow(type as any, props)
  }

  const items: ChecklistItem[] = [
    {
      id: 'hasProvider',
      label: t('onboarding.connectAProvider'),
      action: () => openW('providers'),
    },
    {
      id: 'hasOnboardingCompleted',
      label: t('onboarding.customizeYourAgent'),
      action: () => openW('agent', { agentId: undefined }),
    },
    {
      id: 'hasAppWithCredentials',
      label: t('onboarding.configureAppCredentials'),
      action: () => openW('apps', { workspaceId: activeWorkspaceId ?? undefined }),
    },
    {
      id: 'hasAppAssigned',
      label: t('onboarding.grantAgentAccessToApps'),
      action: () => openW('apps', { workspaceId: activeWorkspaceId ?? undefined }),
    },
    {
      id: 'hasFirstMessage',
      label: t('onboarding.sendYourFirstMessage'),
      action: () => openW('chat', { workspaceId: activeWorkspaceId ?? undefined }),
    },
  ]

  // ── Derived state ────────────────────────────────────────────────────────

  const pendingCount = status
    ? items.filter((item) => !status[item.id]).length
    : 0

  // Hide if dismissed or all complete
  if (dismissed) return null
  if (status && pendingCount === 0) return null
  if (!status) return null

  const completedCount = items.filter((i) => status[i.id]).length
  const progressPct = Math.round((completedCount / items.length) * 100)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <YStack
      // @ts-ignore — id prop for web click-outside detection
      id="getting-started-widget"
      position="relative"
    >
      {/* Trigger button */}
      <XStack
        width={36}
        height={36}
        borderRadius="$2"
        backgroundColor={open ? semanticColors.indigoGlow : c.bgCardHover}
        alignItems="center"
        justifyContent="center"
        cursor="pointer"
        pressStyle={{ opacity: 0.7 }}
        animation="quick"
        onPress={() => setOpen((v) => !v)}
        position="relative"
      >
        <Rocket size={18} color={open ? semanticColors.indigo : c.text2} />
        {pendingCount > 0 && (
          <YStack
            position="absolute"
            top={2}
            right={2}
            width={16}
            height={16}
            borderRadius={8}
            backgroundColor={semanticColors.indigo}
            alignItems="center"
            justifyContent="center"
          >
            <Text color={c.bgPage} fontSize={9} fontWeight="700" lineHeight={16}>
              {pendingCount}
            </Text>
          </YStack>
        )}
      </XStack>

      {/* Dropdown */}
      {open && (
        <YStack
          position="absolute"
          // @ts-ignore — web-only positioning
          bottom={Platform.OS === 'web' ? 44 : undefined}
          top={Platform.OS !== 'web' ? 44 : undefined}
          left={0}
          width={280}
          backgroundColor={c.bgPage}
          borderRadius="$3"
          borderWidth={1}
          borderColor={c.border}
          padding="$4"
          zIndex={9999}
          // @ts-ignore — web-only shadow
          style={Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.6)' } : undefined}
          onPress={(e: any) => e?.stopPropagation?.()} // web-only: stopPropagation not typed in RN events
        >
          {/* Header */}
          <XStack alignItems="center" justifyContent="space-between" marginBottom="$3">
            <XStack alignItems="center" gap="$2">
              <Rocket size={14} color={semanticColors.indigo} />
              <Text color={c.text} fontSize="$3" fontWeight="700">
                {t('onboarding.gettingStarted')}
              </Text>
            </XStack>
            <XStack alignItems="center" gap="$2">
              <Text color={c.text3} fontSize={11}>
                {completedCount}/{items.length}
              </Text>
              <XStack
                padding="$1"
                cursor="pointer"
                pressStyle={{ opacity: 0.6 }}
                animation="quick"
                onPress={() => { storage.set(STORAGE_KEYS.GETTING_STARTED, '1'); setDismissed(true); setOpen(false) }}
              >
                <X size={14} color={c.text3} />
              </XStack>
            </XStack>
          </XStack>

          {/* Progress bar */}
          <YStack
            height={3}
            backgroundColor={c.borderStrong}
            borderRadius={2}
            marginBottom="$3"
            overflow="hidden"
          >
            <YStack
              height={3}
              width={`${progressPct}%`}
              backgroundColor={semanticColors.indigo}
              borderRadius={2}
              animation="quick"
            />
          </YStack>

          {/* Checklist items */}
          <YStack gap="$1">
            {items.map((item) => {
              const done = !!status[item.id]
              return (
                <XStack
                  key={item.id}
                  alignItems="center"
                  gap="$2"
                  paddingVertical="$2"
                  paddingHorizontal="$1"
                  borderRadius="$2"
                  cursor={done ? 'default' : 'pointer'}
                  pressStyle={done ? {} : { backgroundColor: c.bgCardHover }}
                  animation="quick"
                  opacity={done ? 0.5 : 1}
                  onPress={done ? undefined : item.action}
                >
                  {done
                    ? <CheckCircle size={16} color={semanticColors.green} />
                    : <Circle size={16} color={c.text3} />
                  }
                  <Text
                    color={done ? c.text2 : c.text}
                    fontSize="$3"
                    textDecorationLine={done ? 'line-through' : 'none'}
                    flex={1}
                  >
                    {item.label}
                  </Text>
                  {!done && <ChevronRight size={13} color={c.text3} />}
                </XStack>
              )
            })}
          </YStack>
        </YStack>
      )}
    </YStack>
  )
}
