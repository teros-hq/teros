import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
} from "@tamagui/lucide-icons"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import React, { useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Text, XStack, YStack } from "tamagui"
import { TerosLogo } from "../../../src/components/TerosLogo"
import { normalizeAuthUser, useAuthStore } from "../../../src/store/authStore"
import { setUser as setSentryUser } from "../../../src/lib/sentry"
import { identifyUser, track } from "../../../src/lib/analytics"
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

export default function SignUp() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")

  const router = useRouter()
  const client = getTerosClient()
  const insets = useSafeAreaInsets()
  const { login: authLogin, isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  const emailRef = useRef<TextInput>(null)
  const passwordRef = useRef<TextInput>(null)
  const confirmRef = useRef<TextInput>(null)

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

  const validate = (): string | null => {
    if (!name.trim()) return t("auth.pleaseEnterName")
    if (!email.trim()) return t("auth.pleaseEnterEmail")
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return t("auth.invalidEmail")
    if (password.length < 8) return t("auth.passwordMinChars")
    if (password !== confirmPassword) return t("auth.passwordsDoNotMatch")
    if (!acceptedTerms) return t("auth.acceptTerms")
    return null
  }

  const handleSignUp = async () => {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
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
          name: name.trim(),
        })
        authLogin(user, sessionToken)
        setSentryUser({ id: user.userId, email: user.email, username: user.name })
        identifyUser({ userId: user.userId, email: user.email, name: user.name })
        track("user_signed_up", { method: "email" })
        client.setSessionToken(sessionToken)

        router.replace("/")
        setIsLoading(false)
      }

      const authErrorHandler = (err: unknown) => {
        clearTimeout(timeoutId)
        client.off("authenticated", authSuccessHandler)
        client.off("auth_error", authErrorHandler)
        setError(String(err || '') || t("auth.couldNotCreateAccount"))
        setIsLoading(false)
      }

      client.on("authenticated", authSuccessHandler)
      client.on("auth_error", authErrorHandler)

      await client.register(email.trim(), password, name.trim())
    } catch (err: any) {
      setError(err.message || t("auth.signUpFailed"))
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
            paddingBottom="$8"
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

            {/* Logo */}
            <YStack alignItems="center" marginTop="$6" marginBottom="$6" gap="$3">
              <TerosLogo size={64} animated={false} />
              <Text fontSize={28} fontWeight="200" color={c.text} letterSpacing={6} marginTop="$3">
                TEROS
              </Text>
              <Text fontSize="$3" color={c.text2} marginTop="$1">{t("auth.createYourAccount")}</Text>
            </YStack>

            {/* Alpha notice */}
            <XStack
              backgroundColor="rgba(6, 182, 212, 0.06)"
              borderWidth={1}
              borderColor="rgba(6, 182, 212, 0.15)"
              borderRadius="$3"
              padding="$3"
              gap="$2"
              alignItems="flex-start"
              marginBottom="$5"
            >
              <Text fontSize={14} lineHeight={14} marginTop={1}>⚠️</Text>
              <YStack flex={1} gap="$1">
                <Text fontSize="$3" color="#06B6D4" fontWeight="600">{t("auth.earlyAlpha")}</Text>
                <Text fontSize="$2" color={c.text3} lineHeight={18}>
                  {t("auth.earlyAlphaDescription")}
                </Text>
              </YStack>
            </XStack>

            {/* Form */}
            <YStack width="100%" gap="$3">
              {/* Name */}
              <XStack
                alignItems="center"
                borderWidth={1}
                borderRadius="$3"
                paddingHorizontal="$4"
                height={52}
                backgroundColor={c.bgInner}
                borderColor={c.borderStrong}
              >
                <User size={18} color={c.text2} />
                <TextInput
                  style={[inputStyles.input, { color: c.text }]}
                  placeholder={t("auth.fullNamePlaceholder")}
                  placeholderTextColor={c.text3}
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  autoCorrect={false}
                  editable={!isLoading}
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                  autoComplete="name"
                />
              </XStack>

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
                  ref={emailRef}
                  style={[inputStyles.input, { color: c.text }]}
                  placeholder={t("auth.emailPlaceholder")}
                  placeholderTextColor={c.text3}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!isLoading}
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
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
                  ref={passwordRef}
                  style={[inputStyles.input, { color: c.text }]}
                  placeholder={t("auth.passwordMinCharsPlaceholder")}
                  placeholderTextColor={c.text3}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isLoading}
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef.current?.focus()}
                  autoComplete="new-password"
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

              {/* Confirm Password */}
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
                  ref={confirmRef}
                  style={[inputStyles.input, { color: c.text }]}
                  placeholder={t("auth.confirmPasswordPlaceholder")}
                  placeholderTextColor={c.text3}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry={!showConfirmPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isLoading}
                  returnKeyType="done"
                  onSubmitEditing={handleSignUp}
                  autoComplete="new-password"
                />
                <Button
                  chromeless
                  padding="$2"
                  onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                  disabled={isLoading}
                  icon={
                    showConfirmPassword ? (
                      <Eye size={18} color={c.text2} />
                    ) : (
                      <EyeOff size={18} color={c.text2} />
                    )
                  }
                />
              </XStack>

              {/* Terms & Conditions */}
              <TouchableOpacity
                onPress={() => setAcceptedTerms(!acceptedTerms)}
                disabled={isLoading}
                activeOpacity={0.7}
              >
                <XStack gap="$3" alignItems="flex-start" paddingVertical="$1">
                  <XStack
                    width={20}
                    height={20}
                    borderRadius={5}
                    borderWidth={1.5}
                    borderColor={acceptedTerms ? "#06B6D4" : c.borderStrong}
                    backgroundColor={acceptedTerms ? "rgba(6,182,212,0.15)" : "transparent"}
                    alignItems="center"
                    justifyContent="center"
                    marginTop={1}
                    flexShrink={0}
                  >
                    {acceptedTerms && (
                      <Text fontSize={11} color="#06B6D4" fontWeight="700" lineHeight={12}>✓</Text>
                    )}
                  </XStack>
                  <Text fontSize="$3" color={c.text2} flex={1} lineHeight={20}>
                    <Trans
                      i18nKey="auth.termsCheckbox"
                      components={{
                        1: <Text fontWeight="700" color={c.text2} />,
                        2: (
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

              {/* Submit */}
              <Button
                height={48}
                borderRadius="$3"
                marginTop="$2"
                backgroundColor="#06B6D4"
                pressStyle={{ backgroundColor: "#0891B2" }}
                onPress={handleSignUp}
                disabled={isLoading}
                opacity={isLoading ? 0.5 : 1}
              >
                <XStack gap="$2" alignItems="center">
                  {isLoading ? (
                    <AppSpinner size="sm" color="#FFFFFF" />
                  ) : (
                    <>
                      <Text color="#FFFFFF" fontSize="$4" fontWeight="600">{t("auth.createAccount")}</Text>
                      <ArrowRight size={18} color="#FFFFFF" />
                    </>
                  )}
                </XStack>
              </Button>

              {/* Sign in link */}
              <XStack gap="$2" alignItems="center" justifyContent="center" marginTop="$2">
                <Text color={c.text3} fontSize="$3">{t("auth.alreadyHaveAccount")}</Text>
                <Button
                  chromeless
                  onPress={() => router.back()}
                  pressStyle={{ opacity: 0.7 }}
                  padding={0}
                  height="auto"
                >
                  <Text color="#06B6D4" fontSize="$3" fontWeight="500">{t("auth.signIn")}</Text>
                </Button>
              </XStack>
            </YStack>
          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  )
}
