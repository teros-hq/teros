/**
 * SocialSignIn — the provider buttons of the sign-in and sign-up screens, and
 * the "or with your email" divider under them. It draws a button only for the
 * providers the backend offers (spec SIGNM):
 *
 *   one provider     one full-width button, "Continue with <provider>"
 *   two providers    one row of two halves, short names
 *   three providers  Google full width, GitHub and Microsoft in a row of halves
 *   none, or the answer has not arrived: nothing, not even the divider
 */
import type React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import {
  enabledSocialProviders,
  type SignInMethods,
  type SocialProvider,
} from "../../lib/sign-in-methods"
import { useColors } from "../mca/primitives/useColors"
import { GoogleIcon, MicrosoftIcon } from "../SocialIcons"
import { Ph } from "../ui/ds"
import { AuthDivider, ProviderBtn } from "./AuthShell"

const SHORT_NAME: Record<SocialProvider, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
}

const LONG_LABEL_KEY: Record<SocialProvider, string> = {
  google: "auth.continueWithGoogle",
  github: "auth.continueWithGitHub",
  microsoft: "auth.continueWithMicrosoft",
}

/**
 * @spec SIGNM-REQ-4 SIGNM-REQ-5 SIGNM-REQ-6 SIGNM-REQ-7
 */
export function SocialSignIn({
  methods,
  onPress,
  testIDPrefix,
  marginTop = 0,
  emptyGap = 0,
}: {
  /** What the backend offers; `null` while the answer is on its way. */
  methods: SignInMethods | null
  onPress: Record<SocialProvider, () => void>
  /** `login` or `signup`: buttons get `<prefix>-google`, `<prefix>-github`, … */
  testIDPrefix: string
  marginTop?: number
  /** Space to keep above what follows when no button is drawn (the block's own margin is gone). */
  emptyGap?: number
}) {
  const { t } = useTranslation()
  const c = useColors()
  const providers = methods ? enabledSocialProviders(methods) : []
  if (providers.length === 0) {
    return emptyGap > 0 ? (
      <View style={{ height: emptyGap }} testID={`${testIDPrefix}-providers-gap`} />
    ) : null
  }

  const icon: Record<SocialProvider, React.ReactNode> = {
    google: <GoogleIcon size={18} />,
    github: <Ph name="github-logo" size={17} color={c.text2} />,
    microsoft: <MicrosoftIcon size={15} />,
  }
  const button = (provider: SocialProvider, wide: boolean) => (
    <ProviderBtn
      key={provider}
      full={wide}
      icon={icon[provider]}
      label={wide ? t(LONG_LABEL_KEY[provider]) : SHORT_NAME[provider]}
      onPress={onPress[provider]}
      testID={`${testIDPrefix}-${provider}`}
    />
  )
  // One or three providers start with a full-width button; whatever is left
  // (two providers, or the last two of three) shares one row.
  const lead = providers.length === 2 ? [] : providers.slice(0, 1)
  const row = providers.length === 2 ? providers : providers.slice(1)

  return (
    <>
      <View style={{ gap: 8, marginTop }} testID={`${testIDPrefix}-providers`}>
        {lead.map((provider) => button(provider, true))}
        {row.length > 0 ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            {row.map((provider) => button(provider, false))}
          </View>
        ) : null}
      </View>
      <AuthDivider label={t("auth.orWithEmail", { defaultValue: "or with your email" })} />
    </>
  )
}
