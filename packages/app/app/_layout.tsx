import { Slot, useRouter } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect, useRef } from "react"
import { Platform } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { I18nextProvider } from "react-i18next"
import { TamaguiProvider, Theme, YStack } from "tamagui"
import { TerosToastProvider } from "../src/components/Toast"
import i18n, { SUPPORTED_LOCALES } from "../src/i18n"
import { PostHogProvider } from "posthog-react-native"
import { initSentry, setUser as setSentryUser } from "../src/lib/sentry"
import { identifyUser, initAnalytics, resetAnalytics } from "../src/lib/analytics"
import { RootErrorBoundary } from "../src/components/RootErrorBoundary"
import { surface } from "../src/components/mca/primitives/colors"
import { getTerosClient } from "../src/services/terosClientSingleton"
import { useAuthStore } from "../src/store/authStore"
import { useFeatureFlagsStore } from "../src/store/featureFlagsStore"
import { useTilingStore } from "../src/store/tilingStore"
import { useUiPreferencesStore } from "../src/store/uiPreferencesStore"
import { useWorkspaceStore } from "../src/store/workspaceStore"
import { configurePersistedDriver } from "../src/services/storage"
import { registerFileOpenHandler } from "../src/services/fileOpener"
import { registerAllWindowTypes } from "../src/windows"
import config from "../tamagui.config"

// Initialize Sentry as early as possible
initSentry()

// Initialize PostHog product analytics (no-op without EXPO_PUBLIC_POSTHOG_KEY)
const posthogClient = initAnalytics()

// Register window types on module load
registerAllWindowTypes()

// Register file open handlers for known extensions.
// These run once at module load time, after window types are registered.
// The handler receives the file path and a contextId that is either:
//   - a channelId (when opened from a chat bubble)
//   - a workspaceId (when opened from the File Browser, which has no channelId)
// workspaceId values start with "work_" or "ws_"; everything else is a channelId.
function openMarkdownViewer(path: string, contextId: string) {
  const isWorkspaceId = contextId.startsWith('work_') || contextId.startsWith('ws_')
  useTilingStore.getState().openWindow(
    'markdown-viewer',
    isWorkspaceId
      ? { filePath: path, workspaceId: contextId }
      : { filePath: path, channelId: contextId },
    false,
  )
}
registerFileOpenHandler('md', openMarkdownViewer)
registerFileOpenHandler('markdown', openMarkdownViewer)

// Wire up PersistedDriver workspace getter — done at module load after stores are available
configurePersistedDriver(() => useWorkspaceStore.getState().activeWorkspaceId ?? null)

export default function RootLayout() {
  const router = useRouter()
  const cleanupRef = useRef<(() => void) | null>(null)
  const { hydrate, logout: authLogout, updateProfile, setProfileSynced } = useAuthStore()
  const theme = useUiPreferencesStore((s) => s.theme)

  // Mark app as mounted for the loading watchdog in index.html
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.body.classList.add('app-mounted')
    }
    return () => {
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        document.body.classList.remove('app-mounted')
      }
    }
  }, [])

  // Apply theme-aware web styles. Re-runs when the user toggles theme so
  // body bg, autofill colors and placeholder follow the active palette.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return

    const tokens = surface[theme]
    document.body.style.backgroundColor = tokens.bgPage
    document.body.style.color = tokens.text
    document.documentElement.style.backgroundColor = tokens.bgPage
    document.documentElement.setAttribute("data-theme", theme)

    let viewport = document.querySelector('meta[name="viewport"]')
    if (!viewport) {
      viewport = document.createElement("meta")
      viewport.setAttribute("name", "viewport")
      document.head.appendChild(viewport)
    }
    // viewport-fit=cover is required: without it iOS reports
    // env(safe-area-inset-*) = 0 and the whole UI loses the bottom safe zone
    // (composer hidden behind the gesture bar in the installed PWA). The
    // static HTML already ships it; this runtime rewrite used to drop it.
    viewport.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover",
    )

    const autofillBg = theme === "dark"
      ? "rgba(0, 0, 0, 0.95)"
      : "rgba(252, 251, 248, 0.95)"
    const style = document.createElement("style")
    style.dataset.terosTheme = "1"
    style.textContent = `
      input:-webkit-autofill,
      input:-webkit-autofill:hover,
      input:-webkit-autofill:focus,
      input:-webkit-autofill:active {
        -webkit-box-shadow: 0 0 0 30px ${autofillBg} inset !important;
        -webkit-text-fill-color: ${tokens.text} !important;
        caret-color: ${tokens.text} !important;
        transition: background-color 5000s ease-in-out 0s;
      }
      input::placeholder { color: ${tokens.text3} !important; }
      input:focus { outline: none !important; }
      [data-no-callout], [data-no-callout] * { -webkit-touch-callout: none !important; }
      .split-handle {
        touch-action: none;
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
      }
      .tab-bar {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        touch-action: manipulation;
      }
      .content-area {
        -webkit-user-select: text;
        user-select: text;
      }
    `
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, [theme])

  // Initialize session from persisted storage, then connect WebSocket
  useEffect(() => {
    const client = getTerosClient()

    const init = async () => {
      // Hydrate auth store — single source of truth, no direct storage reads elsewhere
      await hydrate()

      const { user: hydratedUser } = useAuthStore.getState()
      if (hydratedUser?.locale && SUPPORTED_LOCALES.includes(hydratedUser.locale as any)) {
        i18n.changeLanguage(hydratedUser.locale)
      }

      const { sessionToken, user } = useAuthStore.getState()

      if (!sessionToken || !user) {
        console.log("📍 No saved session")
        return
      }

      console.log("🔄 Restoring session:", user.email)
      client.setSessionToken(sessionToken)
      setSentryUser({ id: user.userId, email: user.email, username: user.name })
      identifyUser({ userId: user.userId, email: user.email, name: user.name })

      const serverUrl = process.env.EXPO_PUBLIC_WS_URL
      if (!serverUrl) {
        console.error("EXPO_PUBLIC_WS_URL is not defined")
        return
      }

      console.log("🔌 Connecting to Teros:", serverUrl)
      client.connect(serverUrl)

      const onConnected = async () => {
        console.log("✅ Connected to Teros")
        // Sync onboardingCompletedAt and termsAcceptedAt from backend — these may be
        // missing from localStorage if the user completed onboarding in a previous session.
        try {
          const profile = await client.profile.getProfile()
          // Only sync fields that have values — never overwrite local state with undefined.
          // This prevents race conditions where the backend hasn't processed a recent
          // mutation (complete-onboarding, accept-terms) yet.
          const updates: Record<string, any> = {}
          if (profile.onboardingCompletedAt) updates.onboardingCompletedAt = profile.onboardingCompletedAt
          if (profile.termsAcceptedAt) updates.termsAcceptedAt = profile.termsAcceptedAt
          if (profile.locale && SUPPORTED_LOCALES.includes(profile.locale as any)) {
            updates.locale = profile.locale
            i18n.changeLanguage(profile.locale)
          }
          // Sync lastChangelogSeen so the "What's New" modal knows which entries
          // the user has already seen. Always sync (including undefined → not seen).
          updates.lastChangelogSeen = profile.lastChangelogSeen
          updateProfile(updates)
        } catch (err) {
          console.warn("[Layout] Failed to sync profile from backend:", err)
        } finally {
          // Always mark profile as synced so the onboarding guard can proceed
          setProfileSynced()
        }

        // ── Feature flags initialization ──────────────────────────────────────
        // Fetch all resolved flags for the current context and populate the store.
        try {
          useFeatureFlagsStore.getState().setLoading(true)
          const flags = await client.featureFlags.getAll()
          useFeatureFlagsStore.getState().setFlags(flags.flags)
          console.log("🏳️ Feature flags loaded:", Object.keys(flags).length)
        } catch (err) {
          console.warn("[Layout] Failed to load feature flags:", err)
          useFeatureFlagsStore.getState().setError("Failed to load feature flags")
        }
      }
      const onDisconnected = () => console.log("❌ Disconnected from Teros")
      const onAuthFailed = async (data: any) => {
        console.log("🔐 Auth failed:", data)
        useFeatureFlagsStore.getState().clear()
        await authLogout()
        client.setSessionToken("")
        setSentryUser(null)
        resetAnalytics()
        router.replace("/(auth)/login")
      }
      const onFeatureFlagsChanged = (data: any) => {
        const changes = data?.changes as Array<{ flagKey: string; value: unknown; source: string }> | undefined
        if (changes && changes.length > 0) {
          useFeatureFlagsStore.getState().updateFlags(changes)
          console.log("🏳️ Feature flags updated:", changes.map((c) => c.flagKey).join(", "))
        }
      }

      client.on("connected", onConnected)
      client.on("disconnected", onDisconnected)
      client.on("auth_failed", onAuthFailed)
      client.on("featureFlags.changed", onFeatureFlagsChanged)

      cleanupRef.current = () => {
        client.off("connected", onConnected)
        client.off("disconnected", onDisconnected)
        client.off("auth_failed", onAuthFailed)
        client.off("featureFlags.changed", onFeatureFlagsChanged)
      }
    }

    init()

    // Re-hydrate when auth storage changes in another tab (e.g. OAuth popup)
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const handleStorageChange = async (e: StorageEvent) => {
        if (e.key === "teros-auth" && e.newValue && !client.isConnectedOrConnecting()) {
          console.log("🔄 Auth storage changed externally, re-hydrating")
          await hydrate()
          const { sessionToken, user } = useAuthStore.getState()
          if (sessionToken && user) {
            client.setSessionToken(sessionToken)
            setSentryUser({ id: user.userId, email: user.email, username: user.name })
            identifyUser({ userId: user.userId, email: user.email, name: user.name })
            const serverUrl = process.env.EXPO_PUBLIC_WS_URL
            if (serverUrl) client.connect(serverUrl)
          }
        }
      }

      window.addEventListener("storage", handleStorageChange)
      return () => {
        window.removeEventListener("storage", handleStorageChange)
        cleanupRef.current?.()
      }
    }

    return () => { cleanupRef.current?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const appContent = (
    <I18nextProvider i18n={i18n}>
      <TerosToastProvider>
        <YStack flex={1} backgroundColor="$background">
          <StatusBar style={theme === "dark" ? "light" : "dark"} backgroundColor={surface[theme].bgPage} />
          <Slot />
        </YStack>
      </TerosToastProvider>
    </I18nextProvider>
  )

  return (
    <RootErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <TamaguiProvider config={config} defaultTheme={theme}>
            <Theme name={theme}>
              {posthogClient ? (
                <PostHogProvider
                  client={posthogClient}
                  // captureTouches OFF a propósito: el autocapture de taps captura el
                  // text content de la jerarquía de vistas (burbujas de chat, nombres de
                  // archivo, PII en menús) → no exfiltrar contenido de conversación a un
                  // tercero. Los eventos de producto se capturan con track() explícito;
                  // captureScreens solo registra nombres de ruta.
                  autocapture={{ captureTouches: false, captureScreens: true }}
                >
                  {appContent}
                </PostHogProvider>
              ) : (
                appContent
              )}
            </Theme>
          </TamaguiProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </RootErrorBoundary>
  )
}
