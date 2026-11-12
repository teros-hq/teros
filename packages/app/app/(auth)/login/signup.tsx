import { useRouter } from "expo-router"
import React, { useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Linking, Pressable, TextInput, View } from "react-native"
import { GoogleIcon, MicrosoftIcon } from "../../../src/components/SocialIcons"
import { useColors } from "../../../src/components/mca/primitives/useColors"
import { normalizeAuthUser, useAuthStore } from "../../../src/store/authStore"
import { setUser as setSentryUser } from "../../../src/lib/sentry"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { setPendingEmailVerification } from "../../../src/services/pendingEmailVerification"
import { Btn, Check, Field, FieldLabel, IconBtn, Ph, T } from "../../../src/components/ui/ds"
import {
  AuthBanner,
  AuthBrand,
  AuthDivider,
  AuthShell,
  AuthSwitch,
  AuthTitle,
  ProviderBtn,
} from "../../../src/components/auth/AuthShell"
import { useSocialAuth } from "../../../src/components/auth/useSocialAuth"
import { peekInviteParams } from "../../../src/lib/inviteParams"
import { wsUrl } from "../../../src/config/runtime"

export default function SignUp() {
  const [name, setName] = useState("")
  // MUW-14 Fase 2: prefill from a stashed invite (?invite_email= from the
  // invitation email CTA) — the invitee signs up with the invited email.
  const [email, setEmail] = useState(() => peekInviteParams()?.inviteEmail ?? "")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")

  const router = useRouter()
  const client = getTerosClient()
  const { login: authLogin, isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  // The terms gate EVERY way in: a social button without the box ticked
  // shows the same error the email path does and opens nothing.
  const social = useSocialAuth({
    intent: "signup",
    canStart: () => {
      if (acceptedTerms) {
        setError("")
        return true
      }
      setError(t("auth.acceptTerms"))
      return false
    },
  })

  const emailRef = useRef<TextInput>(null)
  const passwordRef = useRef<TextInput>(null)
  const confirmRef = useRef<TextInput>(null)

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
        client.off("email_verification_required", verificationHandler)

        // login() persists to storage internally
        const { user, sessionToken } = normalizeAuthUser(data, {
          email: email.trim(),
          name: name.trim(),
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
        setError(String(err || "") || t("auth.couldNotCreateAccount"))
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
          displayName: name.trim(),
          method: "signup",
        })
        setIsLoading(false)
        router.push("/(auth)/login/verify")
      }

      client.on("authenticated", authSuccessHandler)
      client.on("auth_error", authErrorHandler)
      client.on("email_verification_required", verificationHandler)

      await client.register(email.trim(), password, name.trim())
    } catch (err: any) {
      setError(err.message || t("auth.signUpFailed"))
      setIsLoading(false)
    }
  }

  const eye = (shown: boolean, toggle: () => void) => (
    <IconBtn
      plain
      sm
      icon={shown ? "eye-slash" : "eye"}
      onPress={toggle}
      disabled={isLoading}
      style={{ marginRight: -6 }}
    />
  )

  return (
    <AuthShell footer testID="signup-card">
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
          testID="signup-back"
        >
          {t("common.back")}
        </Btn>
      </View>

      <AuthTitle
        title={t("auth.createYourAccount")}
        lead={t("auth.signUpLead", { defaultValue: "A private space for you and your agents." })}
      />

      <View style={{ marginTop: 24 }}>
        {/* Alpha notice — the quiet "lock" banner of the prototype */}
        <AuthBanner tone="lock" icon="flask">
          <T step="sm">{t("auth.earlyAlpha")}</T>
          <T step="12" tone="text2" style={{ marginTop: 2 }}>
            {t("auth.earlyAlphaDescription")}
          </T>
        </AuthBanner>

        {error ? (
          <AuthBanner icon="warning-circle" testID="signup-error">
            {error}
          </AuthBanner>
        ) : null}

        {/* Providers — the same row as the sign-in card: most people land
            here to create an account with the method they already use. */}
        <View style={{ gap: 8 }}>
          <ProviderBtn
            full
            icon={<GoogleIcon size={18} />}
            label={t("auth.continueWithGoogle")}
            onPress={social.google}
            testID="signup-google"
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <ProviderBtn
              icon={<Ph name="github-logo" size={17} color={c.text2} />}
              label="GitHub"
              onPress={social.github}
              testID="signup-github"
            />
            <ProviderBtn
              icon={<MicrosoftIcon size={15} />}
              label="Microsoft"
              onPress={social.microsoft}
              testID="signup-microsoft"
            />
          </View>
        </View>

        <AuthDivider label={t("auth.orWithEmail", { defaultValue: "or with your email" })} />

        {/* Name */}
        <View style={{ marginBottom: 14 }}>
          <FieldLabel style={{ marginBottom: 6 }}>{t("auth.fullNamePlaceholder")}</FieldLabel>
          <Field
            lg
            icon="user"
            placeholder={t("auth.fullNamePlaceholder")}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            autoCorrect={false}
            editable={!isLoading}
            returnKeyType="next"
            onSubmitEditing={() => emailRef.current?.focus()}
            autoComplete="name"
            testID="signup-name-input"
          />
        </View>

        {/* Email */}
        <View style={{ marginBottom: 14 }}>
          <FieldLabel style={{ marginBottom: 6 }}>{t("auth.emailPlaceholder")}</FieldLabel>
          <Field
            lg
            inputRef={emailRef}
            icon="envelope-simple"
            placeholder={t("auth.emailPlaceholder")}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!isLoading}
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            autoComplete="email"
            testID="signup-email-input"
          />
        </View>

        {/* Password */}
        <View style={{ marginBottom: 14 }}>
          <FieldLabel style={{ marginBottom: 6 }}>{t("auth.passwordPlaceholder")}</FieldLabel>
          <Field
            lg
            inputRef={passwordRef}
            icon="lock-simple"
            placeholder={t("auth.passwordMinCharsPlaceholder")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isLoading}
            returnKeyType="next"
            onSubmitEditing={() => confirmRef.current?.focus()}
            autoComplete="new-password"
            testID="signup-password-input"
            right={eye(showPassword, () => setShowPassword(!showPassword))}
          />
        </View>

        {/* Confirm Password */}
        <View style={{ marginBottom: 14 }}>
          <FieldLabel style={{ marginBottom: 6 }}>
            {t("auth.confirmPasswordPlaceholder")}
          </FieldLabel>
          <Field
            lg
            inputRef={confirmRef}
            icon="lock-simple"
            placeholder={t("auth.confirmPasswordPlaceholder")}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry={!showConfirmPassword}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isLoading}
            returnKeyType="done"
            onSubmitEditing={handleSignUp}
            autoComplete="new-password"
            testID="signup-confirm-input"
            right={eye(showConfirmPassword, () => setShowConfirmPassword(!showConfirmPassword))}
          />
        </View>

        {/* Terms & Conditions */}
        <Pressable
          onPress={() => setAcceptedTerms(!acceptedTerms)}
          disabled={isLoading}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acceptedTerms }}
          testID="signup-terms"
          style={({ pressed }) => [
            {
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 12,
              paddingVertical: 4,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <View style={{ marginTop: 1 }}>
            <Check on={acceptedTerms} />
          </View>
          <T step="sm" tone="text2" style={{ flex: 1, lineHeight: 19 }}>
            <Trans
              i18nKey="auth.termsCheckbox"
              components={{
                1: <T step="sm" tone="text" />,
                2: (
                  <T
                    step="sm"
                    tone="accent"
                    style={{ textDecorationLine: "underline" }}
                    onPress={(e: any) => {
                      e.stopPropagation()
                      Linking.openURL("https://teros.ai/terms")
                    }}
                  />
                ),
              }}
            />
          </T>
        </Pressable>

        <Btn
          variant="primary"
          size="lg"
          full
          icon="arrow-right"
          onPress={handleSignUp}
          disabled={isLoading}
          loading={isLoading}
          style={{ marginTop: 14 }}
          testID="signup-submit"
        >
          {t("auth.createAccount")}
        </Btn>
      </View>

      <AuthSwitch
        question={t("auth.alreadyHaveAccount")}
        action={t("auth.signIn")}
        onPress={() => router.back()}
        testID="signup-signin-link"
      />
    </AuthShell>
  )
}
