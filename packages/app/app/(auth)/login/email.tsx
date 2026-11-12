import { useRouter } from "expo-router"
import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { normalizeAuthUser, useAuthStore } from "../../../src/store/authStore"
import { setUser as setSentryUser } from "../../../src/lib/sentry"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { setPendingEmailVerification } from "../../../src/services/pendingEmailVerification"
import { Btn, Field, FieldLabel, IconBtn } from "../../../src/components/ui/ds"
import {
  AuthBanner,
  AuthBrand,
  AuthLink,
  AuthShell,
  AuthSwitch,
  AuthTitle,
} from "../../../src/components/auth/AuthShell"
import { wsUrl } from "../../../src/config/runtime"

export default function EmailLogin() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  const router = useRouter()
  const client = getTerosClient()
  const { login: authLogin, isAuthenticated } = useAuthStore()
  const { t } = useTranslation()

  // If already authenticated, go to workspace
  useEffect(() => {
    if (isAuthenticated) router.replace("/")
  }, [isAuthenticated])

  useEffect(() => {
    if (!client.isConnectedOrConnecting()) {
      const serverUrl = wsUrl()
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
        client.off("email_verification_required", verificationHandler)

        // login() persists to storage internally
        const { user, sessionToken } = normalizeAuthUser(data, {
          email: email.trim(),
          name: email.trim().split("@")[0],
        })
        authLogin(user, sessionToken)
        setSentryUser({ id: user.userId, email: user.email, username: user.name })
        client.setSessionToken(sessionToken)

        router.replace("/")
        setIsLoading(false)
      }

      const authErrorHandler = (err: unknown) => {
        clearTimeout(timeoutId)
        client.off("authenticated", authSuccessHandler)
        client.off("auth_error", authErrorHandler)
        client.off("email_verification_required", verificationHandler)
        setError(String(err || "") || t("auth.incorrectCredentials"))
        setIsLoading(false)
      }

      // Password accounts confirm their email with a code before getting a session
      const verificationHandler = (data: any) => {
        clearTimeout(timeoutId)
        client.off("authenticated", authSuccessHandler)
        client.off("auth_error", authErrorHandler)
        client.off("email_verification_required", verificationHandler)
        setPendingEmailVerification({
          challengeToken: data.challengeToken,
          email: data.email,
          displayName: email.trim().split("@")[0],
          method: "login",
        })
        setIsLoading(false)
        router.push("/(auth)/login/verify")
      }

      client.on("authenticated", authSuccessHandler)
      client.on("auth_error", authErrorHandler)
      client.on("email_verification_required", verificationHandler)
      await client.authenticateWithCredentials(email.trim(), password)
    } catch (err: any) {
      setError(err.message || t("auth.signInFailed"))
      setIsLoading(false)
    }
  }

  return (
    <AuthShell footer testID="login-email-card">
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <AuthBrand style={{ marginBottom: 0 }} />
        <Btn
          variant="ghost"
          size="sm"
          icon="caret-left"
          onPress={() => router.back()}
          testID="login-back"
        >
          {t("common.back")}
        </Btn>
      </View>

      <AuthTitle
        title={t("auth.welcomeBack", { defaultValue: "Welcome back" })}
        lead={t("auth.emailLead", { defaultValue: "Sign in with the email you registered with." })}
      />

      <View style={{ marginTop: 24 }}>
        {error ? (
          <AuthBanner icon="warning-circle" testID="login-error">
            {error}
          </AuthBanner>
        ) : null}

        {/* Email */}
        <View style={{ marginBottom: 14 }}>
          <FieldLabel style={{ marginBottom: 6 }}>{t("auth.emailPlaceholder")}</FieldLabel>
          <Field
            lg
            icon="envelope-simple"
            placeholder={t("auth.emailPlaceholder")}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!isLoading}
            autoComplete="email"
            testID="login-email-input"
          />
        </View>

        {/* Password */}
        <View style={{ marginBottom: 14 }}>
          <FieldLabel style={{ marginBottom: 6 }}>{t("auth.passwordPlaceholder")}</FieldLabel>
          <Field
            lg
            icon="lock-simple"
            placeholder={t("auth.passwordPlaceholder")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isLoading}
            onSubmitEditing={handleLogin}
            autoComplete="password"
            testID="login-password-input"
            right={
              <IconBtn
                plain
                sm
                icon={showPassword ? "eye-slash" : "eye"}
                onPress={() => setShowPassword(!showPassword)}
                disabled={isLoading}
                style={{ marginRight: -6 }}
                title={
                  showPassword
                    ? t("auth.hidePassword", { defaultValue: "Hide password" })
                    : t("auth.showPassword", { defaultValue: "Show password" })
                }
              />
            }
          />
        </View>

        <Btn
          variant="primary"
          size="lg"
          full
          icon="arrow-right"
          onPress={handleLogin}
          disabled={isLoading}
          loading={isLoading}
          style={{ marginTop: 6 }}
          testID="login-submit"
        >
          {t("auth.signIn")}
        </Btn>

        <View style={{ alignItems: "center", marginTop: 16 }}>
          <AuthLink
            muted
            onPress={() => router.push("/(auth)/login/forgot")}
            testID="login-forgot-password"
          >
            {t("auth.forgotPassword")}
          </AuthLink>
        </View>
      </View>

      <AuthSwitch
        question={t("auth.dontHaveAccount")}
        action={t("auth.signUp")}
        onPress={() => router.push("/(auth)/login/signup")}
        testID="login-signup-link"
      />
    </AuthShell>
  )
}
