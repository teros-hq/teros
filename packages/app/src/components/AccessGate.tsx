/**
 * AccessGate - Blocks access to the app until user has accessGranted: true.
 * Users without access see a clean private beta / waitlist screen.
 * Terms acceptance (welcome.tsx) is only shown after access is granted.
 *
 * On mount (when access is not granted), fetches the latest profile from the
 * backend so a reload is enough to pick up access without re-logging in.
 */

import { LogOut } from "@tamagui/lucide-icons"
import { LinearGradient } from "expo-linear-gradient"
import type React from "react"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"
import type { TerosClient } from "../services/TerosClient"
import { useAuthStore } from "../store/authStore"
import { TerosLogo } from "./TerosLogo"
import { AppSpinner } from "./ui/AppSpinner"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors, controlsBar, indicators } from "./mca/primitives/colors"

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
      <YStack flex={1} backgroundColor={c.bgPage} alignItems="center" justifyContent="center">
        <AppSpinner size="lg" variant="brand" />
      </YStack>
    )
  }

  if (user?.accessGranted) {
    return <>{children}</>
  }

  // User is on the waitlist — show private beta screen
  return (
    <LinearGradient
      colors={[c.bgPage, c.bgCard, c.bgPage]}
      locations={[0, 0.5, 1]}
      style={{ flex: 1 }}
    >
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        paddingHorizontal="$6"
        maxWidth={420}
        width="100%"
        alignSelf="center"
        gap="$8"
      >
        {/* Logo */}
        <YStack alignItems="center" gap="$4">
          <TerosLogo size={64} animated={true} />
          <Text fontSize={28} fontWeight="200" color={c.text} letterSpacing={7}>
            TEROS
          </Text>
        </YStack>

        {/* Card */}
        <YStack
          backgroundColor={semanticColors.indigoGlow}
          borderWidth={1}
          borderColor={c.badges.info.border}
          borderRadius="$4"
          padding="$6"
          gap="$4"
          width="100%"
        >
          <YStack gap="$2">
            <Text fontSize={18} fontWeight="600" color={c.text} letterSpacing={0.3}>
              {t("accessGate.privateBeta")}
            </Text>
            <Text fontSize={13} color={c.text3} lineHeight={20}>
              {t("accessGate.description")}
            </Text>
          </YStack>

          <YStack gap="$2" paddingTop="$2">
            {[
              t("accessGate.noActionNeeded"),
              t("accessGate.reviewPersonally"),
              t("accessGate.emailWhenIn"),
            ].map((item) => (
              <XStack key={item} gap="$2" alignItems="flex-start">
                <Text color={semanticColors.indigo} fontSize={13} marginTop={1}>
                  ·
                </Text>
                <Text fontSize={13} color={c.text2} flex={1} lineHeight={20}>
                  {item}
                </Text>
              </XStack>
            ))}
          </YStack>
        </YStack>

        {/* Sign out */}
        <XStack
          paddingVertical="$3"
          paddingHorizontal="$4"
          backgroundColor={indicators.irreversible.bg}
          borderWidth={1}
          borderColor={indicators.irreversible.border}
          borderRadius="$3"
          alignItems="center"
          gap="$2"
          cursor="pointer"
          hoverStyle={{ backgroundColor: controlsBar.deny.bg }}
          pressStyle={{ opacity: 0.8 }}
          onPress={handleLogout}
        >
          <LogOut size={15} color={semanticColors.red} />
          <Text fontSize={13} color={semanticColors.red} fontWeight="500">
            {t("accessGate.signOut")}
          </Text>
        </XStack>
      </YStack>
    </LinearGradient>
  )
}
