/**
 * Welcome screen — shown once to every user who hasn't accepted T&C yet.
 * Appears after any auth method (Google, email, signup) if termsAcceptedAt is not set.
 */

import { useRouter } from "expo-router"
import React, { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Linking, Pressable, View } from "react-native"
import { useToast } from "../../../src/components/Toast"
import { useAuthStore } from "../../../src/store/authStore"
import { getTerosClient } from "../../../src/services/terosClientSingleton"
import { useColors } from "../../../src/components/mca/primitives/useColors"
import { Badge, Btn, Check, Ph, T } from "../../../src/components/ui/ds"
import { AuthBrand, AuthShell, AuthTitle } from "../../../src/components/auth/AuthShell"
import { useEdition } from "../../../src/config/edition"

const NOTICE_ICONS = ["shuffle", "warning-diamond", "bug", "chat-teardrop-text"]
// ONB-REQ-4: self-hosted gets its own notes — no waitlist or hosted-beta copy.
const SELF_HOSTED_NOTICE_ICONS = ["hard-drives", "scales", "bug", "database"]
const LICENSE_URL = "https://github.com/teros-hq/teros/blob/main/LICENSE.md"

export default function Welcome() {
  const [accepted, setAccepted] = useState(false)
  const edition = useEdition()
  const [isLoading, setIsLoading] = useState(false)

  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const { user, updateProfile } = useAuthStore()
  const { t } = useTranslation()
  const c = useColors()

  const handleContinue = async () => {
    if (!accepted) return

    setIsLoading(true)
    try {
      await client.send("profile", "accept-terms", {})

      // updateProfile() persists to storage internally
      updateProfile({ termsAcceptedAt: new Date().toISOString() })

      router.replace("/(auth)/login/onboarding")
    } catch (err: any) {
      console.error("Failed to accept terms:", err)
      toast.error(t("auth.error"), t("auth.couldNotSavePreferences"))
      setIsLoading(false)
    }
  }

  const selfHosted = edition === "self-hosted"
  const notices = selfHosted
    ? [
        t("auth.selfHostedNotice1"),
        t("auth.selfHostedNotice2"),
        t("auth.selfHostedNotice3"),
        t("auth.selfHostedNotice4"),
      ]
    : [t("auth.betaNotice1"), t("auth.betaNotice2"), t("auth.betaNotice3"), t("auth.betaNotice4")]
  const noticeIcons = selfHosted ? SELF_HOSTED_NOTICE_ICONS : NOTICE_ICONS

  return (
    <AuthShell wide footer testID="welcome-card">
      <AuthBrand />

      <Badge
        tone="m"
        pill
        icon={selfHosted ? "hard-drives" : "flask"}
        cap
        style={{ marginBottom: 14, height: 26, paddingHorizontal: 11 }}
      >
        {selfHosted ? t("auth.selfHosted") : t("auth.privateBeta")}
      </Badge>

      <AuthTitle
        title={user?.name ? t("auth.welcomeUser", { name: user.name }) : t("auth.welcome")}
        lead={selfHosted ? t("auth.selfHostedLead") : t("auth.notProductionReady")}
      />

      {/* What to expect — one card of rows */}
      <View
        style={{
          marginTop: 24,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: c.border,
          overflow: "hidden",
        }}
      >
        {notices.map((item, i) => (
          <View
            key={item}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 12,
              paddingHorizontal: 16,
              borderTopWidth: i > 0 ? 1 : 0,
              borderTopColor: c.border,
            }}
          >
            <Ph name={noticeIcons[i] ?? "info"} size={16} color={c.text3} />
            <T step="sm" style={{ flex: 1, lineHeight: 19 }}>
              {item}
            </T>
          </View>
        ))}
      </View>

      {/* T&C check row */}
      <Pressable
        onPress={() => setAccepted(!accepted)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: accepted }}
        testID="welcome-terms"
        style={({ pressed }) => [
          {
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 12,
            marginTop: 20,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <View style={{ marginTop: 1 }}>
          <Check on={accepted} />
        </View>
        <T step="sm" tone="text2" style={{ flex: 1, lineHeight: 19 }}>
          <Trans
            i18nKey={selfHosted ? "auth.termsCheckboxSelfHosted" : "auth.termsCheckboxWelcome"}
            components={{
              1: (
                <T
                  step="sm"
                  tone="accent"
                  style={{ textDecorationLine: "underline" }}
                  onPress={(e: any) => {
                    e.stopPropagation()
                    Linking.openURL(selfHosted ? LICENSE_URL : "https://teros.ai/terms")
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
        iconRight="arrow-right"
        onPress={handleContinue}
        disabled={!accepted || isLoading}
        loading={isLoading}
        style={{ marginTop: 22 }}
        testID="welcome-continue"
      >
        {t("auth.getStarted")}
      </Btn>
    </AuthShell>
  )
}
