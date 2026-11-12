import { useRouter } from "expo-router"
import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import {
  AuthBanner,
  AuthBrand,
  AuthLink,
  AuthShell,
  AuthTitle,
} from "../../../src/components/auth/AuthShell"
import { Btn, Field, FieldLabel, T } from "../../../src/components/ui/ds"
import { setUser as setSentryUser } from "../../../src/lib/sentry"
import {
  clearPendingEmailVerification,
  getPendingEmailVerification,
  setPendingEmailVerification,
} from "../../../src/services/pendingEmailVerification"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { normalizeAuthUser, useAuthStore } from "../../../src/store/authStore"
import { wsUrl } from "../../../src/config/runtime"

const CODE_LENGTH = 6
const RESEND_COOLDOWN_S = 60

type TerosClient = ReturnType<typeof getTerosClient>

/**
 * The server closes an unauthenticated socket after 30s, and the user may
 * take longer than that to find the email. Reconnect if needed before sending.
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

export default function VerifyEmail() {
  const pending = getPendingEmailVerification()
  const [code, setCode] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S)

  const router = useRouter()
  const client = getTerosClient()
  const { login: authLogin, isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const submitting = useRef(false)

  // Nothing to verify (reload, deep link): start over from sign in
  useEffect(() => {
    if (isAuthenticated) router.replace("/")
    else if (!pending) router.replace("/(auth)/login/email")
  }, [isAuthenticated, pending])

  useEffect(() => {
    if (cooldown <= 0) return
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  if (!pending) return null

  /** Send one auth message and settle on its answer. */
  const sendAuth = (send: () => Promise<void>, onError: (err: unknown) => void) => {
    const timeoutId = setTimeout(() => {
      cleanup()
      setError(t("auth.requestTimedOut"))
      setIsLoading(false)
      submitting.current = false
    }, 10000)

    const cleanup = () => {
      clearTimeout(timeoutId)
      client.off("authenticated", onSuccess)
      client.off("auth_error", onAuthError)
      client.off("email_verification_required", onStillPending)
    }

    const onSuccess = (data: any) => {
      cleanup()
      clearPendingEmailVerification()
      // login() persists to storage internally
      const { user, sessionToken } = normalizeAuthUser(data, {
        email: pending.email,
        name: pending.displayName,
      })
      authLogin(user, sessionToken)
      setSentryUser({ id: user.userId, email: user.email, username: user.name })
      client.setSessionToken(sessionToken)

      router.replace("/")
      setIsLoading(false)
      submitting.current = false
    }

    const onAuthError = (err: unknown) => {
      cleanup()
      onError(err)
      setIsLoading(false)
      submitting.current = false
    }

    // A resend answers with the same (still pending) challenge
    const onStillPending = (data: any) => {
      cleanup()
      setPendingEmailVerification({ ...pending, challengeToken: data.challengeToken })
      setNotice(t("auth.codeResent", { defaultValue: "We sent you a new code." }))
      setCooldown(RESEND_COOLDOWN_S)
      setIsLoading(false)
      submitting.current = false
    }

    client.on("authenticated", onSuccess)
    client.on("auth_error", onAuthError)
    client.on("email_verification_required", onStillPending)
    send().catch((err) => onAuthError(err?.message))
  }

  const handleVerify = async (value = code) => {
    const digits = value.replace(/\D/g, "")
    if (digits.length !== CODE_LENGTH || submitting.current) return

    submitting.current = true
    setIsLoading(true)
    setError("")
    setNotice("")

    try {
      await whenConnected(client)
    } catch {
      setError(t("auth.requestTimedOut"))
      setIsLoading(false)
      submitting.current = false
      return
    }

    sendAuth(
      () => client.verifyEmail(pending.challengeToken, digits),
      (err) => {
        setCode("")
        setError(String(err || "") || t("auth.invalidCode", { defaultValue: "Incorrect code" }))
      },
    )
  }

  const handleResend = async () => {
    if (cooldown > 0 || submitting.current) return

    submitting.current = true
    setIsLoading(true)
    setError("")
    setNotice("")

    try {
      await whenConnected(client)
    } catch {
      setError(t("auth.requestTimedOut"))
      setIsLoading(false)
      submitting.current = false
      return
    }

    sendAuth(
      () => client.resendEmailVerification(pending.challengeToken),
      (err) =>
        setError(
          String(err || "") ||
            t("auth.couldNotResendCode", { defaultValue: "Could not send a new code" }),
        ),
    )
  }

  const onChangeCode = (value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, CODE_LENGTH)
    setCode(digits)
    // Submit as soon as the code is complete (paste or autofill included)
    if (digits.length === CODE_LENGTH) void handleVerify(digits)
  }

  return (
    <AuthShell footer testID="verify-email-card">
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
          onPress={() => {
            clearPendingEmailVerification()
            router.back()
          }}
          testID="verify-email-back"
        >
          {t("common.back")}
        </Btn>
      </View>

      <AuthTitle
        title={t("auth.verifyEmailTitle", { defaultValue: "Check your email" })}
        lead={t("auth.verifyEmailLead", {
          defaultValue: "We sent a 6-digit code to {{email}}. Enter it to continue.",
          email: pending.email,
        })}
      />

      <View style={{ marginTop: 24 }}>
        {error ? (
          <AuthBanner icon="warning-circle" testID="verify-email-error">
            {error}
          </AuthBanner>
        ) : null}
        {notice && !error ? (
          <AuthBanner tone="lock" icon="envelope-simple" testID="verify-email-notice">
            {notice}
          </AuthBanner>
        ) : null}

        <View style={{ marginBottom: 14 }}>
          <FieldLabel style={{ marginBottom: 6 }}>
            {t("auth.verificationCode", { defaultValue: "Verification code" })}
          </FieldLabel>
          <Field
            lg
            icon="key"
            placeholder="000000"
            value={code}
            onChangeText={onChangeCode}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={CODE_LENGTH}
            autoFocus
            editable={!isLoading}
            onSubmitEditing={() => handleVerify()}
            testID="verify-email-code-input"
          />
        </View>

        <Btn
          variant="primary"
          size="lg"
          full
          icon="arrow-right"
          onPress={() => handleVerify()}
          disabled={isLoading || code.length !== CODE_LENGTH}
          loading={isLoading}
          style={{ marginTop: 6 }}
          testID="verify-email-submit"
        >
          {t("auth.verifyAndContinue", { defaultValue: "Verify and continue" })}
        </Btn>

        <View style={{ alignItems: "center", marginTop: 16 }}>
          {cooldown > 0 ? (
            <T step="sm" tone="text2" testID="verify-email-cooldown">
              {t("auth.resendCodeIn", {
                defaultValue: "Resend code in {{seconds}}s",
                seconds: cooldown,
              })}
            </T>
          ) : (
            <AuthLink onPress={handleResend} testID="verify-email-resend">
              {t("auth.resendCode", { defaultValue: "Send a new code" })}
            </AuthLink>
          )}
        </View>
      </View>
    </AuthShell>
  )
}
