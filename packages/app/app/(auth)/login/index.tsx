import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Text, XStack, YStack } from "tamagui"
import { GitHubIcon, GoogleIcon, MicrosoftIcon } from "../../../src/components/SocialIcons"
import { TerosLogo } from "../../../src/components/TerosLogo"
import { useToast } from "../../../src/components/Toast"
import { normalizeAuthUser, useAuthStore } from "../../../src/store/authStore"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { useColors } from "../../../src/components/mca/primitives/useColors"

export default function Login() {
  const [checkingAuth, setCheckingAuth] = useState(true)

  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const { login, isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  // If already authenticated, go straight to workspace
  useEffect(() => {
    if (isAuthenticated) {
      router.replace("/")
    } else {
      setCheckingAuth(false)
    }
  }, [isAuthenticated])

  // Ensure WebSocket is connected
  useEffect(() => {
    if (checkingAuth) return
    if (!client.isConnectedOrConnecting()) {
      const serverUrl = process.env.EXPO_PUBLIC_WS_URL
      if (serverUrl) client.connect(serverUrl)
    }
  }, [client, checkingAuth])

  const handleGoogleLogin = async () => {
    try {
      const serverUrl = process.env.EXPO_PUBLIC_WS_URL || ""
      const backendUrl = serverUrl
        .replace(/^wss:/, "https:")
        .replace(/^ws:/, "http:")
        .replace(/\/ws\/?$/, "")

      const oauthUrl = `${backendUrl}/auth/google/connect`

      if (Platform.OS === "web") {
        const popup = window.open(
          oauthUrl,
          "google_oauth",
          "width=500,height=600,menubar=no,toolbar=no",
        )

        if (!popup) {
          toast.error(t("auth.error"), t("auth.popupBlocked"))
          return
        }

        const handleMessage = async (event: MessageEvent) => {
          if (event.data?.type === "oauth_result") {
            window.removeEventListener("message", handleMessage)

            if (event.data.success && event.data.token) {
              // login() persists to storage internally
              const { user, sessionToken } = normalizeAuthUser({
                ...event.data,
                userId: event.data.userId,
                token: event.data.token,
              })
              login(user, sessionToken)

              if (client.isConnected()) {
                try {
                  await client.authenticateWithToken(event.data.token)
                } catch (authError) {
                  console.error("Failed to authenticate WebSocket:", authError)
                }
              } else {
                client.setSessionToken(event.data.token)
              }

              router.replace("/")
            } else {
              toast.error(t("auth.signInFailed"), event.data.error || t("auth.couldNotSignInGoogle"))
            }
          }
        }

        window.addEventListener("message", handleMessage)
      } else {
        const { Linking } = await import("react-native")
        await Linking.openURL(oauthUrl)
      }
    } catch (error) {
      console.error("Google login error:", error)
      toast.error(t("auth.error"), t("auth.couldNotSignInGoogle"))
    }
  }

  if (checkingAuth) {
    return (
      <LinearGradient
        colors={[c.bgPage, c.bgCard, c.bgPage]}
        locations={[0, 0.5, 1]}
        style={{ flex: 1 }}
      />
    )
  }

  return (
    <LinearGradient
      colors={[c.bgPage, c.bgCard, c.bgPage]}
      locations={[0, 0.5, 1]}
      style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <YStack
            flex={1}
            justifyContent="center"
            alignItems="center"
            padding="$5"
            paddingTop="$8"
            maxWidth={400}
            width="100%"
            alignSelf="center"
          >
            {/* Logo & Title */}
            <YStack alignItems="center" marginBottom="$10" gap="$4">
              <TerosLogo size={80} animated={false} />
              <Text fontSize={36} fontWeight="200" color={c.text} letterSpacing={8} marginTop="$4">
                TEROS
              </Text>
            </YStack>

            {/* Social Login Buttons */}
            <YStack width="100%" gap="$3" marginBottom="$6">
              {/* Google — fully functional */}
              <Button
                height={48}
                borderRadius="$3"
                backgroundColor={c.bgInner}
                borderWidth={1}
                borderColor={c.borderStrong}
                pressStyle={{ backgroundColor: c.bgCardHover }}
                onPress={handleGoogleLogin}
              >
                <XStack gap="$3" alignItems="center">
                  <GoogleIcon />
                  <Text color={c.text} fontSize="$4" fontWeight="500">
                    {t("auth.continueWithGoogle")}
                  </Text>
                </XStack>
              </Button>

              {/* GitHub — coming soon */}
              <Button
                height={48}
                borderRadius="$3"
                backgroundColor={c.bgInner}
                borderWidth={1}
                borderColor={c.border}
                pressStyle={{ backgroundColor: c.bgCardHover }}
                onPress={() => toast.info(t("auth.comingSoon"), t("auth.comingSoonGithub"))}
              >
                <XStack gap="$3" alignItems="center" flex={1}>
                  <GitHubIcon />
                  <Text color={c.text2} fontSize="$4" fontWeight="500" flex={1}>
                    {t("auth.continueWithGitHub")}
                  </Text>
                  <XStack
                    backgroundColor={c.bgInner}
                    paddingHorizontal="$2"
                    paddingVertical={3}
                    borderRadius="$2"
                  >
                    <Text color={c.text3} fontSize={10} fontWeight="600" letterSpacing={0.5}>
                      {t("common.soon")}
                    </Text>
                  </XStack>
                </XStack>
              </Button>

              {/* Microsoft — coming soon */}
              <Button
                height={48}
                borderRadius="$3"
                backgroundColor={c.bgInner}
                borderWidth={1}
                borderColor={c.border}
                pressStyle={{ backgroundColor: c.bgCardHover }}
                onPress={() => toast.info(t("auth.comingSoon"), t("auth.comingSoonMicrosoft"))}
              >
                <XStack gap="$3" alignItems="center" flex={1}>
                  <MicrosoftIcon />
                  <Text color={c.text2} fontSize="$4" fontWeight="500" flex={1}>
                    {t("auth.continueWithMicrosoft")}
                  </Text>
                  <XStack
                    backgroundColor={c.bgInner}
                    paddingHorizontal="$2"
                    paddingVertical={3}
                    borderRadius="$2"
                  >
                    <Text color={c.text3} fontSize={10} fontWeight="600" letterSpacing={0.5}>
                      {t("common.soon")}
                    </Text>
                  </XStack>
                </XStack>
              </Button>
            </YStack>

            {/* Divider */}
            <XStack width="100%" alignItems="center" gap="$3" marginBottom="$6">
              <YStack flex={1} height={1} backgroundColor={c.border} />
              <Text color={c.text3} fontSize="$2">{t("common.or")}</Text>
              <YStack flex={1} height={1} backgroundColor={c.border} />
            </XStack>

            {/* Email login / Sign up */}
            <YStack width="100%" gap="$3" alignItems="center">
              <Button
                width="100%"
                height={48}
                borderRadius="$3"
                backgroundColor="transparent"
                borderWidth={1}
                borderColor={c.borderStrong}
                pressStyle={{ backgroundColor: c.bgCardHover }}
                onPress={() => router.push("/(auth)/login/email")}
              >
                <Text color={c.text2} fontSize="$4" fontWeight="500">
                  {t("auth.signInWithEmail")}
                </Text>
              </Button>

              <XStack gap="$2" alignItems="center" marginTop="$2">
                <Text color={c.text3} fontSize="$3">{t("auth.dontHaveAccount")}</Text>
                <Button
                  chromeless
                  onPress={() => router.push("/(auth)/login/signup")}
                  pressStyle={{ opacity: 0.7 }}
                  padding={0}
                  height="auto"
                >
                  <Text color="#06B6D4" fontSize="$3" fontWeight="500">{t("auth.signUp")}</Text>
                </Button>
              </XStack>
            </YStack>
          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  )
}
