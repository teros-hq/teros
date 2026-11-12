/**
 * useSocialAuth — the OAuth popup flows (Google · Microsoft · GitHub) shared
 * by the sign-in and sign-up cards. On the web a popup runs the provider's
 * connect route and posts `oauth_result` back; on native the system browser
 * opens it. On success the session is stored and the socket authenticated.
 */
import { useRouter } from "expo-router"
import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Platform } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { normalizeAuthUser, useAuthStore } from "../../store/authStore"
import { useToast } from "../Toast"
import { wsUrl } from "../../config/runtime"

export type SocialProvider = "google" | "microsoft" | "github"

const POPUP: Record<SocialProvider, string> = {
  google: "width=500,height=600,menubar=no,toolbar=no",
  microsoft: "width=500,height=650,menubar=no,toolbar=no",
  github: "width=500,height=650,menubar=no,toolbar=no",
}

const FAIL_KEY: Record<SocialProvider, string> = {
  google: "auth.couldNotSignInGoogle",
  microsoft: "auth.couldNotSignInMicrosoft",
  github: "auth.couldNotSignInGitHub",
}

export function useSocialAuth(options?: {
  /** Checked before anything opens; returning false aborts quietly. */
  canStart?: () => boolean
  /** Analytics tag for a successful sign-in ("login" | "signup"). */
  intent?: "login" | "signup"
}) {
  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const { login } = useAuthStore()
  const { t } = useTranslation()
  const canStart = options?.canStart
  const intent = options?.intent ?? "login"

  const start = useCallback(
    async (provider: SocialProvider) => {
      if (canStart && !canStart()) return
      try {
        const serverUrl = wsUrl() || ""
        const backendUrl = serverUrl
          .replace(/^wss:/, "https:")
          .replace(/^ws:/, "http:")
          .replace(/\/ws\/?$/, "")
        const oauthUrl = `${backendUrl}/auth/${provider}/connect`

        if (Platform.OS !== "web") {
          const { Linking } = await import("react-native")
          await Linking.openURL(oauthUrl)
          return
        }

        const popup = window.open(oauthUrl, `${provider}_oauth`, POPUP[provider])
        if (!popup) {
          toast.error(t("auth.error"), t("auth.popupBlocked"))
          return
        }

        const handleMessage = async (event: MessageEvent) => {
          if (event.data?.type !== "oauth_result") return
          window.removeEventListener("message", handleMessage)

          if (event.data.success && event.data.token) {
            // login() persists to storage internally
            const { user, sessionToken } = normalizeAuthUser({
              ...event.data,
              userId: event.data.userId,
              token: event.data.token,
            })
            login(user, sessionToken)

            if (client.isConnected()) {
              try {
                await client.authenticateWithToken(event.data.token)
              } catch (authError) {
                console.error("Failed to authenticate WebSocket:", authError)
              }
            } else {
              client.setSessionToken(event.data.token)
            }
            router.replace("/")
          } else {
            toast.error(t("auth.signInFailed"), event.data.error || t(FAIL_KEY[provider]))
          }
        }
        window.addEventListener("message", handleMessage)
      } catch (error) {
        console.error(`${provider} auth error:`, error)
        toast.error(t("auth.error"), t(FAIL_KEY[provider]))
      }
    },
    [canStart, client, intent, login, router, t, toast],
  )

  return {
    google: useCallback(() => start("google"), [start]),
    microsoft: useCallback(() => start("microsoft"), [start]),
    github: useCallback(() => start("github"), [start]),
  }
}
