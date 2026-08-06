import { AlertCircle, ArrowLeft, ArrowRight, Eye, EyeOff, Lock, Mail } from "@tamagui/lucide-icons"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
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
import { normalizeAuthUser, useAuthStore } from "../../../src/store/authStore"
import { setUser as setSentryUser } from "../../../src/lib/sentry"
import { identifyUser } from "../../../src/lib/analytics"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { AppSpinner } from "../../../src/components/ui/AppSpinner"
import { useColors } from "../../../src/components/mca/primitives/useColors"
import { colors as semanticColors } from "../../../src/components/mca/primitives/colors"

const inputStyles = StyleSheet.create({
  input: {
    flex: 1,
    fontSize: 16,
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

  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const insets = useSafeAreaInsets()
  const { login: authLogin, isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  // If already authenticated, go to workspace
  useEffect(() => {
    if (isAuthenticated) router.replace("/")
  }, [isAuthenticated])

  useEffect(() => {
    if (!client.isConnectedOrConnecting()) {
      const serverUrl = process.env.EXPO_PUBLIC_WS_URL
      if (serverUrl) client.connect(serverUrl)
    }
  }, [client])

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError(t("auth.pleaseEnterEmailPassword"))
      return
    }

    setIsLoading(true)
    setError("")

    try {
      const timeoutId = setTimeout(() => {
        setError(t("auth.requestTimedOut"))
        setIsLoading(false)
      }, 10000)

      const authSuccessHandler = (data: any) => {
        clearTimeout(timeoutId)
        client.off("authenticated", authSuccessHandler)
        client.off("auth_error", authErrorHandler)

        // login() persists to storage internally
        const { user, sessionToken } = normalizeAuthUser(data, {
          email: email.trim(),
          name: email.trim().split("@")[0],
        })
        authLogin(user, sessionToken)
        setSentryUser({ id: user.userId, email: user.email, username: user.name })
        identifyUser({ userId: user.userId, email: user.email, name: user.name })
        client.setSessionToken(sessionToken)

        router.replace("/")
        setIsLoading(false)
      }

      const authErrorHandler = (err: unknown) => {
        clearTimeout(timeoutId)
        client.off("authenticated", authSuccessHandler)
        client.off("auth_error", authErrorHandler)
        setError(String(err || '') || t("auth.incorrectCredentials"))
        setIsLoading(false)
      }

      client.on("authenticated", authSuccessHandler)
      client.on("auth_error", authErrorHandler)
      await client.authenticateWithCredentials(email.trim(), password)
    } catch (err: any) {
      setError(err.message || t("auth.signInFailed"))
      setIsLoading(false)
    }
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
              onPress={() => router.back()}
              pressStyle={{ opacity: 0.7 }}
              paddingLeft={0}
            >
              <XStack gap="$2" alignItems="center">
                <ArrowLeft size={18} color={c.text2} />
                <Text color={c.text2} fontSize="$3">{t("common.back")}</Text>
              </XStack>
            </Button>

            {/* Logo & Title */}
            <YStack alignItems="center" marginTop="$6" marginBottom="$8" gap="$4">
              <TerosLogo size={80} animated={false} />
              <Text fontSize={36} fontWeight="200" color={c.text} letterSpacing={8} marginTop="$4">
                TEROS
              </Text>
            </YStack>

            {/* Form */}
            <YStack width="100%" gap="$4">
              {/* Email */}
              <XStack
                alignItems="center"
                borderWidth={1}
                borderRadius="$3"
                paddingHorizontal="$4"
                height={52}
                backgroundColor={c.bgInner}
                borderColor={c.borderStrong}
              >
                <Mail size={18} color={c.text2} />
                <TextInput
                  style={[inputStyles.input, { color: c.text }]}
                  placeholder={t("auth.emailPlaceholder")}
                  placeholderTextColor={c.text3}
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
                backgroundColor={c.bgInner}
                borderColor={c.borderStrong}
              >
                <Lock size={18} color={c.text2} />
                <TextInput
                  style={[inputStyles.input, { color: c.text }]}
                  placeholder={t("auth.passwordPlaceholder")}
                  placeholderTextColor={c.text3}
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
                      <Eye size={18} color={c.text2} />
                    ) : (
                      <EyeOff size={18} color={c.text2} />
                    )
                  }
                />
              </XStack>

              {/* Error */}
              {error ? (
                <XStack
                  alignItems="center"
                  padding="$3"
                  borderRadius="$2"
                  backgroundColor={c.badges.err.bg}
                  gap="$2"
                >
                  <AlertCircle size={16} color={semanticColors.red} />
                  <Text fontSize="$3" color={semanticColors.red} flex={1}>{error}</Text>
                </XStack>
              ) : null}

              {/* Sign In Button */}
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
                    <AppSpinner size="sm" color="#FFFFFF" />
                  ) : (
                    <>
                      <Text color="#FFFFFF" fontSize="$4" fontWeight="600">{t("auth.signIn")}</Text>
                      <ArrowRight size={18} color="#FFFFFF" />
                    </>
                  )}
                </XStack>
              </Button>

              {/* Forgot password */}
              <Button
                chromeless
                alignSelf="center"
                marginTop="$2"
                onPress={() => toast.info(t("auth.comingSoon"), t("auth.comingSoonPassword"))}
                pressStyle={{ opacity: 0.7 }}
              >
                <Text color={c.text2} fontSize="$3">{t("auth.forgotPassword")}</Text>
              </Button>

              {/* Sign up link */}
              <XStack gap="$2" alignItems="center" justifyContent="center" marginTop="$2">
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
