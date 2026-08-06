/**
 * ImpersonationBanner
 *
 * Thin dark admin toolbar shown whenever an admin is impersonating another user.
 * Left: identity indicator. Center: reserved for future admin tools. Right: back button.
 */

import { LogOut } from '@tamagui/lucide-icons'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from 'tamagui'
import { getTerosClient } from '../services/terosClientSingleton'
import { useAuthStore } from '../store/authStore'
import { useNavbarStore } from '../store/navbarStore'
import { useTilingStore } from '../store/tilingStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useColors } from './mca/primitives/useColors'
import { colors as semanticColors } from './mca/primitives/colors'
import { AppSpinner } from './ui/AppSpinner'

export function ImpersonationBanner() {
  const { t } = useTranslation()
  const c = useColors()
  const impersonation = useAuthStore((s: any) => s.impersonation)
  const user = useAuthStore((s: any) => s.user)
  const stopImpersonation = useAuthStore((s: any) => s.stopImpersonation)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!impersonation?.isImpersonating) return null

  const handleStop = async () => {
    if (loading) return
    setLoading(true)
    setError(null)
    const client = getTerosClient()
    try {
      const { restoredToken } = await client.admin.stopImpersonation()

      stopImpersonation()

      // Reset all cached UI state so admin starts fresh
      useNavbarStore.getState().reset()
      useWorkspaceStore.getState().clearActiveWorkspace()
      useTilingStore.getState().resetState()

      client.setSessionToken(restoredToken)
      const serverUrl = process.env.EXPO_PUBLIC_WS_URL
      if (!serverUrl) throw new Error('EXPO_PUBLIC_WS_URL is not defined')
      client.connect(serverUrl)
    } catch (err: any) {
      console.error('[ImpersonationBanner] Failed to stop impersonation:', err)
      setError(err?.message || 'Error')
      setLoading(false)
    }
  }

  const displayName = user?.name || user?.email || 'Unknown'

  return (
    <View style={[styles.bar, { backgroundColor: c.bgPage, borderBottomColor: c.border }]}>
      {/* Left — identity */}
      <View style={styles.left}>
        <View style={[styles.dot, { backgroundColor: semanticColors.amber }]} />
        <Text style={[styles.label, { color: c.text3 }]}>
          {t("impersonation.impersonating")}{' '}
          <Text style={[styles.labelBold, { color: c.text2 }]}>{displayName}</Text>
        </Text>
        {error && <Text style={[styles.errorText, { color: semanticColors.red }]}> · {error}</Text>}
      </View>

      {/* Center — reserved for future admin tools */}
      <View style={styles.center} />

      {/* Right — back button */}
      <Pressable
        style={({ pressed }) => [
          styles.backBtn,
          { borderColor: c.border },
          pressed && { backgroundColor: c.bgCardHover },
        ]}
        onPress={handleStop}
        disabled={loading}
      >
        {loading ? (
          <AppSpinner size="sm" variant="muted" />
        ) : (
          <>
            <LogOut size={11} color={c.text3} />
            <Text style={[styles.backBtnText, { color: c.text3 }]}>
              {t("impersonation.backToMySession")}
            </Text>
          </>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    height: 28,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    zIndex: 1000,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 0,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  label: {
    fontSize: 11,
    fontWeight: '400',
  },
  labelBold: {
    fontSize: 11,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 11,
  },
  center: {
    flex: 1,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 5,
    borderWidth: 1,
    flexShrink: 0,
  },
  backBtnText: {
    fontSize: 11,
    fontWeight: '500',
  },
})
