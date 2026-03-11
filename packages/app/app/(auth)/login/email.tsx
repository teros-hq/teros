import { AlertCircle, ArrowLeft, ArrowRight, Eye, EyeOff, Lock, Mail } from "@tamagui/lucide-icons"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import React, { useEffect, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Text, XStack, YStack } from "tamagui"
import { TerosLogo } from "../../../src/components/TerosLogo"
import { useToast } from "../../../src/components/Toast"
import { STORAGE_KEYS, storage } from "../../../src/services/storage"
import { useAuthStore } from "../../../src/store/authStore"
import { getTerosClient } from "../../_layout"

// Styles for native TextInput to handle autofill properly
const inputStyles = StyleSheet.create({
  input: {
    flex: 1,
    fontSize: 16,
    color: "#E4E4E7",
    backgroundColor: "transparent",
    paddingVertical: 0,
    paddingHorizontal: 0,
    marginLeft: 12,
    outlineStyle: "none",
  } as any,
})

export default function EmailLogin() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(true)

  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const { login: authLogin } = useAuthStore()

  // Check if already authenticated and redirect
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const userData = await storage.getItem(STORAGE_KEYS.USER)
        if (userData) {
          const user = JSON.parse(userData)
          if (user.sessionToken) {
            router.replace("/")
            return
          }
        }
      } catch (e) {
        // Ignore auth check errors
      }
      setCheckingAuth(false)
    }
    checkAuth()
  }, [])

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

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError("Por favor ingresa email y contrasena")
      return
    }

    setIsLoading(true)
    setError("")

    try {
      // Timeout to detect if events never fire
      const timeoutId = setTimeout(() => {
        setError("Timeout: servidor no responde")
        setIsLoading(false)
      }, 10000)

      // Listen for auth success BEFORE authenticating
      const authSuccessHandler = async (data: any) => {
        clearTimeout(timeoutId)
        client.off("authenticated", authSuccessHandler)
        client.off("auth_error", authErrorHandler)

        // Save to storage (works on both web and native)
        const userData = {
          id: data.userId,
          email: email.trim(),
          displayName: email.trim().split("@")[0],
          sessionToken: data.token || data.sessionToken,
          role: data.role || "user",
        }

        try {
          await storage.setItem(STORAGE_KEYS.USER, JSON.stringify(userData))
        } catch (e) {
          // Ignore storage errors
        }

        // Sync to auth store
        authLogin(
          {
            userId: data.userId,
            email: email.trim(),
            name: email.trim().split("@")[0],
          },
          data.token || data.sessionToken,
        )

        // Navigate to main screen
        router.replace("/")
        setIsLoading(false)
      }

      const authErrorHandler = (error: string) => {
        clearTimeout(timeoutId)
        client.off("authenticated", authSuccessHandler)
        client.off("auth_error", authErrorHandler)
        setError(error || "Email o contrasena incorrectos")
        setIsLoading(false)
      }

      // Register handlers BEFORE authenticating
      client.on("authenticated", authSuccessHandler)
      client.on("auth_error", authErrorHandler)

      // Now authenticate
      await client.authenticateWithCredentials(email.trim(), password)
    } catch (err: any) {
      setError(err.message || "Error al iniciar sesion")
      setIsLoading(false)
    }
  }

  const handleBack = () => {
    router.back()
  }

  const handleForgotPassword = () => {
    // TODO: Implement forgot password
    toast.info("Proximamente", "Recuperacion de contrasena estara disponible pronto")
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
            padding="$5"
            paddingTop="$6"
            maxWidth={400}
            width="100%"
            alignSelf="center"
          >
            {/* Back Button */}
            <Button
              chromeless
              alignSelf="flex-start"
              onPress={handleBack}
              pressStyle={{ opacity: 0.7 }}
              paddingLeft={0}
            >
              <XStack gap="$2" alignItems="center">
                <ArrowLeft size={18} color="#71717A" />
                <Text color="#71717A" fontSize="$3">
                  Volver
                </Text>
              </XStack>
            </Button>

            {/* Logo & Title */}
            <YStack alignItems="center" marginTop="$6" marginBottom="$8" gap="$4">
              <TerosLogo size={80} animated={false} />

              <Text fontSize={36} fontWeight="200" color="#E4E4E7" letterSpacing={8} marginTop="$4">
                TEROS
              </Text>
            </YStack>

            {/* Email/Password Form */}
            <YStack width="100%" gap="$4">
              {/* Email */}
              <XStack
                alignItems="center"
                borderWidth={1}
                borderRadius="$3"
                paddingHorizontal="$4"
                height={52}
                backgroundColor="rgba(255, 255, 255, 0.03)"
                borderColor="rgba(255, 255, 255, 0.1)"
              >
                <Mail size={18} color="#71717A" />
                <TextInput
                  style={inputStyles.input}
                  placeholder="Email"
                  placeholderTextColor="#52525B"
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!isLoading}
                  autoComplete="email"
                />
              </XStack>

              {/* Password */}
              <XStack
                alignItems="center"
                borderWidth={1}
                borderRadius="$3"
                paddingHorizontal="$4"
                height={52}
                backgroundColor="rgba(255, 255, 255, 0.03)"
                borderColor="rgba(255, 255, 255, 0.1)"
              >
                <Lock size={18} color="#71717A" />
                <TextInput
                  style={inputStyles.input}
                  placeholder="Contrasena"
                  placeholderTextColor="#52525B"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isLoading}
                  onSubmitEditing={handleLogin}
                  autoComplete="password"
                />
                <Button
                  chromeless
                  padding="$2"
                  onPress={() => setShowPassword(!showPassword)}
                  disabled={isLoading}
                  icon={
                    showPassword ? (
                      <Eye size={18} color="#71717A" />
                    ) : (
                      <EyeOff size={18} color="#71717A" />
                    )
                  }
                />
              </XStack>

              {/* Error Message */}
              {error ? (
                <XStack
                  alignItems="center"
                  padding="$3"
                  borderRadius="$2"
                  backgroundColor="rgba(239, 68, 68, 0.1)"
                  gap="$2"
                >
                  <AlertCircle size={16} color="#EF4444" />
                  <Text fontSize="$3" color="#EF4444" flex={1}>
                    {error}
                  </Text>
                </XStack>
              ) : null}

              {/* Login Button */}
              <Button
                height={48}
                borderRadius="$3"
                marginTop="$2"
                backgroundColor="#06B6D4"
                pressStyle={{ backgroundColor: "#0891B2" }}
                onPress={handleLogin}
                disabled={isLoading}
                opacity={isLoading ? 0.5 : 1}
              >
                <XStack gap="$2" alignItems="center">
                  {isLoading ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <>
                      <Text color="#FFFFFF" fontSize="$4" fontWeight="600">
                        Iniciar sesion
                      </Text>
                      <ArrowRight size={18} color="#FFFFFF" />
                    </>
                  )}
                </XStack>
              </Button>

              {/* Forgot Password Link */}
              <Button
                chromeless
                alignSelf="center"
                marginTop="$4"
                onPress={handleForgotPassword}
                pressStyle={{ opacity: 0.7 }}
              >
                <Text color="#71717A" fontSize="$3">
                  Olvidaste tu contrasena?
                </Text>
              </Button>


            </YStack>
          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  )
}
