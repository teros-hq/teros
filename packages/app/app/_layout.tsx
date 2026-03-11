import { Slot, useRouter, useSegments } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { TamaguiProvider, Theme, YStack } from "tamagui"
import { TerosToastProvider } from "../src/components/Toast"
import { initSentry, setUser as setSentryUser } from "../src/lib/sentry"
import { STORAGE_KEYS, storage } from "../src/services/storage"
import { TerosClient } from "../src/services/TerosClient"
import { useAuthStore } from "../src/store/authStore"
import { registerAllWindowTypes } from "../src/windows"
import config from "../tamagui.config"

// Initialize Sentry as early as possible
initSentry()

// Registrar tipos de ventana al cargar el módulo
registerAllWindowTypes()

// Global Teros client instance
let globalClient: TerosClient | null = null

export function getTerosClient(): TerosClient {
  if (!globalClient) {
    globalClient = new TerosClient()
  }
  return globalClient
}

// Expose the client in the browser console for debugging.
// Use with care — this exposes the session token in JS context.
if (typeof window !== "undefined") {
  try {
    ;(window as any).teros = getTerosClient()
  } catch (e) {
    // Ignore in non-browser environments
  }
}

export default function RootLayout() {
  const [client] = useState(() => getTerosClient())
  const [isRestoringSession, setIsRestoringSession] = useState(true)

  const router = useRouter()
  const segments = useSegments()

  // Use auth store for user state
  const { user, login: authLogin, logout: authLogout } = useAuthStore()
  const cleanupRef = useRef<(() => void) | null>(null)

  // Apply dark theme, disable zoom and fix autofill styles for web
  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.body.style.backgroundColor = "#000000"
      document.body.style.color = "#FFFFFF"
      document.documentElement.style.backgroundColor = "#000000"

      // Disable zoom on mobile web
      let viewport = document.querySelector('meta[name="viewport"]')
      if (!viewport) {
        viewport = document.createElement("meta")
        viewport.setAttribute("name", "viewport")
        document.head.appendChild(viewport)
      }
      viewport.setAttribute(
        "content",
        "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
      )

      // Fix autofill styles for dark theme and touch behavior
      const style = document.createElement("style")
      style.textContent = `
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus,
        input:-webkit-autofill:active {
          -webkit-box-shadow: 0 0 0 30px rgba(0, 0, 0, 0.95) inset !important;
          -webkit-text-fill-color: #E4E4E7 !important;
          caret-color: #E4E4E7 !important;
          transition: background-color 5000s ease-in-out 0s;
        }
        input::placeholder {
          color: #52525B !important;
        }
        input:focus {
          outline: none !important;
        }
        
        /* Prevent callout on long press for non-text elements */
        [data-no-callout],
        [data-no-callout] * {
          -webkit-touch-callout: none !important;
        }
        
        /* Split handle styles */
        .split-handle {
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
          -webkit-touch-callout: none;
        }
        
        /* Tab bar - prevent text selection on long press */
        .tab-bar {
          -webkit-user-select: none;
          user-select: none;
          -webkit-touch-callout: none;
          touch-action: manipulation;
        }
        
        /* Allow text selection in content areas */
        .content-area {
          -webkit-user-select: text;
          user-select: text;
        }
      `
      document.head.appendChild(style)
    }
  }, [])

  // Initialize Teros connection
  useEffect(() => {
    const initSession = async () => {
      // Web-specific: wait for DOM to be ready
      if (Platform.OS === "web" && typeof document !== "undefined") {
        // Fix for Expo entry.bundle script type
        const fixScriptType = () => {
          const scripts = document.querySelectorAll('script[src*="entry.bundle"]')
          scripts.forEach((script) => {
            if (script instanceof HTMLScriptElement && !script.type) {
              script.type = "module"
              console.log("🔧 Fixed bundle script type to module")
            }
          })
        }

        // Try immediately and also wait a bit
        fixScriptType()
        setTimeout(fixScriptType, 100)
        setTimeout(fixScriptType, 500)
      }

      // Try to restore session token from storage BEFORE connecting
      let savedUserData: any = null
      try {
        const savedUser = await storage.getItem(STORAGE_KEYS.USER)
        if (savedUser) {
          savedUserData = JSON.parse(savedUser)
          console.log("🔄 Restoring session:", savedUserData.email)
          client.setSessionToken(savedUserData.sessionToken)

          // Sync to auth store
          authLogin(
            {
              userId: savedUserData.userId,
              email: savedUserData.email,
              name: savedUserData.name,
              avatarUrl: savedUserData.avatarUrl,
            },
            savedUserData.sessionToken,
          )

          // Set user context for Sentry
          setSentryUser({
            id: savedUserData.userId,
            email: savedUserData.email,
            username: savedUserData.name,
          })
        }
      } catch (e) {
        console.error("❌ Failed to restore session:", e)
        await storage.removeItem(STORAGE_KEYS.USER)
      }

      // If no saved session, mark as not restoring (login screen will handle redirect)
      if (!savedUserData) {
        console.log("📍 No saved session found")
        setIsRestoringSession(false)
        return
      }

      // Get server URL from environment
      const serverUrl = process.env.EXPO_PUBLIC_WS_URL
      if (!serverUrl) {
        throw new Error("EXPO_PUBLIC_WS_URL is not defined")
      }

      console.log("🔌 Connecting to Teros:", serverUrl)
      client.connect(serverUrl)

      // Connection handlers
      const onConnected = () => {
        console.log("✅ Connected to Teros")

        // Set isRestoringSession to false after everything is ready
        setTimeout(() => {
          setIsRestoringSession(false)
        }, 200)
      }

      const onDisconnected = () => {
        console.log("❌ Disconnected from Teros")
      }

      const onAuthFailed = async (data: any) => {
        console.log("🔐 Auth failed, clearing session:", data)

        // Clear saved user data
        await storage.removeItem(STORAGE_KEYS.USER)
        await authLogout()
        setIsRestoringSession(false)

        // Clear Sentry user context
        setSentryUser(null)

        // Navigate to login
        router.replace("/(auth)/login")
      }

      client.on("connected", onConnected)
      client.on("disconnected", onDisconnected)
      client.on("auth_failed", onAuthFailed)

      // Store refs for cleanup
      cleanupRef.current = () => {
        client.off("connected", onConnected)
        client.off("disconnected", onDisconnected)
        client.off("auth_failed", onAuthFailed)
      }
    }

    initSession()

    // Web: Listen for storage changes (e.g., OAuth callback saved token)
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const handleStorageChange = async (e: StorageEvent) => {
        if (e.key === STORAGE_KEYS.USER && e.newValue && !client.isConnectedOrConnecting()) {
          console.log("🔄 Storage changed, new session detected")
          try {
            const userData = JSON.parse(e.newValue)
            if (userData.sessionToken) {
              client.setSessionToken(userData.sessionToken)
              authLogin(
                {
                  userId: userData.userId,
                  email: userData.email,
                  name: userData.name,
                  avatarUrl: userData.avatarUrl,
                },
                userData.sessionToken,
              )

              // Set user context for Sentry
              setSentryUser({
                id: userData.userId,
                email: userData.email,
                username: userData.name,
              })

              const serverUrl = process.env.EXPO_PUBLIC_WS_URL
              if (serverUrl) {
                client.connect(serverUrl)
              }
            }
          } catch (err) {
            console.error("Failed to handle storage change:", err)
          }
        }
      }

      window.addEventListener("storage", handleStorageChange)
      return () => {
        window.removeEventListener("storage", handleStorageChange)
        cleanupRef.current?.()
      }
    }

    return () => {
      cleanupRef.current?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // Handle navigation based on auth state
  // Note: Individual pages handle their own auth redirects
  // This prevents navigation conflicts during initial mount

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <TamaguiProvider config={config} defaultTheme="dark">
          <Theme name="dark">
            <TerosToastProvider>
              <YStack flex={1} backgroundColor="$background">
                <StatusBar style="light" />
                <Slot />
              </YStack>
            </TerosToastProvider>
          </Theme>
        </TamaguiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
