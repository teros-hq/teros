/**
 * Password reset, step 2 — the new password.
 *
 * Reached only with a code the server already confirmed (step 1). Every rule
 * is shown and re-judged on each keystroke, so a disabled button always has a
 * visible reason. @spec PWR-REQ-8 PWR-REQ-9 PWR-REQ-10 PWR-REQ-11
 */
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
import { whenConnected } from "../../../src/components/auth/whenConnected"
import { useColors } from "../../../src/components/mca/primitives/useColors"
import { Btn, Field, FieldLabel, IconBtn, Ph, T } from "../../../src/components/ui/ds"
import { setUser as setSentryUser } from "../../../src/lib/sentry"
import {
  MIN_PASSWORD_LENGTH,
  passwordRules,
  type RuleState,
} from "../../../src/services/passwordRules"
import {
  clearPendingPasswordReset,
  getPendingPasswordReset,
} from "../../../src/services/pendingPasswordReset"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { normalizeAuthUser, useAuthStore } from "../../../src/store/authStore"

/** One rule line: a state icon, the rule, and an optional counter on the right. */
function Rule({
  state,
  children,
  counter,
  testID,
}: {
  state: RuleState
  children: string
  counter?: string
  testID?: string
}) {
  const c = useColors()
  const color = state === "met" ? c.tint.g.tx : state === "failed" ? c.tint.r.tx : c.text2
  const icon = state === "met" ? "check-circle" : state === "failed" ? "x-circle" : "circle"
  return (
    <View
      testID={testID}
      accessibilityLabel={`${children}: ${state}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}
    >
      <Ph name={icon} size={16} color={color} />
      <T step="sm" color={color} style={{ flex: 1, minWidth: 0 }}>
        {children}
      </T>
      {counter ? (
        <T step="sm" color={color} style={{ fontVariant: ["tabular-nums"] }}>
          {counter}
        </T>
      ) : null}
    </View>
  )
}

export default function ResetPasswordNew() {
  const pending = getPendingPasswordReset()
  const ready = !!pending?.code
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")

  const router = useRouter()
  const client = getTerosClient()
  const { login: authLogin, isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const submitting = useRef(false)

  // No confirmed code in memory (reload, deep link): start over.
  useEffect(() => {
    if (isAuthenticated) router.replace("/")
    else if (!ready) router.replace("/(auth)/login/forgot")
  }, [isAuthenticated, ready])

  if (!pending?.code) return null
  const { challengeToken, code, email } = pending

  const rules = passwordRules(newPassword, confirmPassword)

  const settle = () => {
    setIsLoading(false)
    submitting.current = false
  }

  const handleReset = async () => {
    if (!rules.canSubmit || submitting.current) return

    submitting.current = true
    setIsLoading(true)
    setError("")

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
      client.off("authenticated", onSuccess)
      client.off("auth_error", onAuthError)
    }
    const onSuccess = (data: any) => {
      cleanup()
      clearPendingPasswordReset()
      // login() persists to storage internally
      const { user, sessionToken } = normalizeAuthUser(data, {
        email,
        name: email.split("@")[0],
      })
      authLogin(user, sessionToken)
      setSentryUser({ id: user.userId, email: user.email, username: user.name })
      client.setSessionToken(sessionToken)
      router.replace("/")
      settle()
    }
    const onAuthError = (err: unknown) => {
      cleanup()
      setError(
        String(err || "") || t("auth.resetRequestFailed", { defaultValue: "Could not reset the password" }),
      )
      settle()
    }
    client.on("authenticated", onSuccess)
    client.on("auth_error", onAuthError)
    client.resetPassword(challengeToken, code, newPassword).catch((err) => onAuthError(err?.message))
  }

  // An error goes away as soon as the user edits a password field.
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value)
    if (error) setError("")
  }

  return (
    <AuthShell footer testID="new-password-card">
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
            if (router.canGoBack()) router.back()
            else router.replace("/(auth)/login/forgot")
          }}
          testID="new-password-back"
        >
          {t("common.back")}
        </Btn>
      </View>

      <AuthTitle
        title={t("auth.newPasswordTitle")}
        lead={t("auth.codeVerifiedFor", { email })}
      />

      <View style={{ marginTop: 24 }}>
        {error ? (
          <AuthBanner icon="warning-circle" testID="new-password-error">
            <T step="sm" tone="text">
              {error}
            </T>
            <AuthLink
              onPress={() => {
                clearPendingPasswordReset()
                router.replace("/(auth)/login/forgot")
              }}
              testID="new-password-request-code"
            >
              {t("auth.backToForgot")}
            </AuthLink>
          </AuthBanner>
        ) : null}

        <View style={{ marginBottom: 16 }}>
          <FieldLabel style={{ marginBottom: 6 }}>
            {t("auth.newPassword", { defaultValue: "New password" })}
          </FieldLabel>
          <Field
            lg
            icon="lock-simple"
            placeholder={t("auth.passwordMinCharsPlaceholder")}
            value={newPassword}
            onChangeText={edit(setNewPassword)}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isLoading}
            autoComplete="new-password"
            autoFocus
            error={rules.minLength === "failed"}
            testID="new-password-input"
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
          <Rule
            state={rules.minLength}
            // The count is the reason the rule fails; once met it says nothing.
            counter={rules.minLength === "failed" ? `${rules.length}/${MIN_PASSWORD_LENGTH}` : undefined}
            testID="new-password-rule-length"
          >
            {t("auth.ruleMinLength")}
          </Rule>
        </View>

        <View style={{ marginBottom: 16 }}>
          <FieldLabel style={{ marginBottom: 6 }}>
            {t("auth.confirmPassword", { defaultValue: "Confirm password" })}
          </FieldLabel>
          <Field
            lg
            icon="lock-simple"
            placeholder={t("auth.confirmPassword", { defaultValue: "Confirm password" })}
            value={confirmPassword}
            onChangeText={edit(setConfirmPassword)}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isLoading}
            autoComplete="new-password"
            onSubmitEditing={handleReset}
            error={rules.match === "failed"}
            testID="new-password-confirm-input"
          />
          <Rule state={rules.match} testID="new-password-rule-match">
            {t("auth.ruleMatch")}
          </Rule>
        </View>

        <Btn
          variant="primary"
          size="lg"
          full
          icon="arrow-right"
          onPress={handleReset}
          disabled={isLoading || !rules.canSubmit}
          loading={isLoading}
          style={{ marginTop: 6 }}
          testID="new-password-submit"
        >
          {t("auth.resetAndSignIn")}
        </Btn>

        <T step="sm" tone="text2" center style={{ marginTop: 14 }}>
          {t("auth.resetSignsOut")}
        </T>
      </View>
    </AuthShell>
  )
}
