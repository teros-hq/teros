/**
 * AppCard Component
 *
 * Reusable card component for displaying installed apps.
 * Used in AppsWindow and WorkspaceWindow.
 */

import { ChevronRight, Package } from "@tamagui/lucide-icons"
import type React from "react"
import { useTranslation } from "react-i18next"
import { Image, TouchableOpacity, View } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import type { AppAuthInfo } from "./apps"
import { useColors } from "./mca/primitives/useColors"
import { McaIcon } from "./mca/McaIcon"
import { colors as semanticColors, indicators } from "./mca/primitives/colors"

interface AppCardProps {
  appId: string
  name: string
  icon?: string
  color?: string
  category?: string
  authInfo?: AppAuthInfo | null
  loading?: boolean
  onPress: () => void
  onUninstall?: () => void
  showUninstall?: boolean
  mcaId?: string
}

const categoryKeyMap: Record<string, string> = {
  google: "apps.categoryGoogle",
  system: "apps.categorySystem",
  productivity: "apps.categoryProductivity",
  communication: "apps.categoryCommunication",
  integration: "apps.categoryIntegration",
  ai: "apps.categoryAi",
  development: "apps.categoryDevelopment",
  data: "apps.categoryData",
  media: "apps.categoryMedia",
  other: "apps.categoryOther",
}

export function AppCard({
  appId,
  name,
  icon,
  color,
  category,
  authInfo,
  loading,
  onPress,
  onUninstall,
  showUninstall = false,
  mcaId,
}: AppCardProps) {
  const { t } = useTranslation()
  const c = useColors()

  const getCategoryLabel = () => {
    const key = categoryKeyMap[category || ""]
    return key ? t(key) : category || t("apps.app")
  }

  const getStatusText = () => {
    if (!authInfo) return { color: c.text3, text: t("apps.verifying") }
    switch (authInfo.status) {
      case "ready":
        return { color: semanticColors.green, text: t("apps.ready") }
      case "needs_system_setup":
        return { color: semanticColors.amber, text: t("apps.requiresSetup") }
      case "needs_user_auth":
        return { color: semanticColors.amber, text: t("apps.requiresConnection") }
      case "expired":
        return { color: semanticColors.amber, text: t("apps.sessionExpired") }
      case "error":
        return { color: semanticColors.red, text: t("apps.error") }
      case "not_required":
        return { color: c.text2, text: getCategoryLabel() }
      default:
        return { color: c.text2, text: getCategoryLabel() }
    }
  }

  const status = getStatusText()

  // Show category for ready/not_required, show status for others
  const needsAttention =
    authInfo?.status === "needs_system_setup" ||
    authInfo?.status === "needs_user_auth" ||
    authInfo?.status === "expired" ||
    authInfo?.status === "error"

  // Health dot — a coloured indicator for apps that actually carry an auth
  // status. Apps with `not_required` (no credentials) get no dot: a green/grey
  // dot there would imply a health signal that doesn't exist for them. The dot
  // colour mirrors the status text, so both read the same at a glance.
  const showHealthDot = !loading && !!authInfo && authInfo.status !== "not_required"

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexBasis: "30%",
        flexGrow: 1,
        minWidth: 250,
        backgroundColor: c.bgCard,
        borderRadius: 12,
        padding: 14,
        borderWidth: 1,
        borderColor: needsAttention ? indicators.risk.border : c.border,
      }}
    >
      <XStack gap="$3" alignItems="center">
        {/* Icon */}
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: color || c.bgInner,
            justifyContent: "center",
            alignItems: "center",
            overflow: "hidden",
          }}
        >
          <McaIcon
            icon={icon}
            mcaId={mcaId}
            size={24}
            color={c.text}
            backgroundColor="transparent"
          />
        </View>

        {/* Content */}
        <YStack flex={1}>
          <Text fontSize={14} fontWeight="500" color={c.text} numberOfLines={1}>
            {name}
          </Text>
          <XStack alignItems="center" gap={6}>
            {showHealthDot && (
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: status.color,
                  flexShrink: 0,
                }}
              />
            )}
            <Text fontSize={11} color={loading ? c.text3 : status.color} numberOfLines={1}>
              {loading ? t("apps.verifying") : status.text}
            </Text>
          </XStack>
        </YStack>

        {/* Arrow */}
        <ChevronRight size={16} color={c.text3} />
      </XStack>
    </TouchableOpacity>
  )
}
