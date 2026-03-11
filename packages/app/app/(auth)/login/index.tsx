import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import React, { useEffect, useState } from "react"
import { KeyboardAvoidingView, Platform, ScrollView } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Text, XStack, YStack } from "tamagui"
import { GitHubIcon, GoogleIcon, MicrosoftIcon } from "../../../src/components/SocialIcons"
import { TerosLogo } from "../../../src/components/TerosLogo"
import { useToast } from "../../../src/components/Toast"
import { STORAGE_KEYS, storage } from "../../../src/services/storage"
import { useAuthStore } from "../../../src/store/authStore"
import { getTerosClient } from "../../_layout"

export default function Login() {
  const [checkingAuth, setCheckingAuth] = useState(true)

  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const { login, sessionToken } = useAuthStore()

  // Check if already authenticated and redirect
  useEffect(() => {
    if (sessionToken) {
      router.replace("/")
    } else {
      setCheckingAuth(false)
    }
  }, [sessionToken])

  // Ensure WebSocket is connected
  useEffect(() => {
    if (checkingAuth) return

    if (!client.isConnectedOrConnecting()) {
      const serverUrl = process.env.EXPO_PUBLIC_WS_URL
      if (serverUrl) {
        client.connect(serverUrl)
      }
    }
  }, [client, checkingAuth])

  const handleSocialLogin = async (provider: string) => {
    if (provider === "Google") {
      try {
        // Get backend URL from WebSocket URL (same pattern as MCA OAuth)
        const serverUrl = process.env.EXPO_PUBLIC_WS_URL || ""
        const backendUrl = serverUrl
          .replace(/^wss:/, "https:")
          .replace(/^ws:/, "http:")
          .replace(/\/ws\/?$/, "")

        const oauthUrl = `${backendUrl}/auth/google/connect`

        if (Platform.OS === "web") {
          // Open popup for OAuth flow (same pattern as MCA OAuth)
          const popup = window.open(
            oauthUrl,
            "google_oauth",
            "width=500,height=600,menubar=no,toolbar=no",
          )

          if (!popup) {
            toast.error("Error", "Por favor permite las ventanas emergentes para iniciar sesión")
            return
          }

          // Listen for OAuth result via postMessage
          const handleMessage = async (event: MessageEvent) => {
            if (event.data?.type === "oauth_result") {
              window.removeEventListener("message", handleMessage)

              if (event.data.success && event.data.token) {
                // Store session in authStore and storage for _layout.tsx compatibility
                const user = {
                  userId: event.data.userId,
                  email: event.data.user?.profile?.email || "",
                  name: event.data.user?.profile?.displayName,
                  displayName: event.data.user?.profile?.displayName,
                  avatarUrl: event.data.user?.profile?.avatarUrl,
                  role: event.data.user?.role || "user",
                }

                // Save to storage for session restoration on reload
                const storageData = { ...user, sessionToken: event.data.token }
                await storage.setItem(STORAGE_KEYS.USER, JSON.stringify(storageData))

                // Update authStore (in-memory state)
                login(user, event.data.token)

                // Authenticate the existing WebSocket connection with the new token
                if (client.isConnected()) {
                  try {
                    await client.authenticateWithToken(event.data.token)
                  } catch (authError) {
                    console.error("Failed to authenticate WebSocket:", authError)
                    // Continue anyway - _layout.tsx will handle reconnection if needed
                  }
                } else {
                  client.setSessionToken(event.data.token)
                }

                router.replace("/")
              } else {
                toast.error("Error", event.data.error || "No se pudo iniciar sesión con Google")
              }
            }
          }

          window.addEventListener("message", handleMessage)
        } else {
          // Native: Open in system browser
          const { Linking } = await import("react-native")
          await Linking.openURL(oauthUrl)
        }
      } catch (error) {
        console.error("Google login error:", error)
        toast.error("Error", "No se pudo iniciar sesión con Google")
      }
    } else {
      // Other providers not implemented yet
      toast.info("Proximamente", `Login con ${provider} estara disponible pronto`)
    }
  }

  const handleEmailLogin = () => {
    router.push("/(auth)/login/email")
  }

  // Show nothing while checking auth
  if (checkingAuth) {
    return (
      <LinearGradient
        colors={["#000000", "#050508", "#0a0a0f"]}
        locations={[0, 0.5, 1]}
        style={{ flex: 1 }}
      />
    )
  }

  return (
    <LinearGradient
      colors={["#000000", "#050508", "#0a0a0f"]}
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

              <Text fontSize={36} fontWeight="200" color="#E4E4E7" letterSpacing={8} marginTop="$4">
                TEROS
              </Text>
            </YStack>

            {/* Social Login Buttons */}
            <YStack width="100%" gap="$3" marginBottom="$8">
              <Button
                height={48}
                borderRadius="$3"
                backgroundColor="rgba(255, 255, 255, 0.05)"
                borderWidth={1}
                borderColor="rgba(255, 255, 255, 0.1)"
                pressStyle={{ backgroundColor: "rgba(255, 255, 255, 0.1)" }}
                onPress={() => handleSocialLogin("Google")}
              >
                <XStack gap="$3" alignItems="center">
                  <GoogleIcon />
                  <Text color="#E4E4E7" fontSize="$4" fontWeight="500">
                    Continuar con Google
                  </Text>
                </XStack>
              </Button>

              <Button
                height={48}
                borderRadius="$3"
                backgroundColor="rgba(255, 255, 255, 0.05)"
                borderWidth={1}
                borderColor="rgba(255, 255, 255, 0.1)"
                pressStyle={{ backgroundColor: "rgba(255, 255, 255, 0.1)" }}
                onPress={() => handleSocialLogin("GitHub")}
              >
                <XStack gap="$3" alignItems="center">
                  <GitHubIcon />
                  <Text color="#E4E4E7" fontSize="$4" fontWeight="500">
                    Continuar con GitHub
                  </Text>
                </XStack>
              </Button>

              <Button
                height={48}
                borderRadius="$3"
                backgroundColor="rgba(255, 255, 255, 0.05)"
                borderWidth={1}
                borderColor="rgba(255, 255, 255, 0.1)"
                pressStyle={{ backgroundColor: "rgba(255, 255, 255, 0.1)" }}
                onPress={() => handleSocialLogin("Microsoft")}
              >
                <XStack gap="$3" alignItems="center">
                  <MicrosoftIcon />
                  <Text color="#E4E4E7" fontSize="$4" fontWeight="500">
                    Continuar con Microsoft
                  </Text>
                </XStack>
              </Button>
            </YStack>

            {/* Email/Password Link */}
            <Button chromeless onPress={handleEmailLogin} pressStyle={{ opacity: 0.7 }}>
              <Text color="#71717A" fontSize="$3">
                Usar email y contrasena
              </Text>
            </Button>

          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  )
}
