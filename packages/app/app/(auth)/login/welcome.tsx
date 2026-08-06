/**
 * Welcome screen — shown once to every user who hasn't accepted T&C yet.
 * Appears after any auth method (Google, email, signup) if termsAcceptedAt is not set.
 */

import { ArrowRight } from "@tamagui/lucide-icons"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import React, { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Linking, TouchableOpacity } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Text, XStack, YStack } from "tamagui"
import { TerosLogo } from "../../../src/components/TerosLogo"
import { useToast } from "../../../src/components/Toast"
import { useAuthStore } from "../../../src/store/authStore"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { AppSpinner } from "../../../src/components/ui/AppSpinner"
import { useColors } from "../../../src/components/mca/primitives/useColors"

export default function Welcome() {
  const [accepted, setAccepted] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const { user, updateProfile } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  const handleContinue = async () => {
    if (!accepted) return

    setIsLoading(true)
    try {
      await client.send("profile", "accept-terms", {})

      // updateProfile() persists to storage internally
      updateProfile({ termsAcceptedAt: new Date().toISOString() })

      router.replace("/(auth)/login/onboarding")
    } catch (err: any) {
      console.error("Failed to accept terms:", err)
      toast.error(t("auth.error"), t("auth.couldNotSavePreferences"))
      setIsLoading(false)
    }
  }

  return (
    <LinearGradient
      colors={[c.bgPage, c.bgCard, c.bgPage]}
      locations={[0, 0.5, 1]}
      style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        maxWidth={420}
        width="100%"
        alignSelf="center"
        gap="$6"
      >
        {/* Logo */}
        <YStack alignItems="center" gap="$4">
          <TerosLogo size={72} animated={true} />
          <Text fontSize={30} fontWeight="200" color={c.text} letterSpacing={7} marginTop="$2">
            TEROS
          </Text>
          {user?.name && (
            <Text fontSize="$4" color={c.text2}>{t("auth.welcomeUser", { name: user.name })}</Text>
          )}
        </YStack>

        {/* Alpha notice card */}
        <YStack
          backgroundColor="rgba(6, 182, 212, 0.05)"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.15)"
          borderRadius="$4"
          padding="$5"
          gap="$4"
          width="100%"
        >
          <XStack gap="$3" alignItems="center">
            <Text fontSize={22}>⚠️</Text>
            <YStack flex={1}>
              <Text fontSize="$4" color="#06B6D4" fontWeight="700" letterSpacing={0.5}>
                {t("auth.privateBeta")}
              </Text>
              <Text fontSize="$2" color={c.text3} marginTop={2}>
                {t("auth.notProductionReady")}
              </Text>
            </YStack>
          </XStack>

          <YStack gap="$3">
            {[
              t("auth.betaNotice1"),
              t("auth.betaNotice2"),
              t("auth.betaNotice3"),
              t("auth.betaNotice4"),
            ].map((item) => (
              <XStack key={item} gap="$2" alignItems="flex-start">
                <Text color="#06B6D4" fontSize="$3" marginTop={1}>·</Text>
                <Text fontSize="$3" color={c.text2} flex={1} lineHeight={20}>{item}</Text>
              </XStack>
            ))}
          </YStack>
        </YStack>

        {/* T&C checkbox */}
        <TouchableOpacity
          onPress={() => setAccepted(!accepted)}
          activeOpacity={0.7}
          style={{ width: "100%" }}
        >
          <XStack gap="$3" alignItems="flex-start" width="100%">
            <XStack
              width={22}
              height={22}
              borderRadius={6}
              borderWidth={1.5}
              borderColor={accepted ? "#06B6D4" : c.borderStrong}
              backgroundColor={accepted ? "rgba(6,182,212,0.15)" : "transparent"}
              alignItems="center"
              justifyContent="center"
              flexShrink={0}
              marginTop={1}
            >
              {accepted && (
                <Text fontSize={13} color="#06B6D4" fontWeight="700" lineHeight={14}>✓</Text>
              )}
            </XStack>
            <Text fontSize="$3" color={c.text2} flex={1} lineHeight={22}>
              <Trans
                i18nKey="auth.termsCheckboxWelcome"
                components={{
                  1: (
                    <Text
                      color="#06B6D4"
                      fontWeight="600"
                      onPress={(e) => {
                        e.stopPropagation()
                        Linking.openURL("https://teros.ai/terms")
                      }}
                    />
                  ),
                }}
              />
            </Text>
          </XStack>
        </TouchableOpacity>

        {/* Continue button */}
        <Button
          width="100%"
          height={52}
          borderRadius="$3"
          backgroundColor={accepted ? "#06B6D4" : c.bgInner}
          borderWidth={1}
          borderColor={accepted ? "#06B6D4" : c.border}
          pressStyle={{ backgroundColor: accepted ? "#0891B2" : c.bgCardHover }}
          onPress={handleContinue}
          disabled={!accepted || isLoading}
          animation="quick"
        >
          <XStack gap="$2" alignItems="center">
            {isLoading ? (
              <AppSpinner size="sm" color="#FFFFFF" />
            ) : (
              <>
                <Text color={accepted ? "#FFFFFF" : c.text3} fontSize="$4" fontWeight="600">
                  {t("auth.getStarted")}
                </Text>
                <ArrowRight size={18} color={accepted ? "#FFFFFF" : c.text3} />
              </>
            )}
          </XStack>
        </Button>
      </YStack>
    </LinearGradient>
  )
}
