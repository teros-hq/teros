/**
 * Password reset, step 1 — the emailed code.
 *
 * Six boxes; a complete code (typed or pasted) is sent to the server for
 * checking. A right code moves on to the new-password screen; a wrong one is
 * reported here with the attempts left. @spec PWR-REQ-7 PWR-REQ-8 PWR-REQ-10
 */
import { useLocalSearchParams, useRouter } from "expo-router"
import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { type TextInput, View } from "react-native"
import {
  AuthBanner,
  AuthBrand,
  AuthLink,
  AuthShell,
  AuthTitle,
} from "../../../src/components/auth/AuthShell"
import { CodeBoxes } from "../../../src/components/auth/CodeBoxes"
import { whenConnected } from "../../../src/components/auth/whenConnected"
import { Btn, FieldLabel, T } from "../../../src/components/ui/ds"
import { RESET_CODE_LENGTH } from "../../../src/services/passwordRules"
import {
  clearPendingPasswordReset,
  getPendingPasswordReset,
  setPendingPasswordReset,
} from "../../../src/services/pendingPasswordReset"
import {
  markCodeRequest,
  secondsUntilNextCodeRequest,
} from "../../../src/services/passwordResetThrottleLogic"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { useAuthStore } from "../../../src/store/authStore"

export default function ResetPasswordCode() {
  // The in-memory store is the primary source (holds the secret challengeToken).
  // The ?email= route param is a fallback so the screen still renders correctly
  // after a web reload — the user just has to request a fresh code.
  const params = useLocalSearchParams<{ email?: string }>()
  const pending = getPendingPasswordReset()
  const displayEmail = pending?.email || (typeof params.email === "string" ? params.email : "")
  const [code, setCode] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [cooldown, setCooldown] = useState(() => secondsUntilNextCodeRequest())

  const router = useRouter()
  const client = getTerosClient()
  const { isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const submitting = useRef(false)
  const codeInput = useRef<TextInput>(null)

  // Nothing to reset (reload, deep link): start over from the forgot screen
  useEffect(() => {
    if (isAuthenticated) router.replace("/")
    else if (!pending && !displayEmail) router.replace("/(auth)/login/forgot")
  }, [isAuthenticated, pending, displayEmail])

  useEffect(() => {
    if (cooldown <= 0) return
    const id = setTimeout(() => setCooldown(secondsUntilNextCodeRequest()), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  if (!pending && !displayEmail) return null

  const settle = () => {
    setIsLoading(false)
    submitting.current = false
  }

  /**
   * Send one auth message and settle on its answer: `onChallenge` for a
   * `password_reset_required` event, `onError` for anything else.
   */
  const sendAuth = async (
    send: () => Promise<void>,
    onChallenge: (data: any) => void,
    onError: (err: unknown) => void,
  ) => {
    submitting.current = true
    setIsLoading(true)
    setError("")
    setNotice("")

    try {
      await whenConnected(client)
    } catch {
      setError(t("auth.requestTimedOut"))
      settle()
      return
    }

    const timeoutId = setTimeout(() => {
      cleanup()
      setError(t("auth.requestTimedOut"))
      settle()
    }, 10000)
    const cleanup = () => {
      clearTimeout(timeoutId)
      client.off("auth_error", onAuthError)
      client.off("password_reset_required", onPending)
    }
    const onAuthError = (err: unknown) => {
      cleanup()
      onError(err)
      settle()
    }
    const onPending = (data: any) => {
      cleanup()
      onChallenge(data)
      settle()
    }
    client.on("auth_error", onAuthError)
    client.on("password_reset_required", onPending)
    send().catch((err) => onAuthError(err?.message))
  }

  const rejectCode = (message: string) => {
    setError(message)
    setCode("")
    codeInput.current?.focus()
  }

  const checkCode = (digits: string) => {
    if (submitting.current || digits.length !== RESET_CODE_LENGTH) return
    if (!pending) {
      // Params-only mode (web reload lost the in-memory challenge): a code
      // from an earlier session cannot be used here — start over.
      setError(t("auth.resetSessionExpired"))
      return
    }
    void sendAuth(
      () => client.verifyPasswordResetCode(pending.challengeToken, digits),
      (data) => {
        if (!data?.codeVerified) return rejectCode(t("auth.invalidCode"))
        setPendingPasswordReset({ ...pending, code: digits })
        router.push("/(auth)/login/new-password")
      },
      (err) => rejectCode(String(err || "") || t("auth.invalidCode")),
    )
  }

  const handleResend = () => {
    if (cooldown > 0 || submitting.current || !pending) return

    // The throttle window starts when the request is sent, so the countdown
    // runs even if the answer never arrives (matches the forgot screen).
    markCodeRequest()
    setCooldown(secondsUntilNextCodeRequest())
    setCode("")

    void sendAuth(
      () => client.resendPasswordReset(pending.challengeToken),
      (data) => {
        setPendingPasswordReset({ ...pending, challengeToken: data.challengeToken, code: undefined })
        setNotice(t("auth.codeResent", { defaultValue: "We sent you a new code." }))
        codeInput.current?.focus()
      },
      (err) =>
        setError(
          String(err || "") ||
            t("auth.couldNotResendCode", { defaultValue: "Could not send a new code" }),
        ),
    )
  }

  return (
    <AuthShell footer testID="reset-password-card">
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
            clearPendingPasswordReset()
            if (router.canGoBack()) router.back()
            else router.replace("/(auth)/login/forgot")
          }}
          testID="reset-password-back"
        >
          {t("common.back")}
        </Btn>
      </View>

      <AuthTitle
        title={t("auth.checkYourEmail")}
        lead={t("auth.resetCodeLead", { email: displayEmail })}
      />

      <View style={{ marginTop: 24 }}>
        {error ? (
          <AuthBanner icon="warning-circle" testID="reset-password-error">
            {error}
          </AuthBanner>
        ) : null}
        {notice && !error ? (
          <AuthBanner tone="lock" icon="envelope-simple" testID="reset-password-notice">
            {notice}
          </AuthBanner>
        ) : null}
        {!pending && !error ? (
          <AuthBanner icon="clock" testID="reset-password-expired">
            {t("auth.resetSessionExpired")}
          </AuthBanner>
        ) : null}

        <FieldLabel style={{ marginBottom: 6 }}>{t("auth.resetCodeLabel")}</FieldLabel>
        <CodeBoxes
          value={code}
          onChange={(next) => {
            setCode(next)
            // An error about the code goes away as soon as the code is edited.
            if (error) setError("")
          }}
          onComplete={checkCode}
          error={!!error && code.length === 0}
          disabled={isLoading || !pending}
          autoFocus
          inputRef={codeInput}
          label={t("auth.resetCodeLabel")}
          testID="reset-password-code-input"
        />
        <T step="sm" tone="text2" style={{ marginTop: 10 }} testID="reset-password-hint">
          {isLoading ? t("auth.checkingCode") : t("auth.resetCodeHint")}
        </T>

        <Btn
          variant="primary"
          size="lg"
          full
          icon="arrow-right"
          onPress={() => checkCode(code)}
          disabled={isLoading || !pending || code.length !== RESET_CODE_LENGTH}
          loading={isLoading}
          style={{ marginTop: 20 }}
          testID="reset-password-submit"
        >
          {t("auth.continue")}
        </Btn>

        <View style={{ alignItems: "center", marginTop: 16 }}>
          {!pending ? (
            // No challenge in memory (web reload): a resend cannot work — go
            // back to the email step so the user gets a fresh challenge.
            <AuthLink
              onPress={() => {
                clearPendingPasswordReset()
                router.replace("/(auth)/login/forgot")
              }}
              testID="reset-password-back-to-forgot"
            >
              {t("auth.backToForgot")}
            </AuthLink>
          ) : cooldown > 0 ? (
            <T step="sm" tone="text2" testID="reset-password-cooldown">
              {t("auth.resendCodeIn", {
                defaultValue: "You can request another code in {{seconds}}s",
                seconds: cooldown,
              })}
            </T>
          ) : (
            <AuthLink onPress={handleResend} testID="reset-password-resend">
              {t("auth.resendCode", { defaultValue: "Send a new code" })}
            </AuthLink>
          )}
        </View>
      </View>
    </AuthShell>
  )
}
