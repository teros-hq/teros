import { useRouter } from "expo-router"
import React, { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { GoogleIcon, MicrosoftIcon } from "../../../src/components/SocialIcons"
import { useAuthStore } from "../../../src/store/authStore"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { useColors } from "../../../src/components/mca/primitives/useColors"
import { Btn, Ph, T } from "../../../src/components/ui/ds"
import {
  AuthBrand,
  AuthDivider,
  AuthHelp,
  AuthShell,
  AuthSwitch,
  AuthTitle,
  ProviderBtn,
} from "../../../src/components/auth/AuthShell"
import { useSocialAuth } from "../../../src/components/auth/useSocialAuth"
import { useDevAutologin } from "../../../src/components/auth/useDevAutologin"
import { wsUrl } from "../../../src/config/runtime"

export default function Login() {
  const [checkingAuth, setCheckingAuth] = useState(true)

  const router = useRouter()
  const client = getTerosClient()
  const { isAuthenticated } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  // If already authenticated, go straight to workspace
  useEffect(() => {
    if (isAuthenticated) {
      router.replace("/")
    } else {
      setCheckingAuth(false)
    }
  }, [isAuthenticated])

  // Ensure WebSocket is connected
  useEffect(() => {
    if (checkingAuth) return
    if (!client.isConnectedOrConnecting()) {
      const serverUrl = wsUrl()
      if (serverUrl) client.connect(serverUrl)
    }
  }, [client, checkingAuth])

  const social = useSocialAuth()
  // Local dev backend with TEROS_DEV_AUTOLOGIN=1: straight in, no form. Inert in prod.
  const devAutologin = useDevAutologin(!checkingAuth)

  if (checkingAuth || devAutologin !== "off") {
    return <View style={{ flex: 1, backgroundColor: c.bgFrame }} />
  }

  return (
    <AuthShell footer testID="login-card">
      <AuthBrand />
      <AuthTitle
        title={t("auth.signInTitle", { defaultValue: "Sign in to Teros" })}
        lead={t("auth.signInLead", {
          defaultValue: "Your team of agents picks up where you left off.",
        })}
      />

      {/* Providers — Google full width, GitHub / Microsoft half width (all live) */}
      <View style={{ gap: 8, marginTop: 24 }}>
        <ProviderBtn
          full
          icon={<GoogleIcon size={18} />}
          label={t("auth.continueWithGoogle")}
          onPress={social.google}
          testID="login-google"
        />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ProviderBtn
            icon={<Ph name="github-logo" size={17} color={c.text2} />}
            label="GitHub"
            onPress={social.github}
            testID="login-github"
          />
          <ProviderBtn
            icon={<MicrosoftIcon size={15} />}
            label="Microsoft"
            onPress={social.microsoft}
            testID="login-microsoft"
          />
        </View>
      </View>

      <AuthDivider label={t("auth.orWithEmail", { defaultValue: "or with your email" })} />

      {/* Email path — the visible strings are pinned by the smoke tests */}
      <Btn
        variant="primary"
        size="lg"
        full
        icon="envelope-simple"
        onPress={() => router.push("/(auth)/login/email")}
        testID="login-email"
      >
        {t("auth.signInWithEmail")}
      </Btn>

      <AuthHelp>
        <T step="12" tone="text2">
          {t("auth.helpLine", { defaultValue: "Can't get in? Write to " })}
          <T step="12" tone="text2" style={{ textDecorationLine: "underline" }}>
            soporte@teros.ai
          </T>
          {t("auth.helpLineTail", { defaultValue: " and the support team restores your access." })}
        </T>
      </AuthHelp>

      <AuthSwitch
        question={t("auth.dontHaveAccount")}
        action={t("auth.signUp")}
        onPress={() => router.push("/(auth)/login/signup")}
        testID="login-signup-link"
      />
    </AuthShell>
  )
}
