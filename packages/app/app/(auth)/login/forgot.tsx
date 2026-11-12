import { useRouter } from "expo-router"
import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import {
  AuthBanner,
  AuthBrand,
  AuthShell,
  AuthTitle,
} from "../../../src/components/auth/AuthShell"
import { Btn, Field, FieldLabel, T } from "../../../src/components/ui/ds"
import { setPendingPasswordReset } from "../../../src/services/pendingPasswordReset"
import {
  CODE_REQUEST_THROTTLE_S,
  markCodeRequest,
  secondsUntilNextCodeRequest,
} from "../../../src/services/passwordResetThrottleLogic"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { useAuthStore } from "../../../src/store/authStore"
import { wsUrl } from "../../../src/config/runtime"

type TerosClient = ReturnType<typeof getTerosClient>

/**
 * The server closes an unauthenticated socket after 30s. Reconnect if needed.
 */
function whenConnected(client: TerosClient): Promise<void> {
  if (client.isConnected()) return Promise.resolve()
  if (!client.isConnectedOrConnecting()) {
    const serverUrl = wsUrl()
    if (serverUrl) client.connect(serverUrl)
  }
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      client.off("connected", onConnected)
      reject(new Error("timeout"))
    }, 10000)
    const onConnected = () => {
      clearTimeout(timeoutId)
      client.off("connected", onConnected)
      resolve()
    }
    client.on("connected", onConnected)
  })
}

export default function ForgotPassword() {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [throttle, setThrottle] = useState(() => secondsUntilNextCodeRequest())

  const router = useRouter()
  const client = getTerosClient()
  const { isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const submitting = useRef(false)

  useEffect(() => {
    if (isAuthenticated) router.replace("/")
  }, [isAuthenticated])

  useEffect(() => {
    if (!client.isConnectedOrConnecting()) {
      const serverUrl = wsUrl()
      if (serverUrl) client.connect(serverUrl)
    }
  }, [client])

  // 1s countdown while the code-request throttle is active.
  useEffect(() => {
    if (throttle <= 0) return
    const id = setTimeout(() => setThrottle(secondsUntilNextCodeRequest()), 1000)
    return () => clearTimeout(id)
  }, [throttle])

  const handleSubmit = async () => {
    const trimmed = email.trim()
    if (!trimmed || !trimmed.includes("@")) {
      setError(t("auth.enterValidEmail", { defaultValue: "Enter a valid email address" }))
      return
    }
    if (submitting.current || throttle > 0) return

    submitting.current = true
    setIsLoading(true)
    setError("")

    try {
      await whenConnected(client)
    } catch {
      setError(t("auth.requestTimedOut"))
      setIsLoading(false)
      return
    }

    const timeoutId = setTimeout(() => {
      cleanup()
      setError(t("auth.requestTimedOut"))
      setIsLoading(false)
    }, 10000)

    const cleanup = () => {
      clearTimeout(timeoutId)
      submitting.current = false
      client.off("password_reset_required", onSent)
      client.off("auth_error", onError)
    }

    // The server always answers with password_reset_required — whether the
    // email exists or not (anti-enumeration). Move to the code prompt.
    const onSent = (data: any) => {
      cleanup()
      markCodeRequest()
      setPendingPasswordReset({ challengeToken: data.challengeToken, email: data.email })
      setIsLoading(false)
      // The email travels in the route params so the reset screen can render
      // even if the in-memory store is gone (web reload). The challengeToken
      // stays out of the URL on purpose — the store keeps it secret.
      router.push({
        pathname: "/(auth)/login/reset",
        params: { email: data.email || trimmed },
      })
    }

    const onError = (err: unknown) => {
      cleanup()
      setError(String(err || "") || t("auth.resetRequestFailed", { defaultValue: "Could not start the password reset" }))
      setIsLoading(false)
    }

    client.on("password_reset_required", onSent)
    client.on("auth_error", onError)
    client.forgotPassword(trimmed).catch((err) => onError(err?.message))
  }

  return (
    <AuthShell footer testID="forgot-password-card">
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
          // Opened directly (reload, pasted link) there is no history to go back to.
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/(auth)/login/email"))}
          testID="forgot-password-back"
        >
          {t("common.back")}
        </Btn>
      </View>

      <AuthTitle
        title={t("auth.forgotPasswordTitle", { defaultValue: "Reset your password" })}
        lead={t("auth.forgotPasswordLead", {
          defaultValue: "Enter your email and we'll send you a 6-digit code to set a new password.",
        })}
      />

      <View style={{ marginTop: 24 }}>
        {error ? (
          <AuthBanner icon="warning-circle" testID="forgot-password-error">
            {error}
          </AuthBanner>
        ) : null}

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
            autoFocus
            onSubmitEditing={handleSubmit}
            testID="forgot-password-email-input"
          />
        </View>

        <Btn
          variant="primary"
          size="lg"
          full
          icon={throttle > 0 ? "clock-outline" : "arrow-right"}
          onPress={handleSubmit}
          disabled={isLoading || throttle > 0 || !email.trim()}
          loading={isLoading}
          style={{ marginTop: 6 }}
          testID="forgot-password-submit"
        >
          {throttle > 0
            ? t("auth.sendResetCodeIn", {
                defaultValue: "You can request another code in {{seconds}}s",
                seconds: throttle,
              })
            : t("auth.sendResetCode", { defaultValue: "Send reset code" })}
        </Btn>
        {throttle > 0 && !isLoading ? (
          <T step="sm" tone="text2" style={{ textAlign: "center", marginTop: 8 }} testID="forgot-password-throttle">
            {t("auth.sendResetCodeIn", {
              defaultValue: "You can request another code in {{seconds}}s",
              seconds: throttle,
            })}
          </T>
        ) : null}
      </View>
    </AuthShell>
  )
}
