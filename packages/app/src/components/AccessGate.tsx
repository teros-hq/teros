/**
 * AccessGate - Blocks access to the app until user has accessGranted: true.
 * Users without access see a clean private beta / waitlist screen.
 * Terms acceptance (welcome.tsx) is only shown after access is granted.
 *
 * On mount (when access is not granted), fetches the latest profile from the
 * backend so a reload is enough to pick up access without re-logging in.
 *
 * Look: the OS prototype's "Beta privada" card — a white card (radius 24) on
 * the sheet with a violet "PRIVATE BETA" badge, serif headline, a
 * three-step list and pill buttons.
 */

import type React from "react"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import type { TerosClient } from "../services/TerosClient"
import { useAuthStore } from "../store/authStore"
import { TerosLogo } from "./TerosLogo"
import { AppSpinner } from "./ui/AppSpinner"
import { useColors } from "./mca/primitives/useColors"
import { Badge, Btn, Ph, T } from "./ui/ds"

interface AccessGateProps {
  client: TerosClient | null
  children: React.ReactNode
}

export const AccessGate: React.FC<AccessGateProps> = ({ client, children }) => {
  const { user, isHydrated, logout, updateProfile } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  // When access is not yet granted, refresh profile from backend on mount.
  // This way a simple page reload is enough after a founder grants access —
  // no need to log out and log back in.
  useEffect(() => {
    if (!isHydrated || user?.accessGranted || !client) return

    client.profile
      .getProfile()
      .then((profile) => {
        updateProfile({
          accessGranted: profile.accessGranted,
          termsAcceptedAt: profile.termsAcceptedAt,
          ...(profile.edition ? { edition: profile.edition } : {}),
        })
      })
      .catch((err) => {
        console.warn("[AccessGate] Failed to refresh profile:", err)
      })
  }, [isHydrated, client])

  const handleLogout = async () => {
    try {
      await logout()
      client?.disconnect()
      if (typeof window !== "undefined") {
        window.location.href = "/login"
      }
    } catch (error) {
      console.error("Error logging out:", error)
    }
  }

  // Wait for auth store to hydrate
  if (!isHydrated) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: c.bgSheet,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AppSpinner size="lg" variant="brand" />
      </View>
    )
  }

  if (user?.accessGranted) {
    return <>{children}</>
  }

  const bullets = [
    { icon: "envelope", text: t("accessGate.emailWhenIn") },
    { icon: "user-focus", text: t("accessGate.reviewPersonally") },
    { icon: "clock", text: t("accessGate.noActionNeeded") },
  ]

  // User is on the waitlist — show private beta screen
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bgSheet,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <View
        style={[
          {
            width: "100%",
            maxWidth: 480,
            borderRadius: 24,
            backgroundColor: c.bgStep,
            padding: 32,
            gap: 20,
          },
          Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : null,
        ]}
      >
        {/* Brand */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <TerosLogo size={28} animated={true} />
          <T step="xl">Teros</T>
        </View>

        <View style={{ gap: 12 }}>
          <Badge tone="i" pill cap icon="hourglass">
            {t("accessGate.privateBeta")}
          </Badge>
          <T step="3xl">
            {t("accessGate.waitlistTitle", { defaultValue: "Estás en la lista de espera" })}
          </T>
          <T step="base" tone="text2">
            {t("accessGate.description")}
          </T>
        </View>

        <View style={{ gap: 4 }}>
          <T step="xs" tone="text3" style={{ marginBottom: 8 }}>
            {t("accessGate.whatNow", { defaultValue: "Qué pasa ahora" })}
          </T>
          {bullets.map((b) => (
            <View
              key={b.text}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingVertical: 4,
              }}
            >
              <Ph name={b.icon} size={16} color={c.text3} style={{ marginTop: 3 }} />
              <T step="sm" tone="text2" style={{ flex: 1 }}>
                {b.text}
              </T>
            </View>
          ))}
        </View>

        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          <Btn variant="sec" icon="sign-out" onPress={handleLogout}>
            {t("accessGate.signOut")}
          </Btn>
        </View>
      </View>
    </View>
  )
}
