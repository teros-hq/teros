/**
 * Logout page — destroys session and redirects to login
 *
 * Uses SessionManager.destroySession() which:
 * - Resets all registered stores
 * - Clears all storage
 * - Disconnects transport
 * - Cleans Sentry context
 */

import { useRouter } from "expo-router"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { destroySession } from "../src/store/session/SessionManager"
import { useColors } from "../src/components/mca/primitives/useColors"
import { AppSpinner } from "../src/components/ui/AppSpinner"
import { T } from "../src/components/ui/ds"

export default function LogoutPage() {
  const router = useRouter()
  const { t } = useTranslation()
  const c = useColors()

  useEffect(() => {
    destroySession().then(() => {
      router.replace("/(auth)/login")
    })
  }, [])

  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        gap: 14,
        backgroundColor: c.bgFrame,
      }}
    >
      <AppSpinner size="md" />
      <T step="sm" tone="text3">
        {t("auth.signingOut")}
      </T>
    </View>
  )
}
