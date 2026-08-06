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
import { Text, YStack } from "tamagui"
import { destroySession } from "../src/store/session/SessionManager"
import { useColors } from "../src/components/mca/primitives/useColors"

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
    <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgPage}>
      <Text color={c.text3}>{t("auth.signingOut")}</Text>
    </YStack>
  )
}
