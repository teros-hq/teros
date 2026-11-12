/**
 * ImpersonationBanner
 *
 * Amber full-width strip shown whenever an admin is impersonating another
 * user. Left: identity indicator. Center: reserved for future admin tools.
 * Right: exit button.
 */

import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { StyleSheet, View } from "react-native"
import { getTerosClient } from "../services/terosClientSingleton"
import { useAuthStore } from "../store/authStore"
import { useNavbarStore } from "../store/navbarStore"
import { useTilingStore } from "../store/tilingStore"
import { useWorkspaceStore } from "../store/workspaceStore"
import { installSessionCookie } from "../services/sessionCookie"
import { useColors } from "./mca/primitives/useColors"
import { Btn, Ph, T } from "./ui/ds"
import { wsUrl } from "../config/runtime"

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

      // The httpOnly cookie still holds the impersonation token: re-point it
      // to the admin's restored token or a reload would resume impersonating.
      installSessionCookie(restoredToken)

      client.setSessionToken(restoredToken)
      const serverUrl = wsUrl()
      if (!serverUrl) throw new Error("WebSocket URL is not configured")
      client.connect(serverUrl)
    } catch (err: any) {
      console.error("[ImpersonationBanner] Failed to stop impersonation:", err)
      setError(err?.message || "Error")
      setLoading(false)
    }
  }

  const displayName = user?.name || user?.email || "Unknown"

  return (
    <View style={[styles.bar, { backgroundColor: c.tint.a.bg, borderBottomColor: c.tint.a.bd }]}>
      {/* Left — identity */}
      <View style={styles.left}>
        <Ph name="user-switch" size={14} color={c.tint.a.tx} />
        <T step="codenote" color={c.tint.a.tx} numberOfLines={1} style={{ flexShrink: 1 }}>
          {t("impersonation.impersonating")} {displayName}
        </T>
        {error && (
          <T step="12" tone="danger" numberOfLines={1} style={{ flexShrink: 1 }}>
            {" · "}
            {error}
          </T>
        )}
      </View>

      {/* Center — reserved for future admin tools */}
      <View style={styles.center} />

      {/* Right — exit button */}
      <Btn
        size="sm"
        variant="amber"
        icon="sign-out"
        loading={loading}
        onPress={handleStop}
        accessibilityLabel={t("impersonation.backToMySession")}
        {...({ title: t("impersonation.backToMySession") } as any)}
      >
        {t("impersonation.exit", { defaultValue: "Salir" })}
      </Btn>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    height: 32,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 10,
    zIndex: 1000,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  center: {
    flex: 1,
  },
})
