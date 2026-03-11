/**
 * AppCard Component
 *
 * Reusable card component for displaying installed apps.
 * Used in AppsWindow and WorkspaceWindow.
 */

import { ChevronRight, Package } from "@tamagui/lucide-icons"
import type React from "react"
import { Image, TouchableOpacity, View } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import type { AppAuthInfo } from "./apps"

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
}

// Map icon names to Lucide components (subset for common icons)
const iconMap: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  package: Package,
  // Add more as needed - for now we'll handle most via image URLs or emojis
}

const isImageUrl = (str?: string): boolean => {
  if (!str) return false
  return (
    str.startsWith("http://") ||
    str.startsWith("https://") ||
    str.endsWith(".png") ||
    str.endsWith(".jpg") ||
    str.endsWith(".jpeg") ||
    str.endsWith(".svg")
  )
}

const getIconUrl = (icon?: string): string => {
  if (!icon) return ""
  if (icon.startsWith("http://") || icon.startsWith("https://")) {
    return icon
  }
  // Relative path - construct full URL from env
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL
  if (!backendUrl) {
    console.warn("EXPO_PUBLIC_BACKEND_URL is not configured")
    return ""
  }
  return `${backendUrl}/static/mcas/${icon}`
}

const isEmoji = (str?: string): boolean => {
  if (!str) return false
  return str.length <= 2 && /\p{Emoji}/u.test(str)
}

const getIcon = (
  iconName?: string,
): React.ComponentType<{ size?: number; color?: string }> | null => {
  if (!iconName) return Package
  if (isImageUrl(iconName) || isEmoji(iconName)) {
    return null
  }
  return iconMap[iconName.toLowerCase()] || Package
}

// Category display names
const categoryNames: Record<string, string> = {
  system: "System",
  productivity: "Productivity",
  communication: "Communication",
  integration: "Integration",
  ai: "Artificial Intelligence",
  development: "Development",
  data: "Data",
  media: "Media",
  other: "Other",
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
}: AppCardProps) {
  const IconComponent = getIcon(icon)

  // Get simple status text
  const getStatusText = () => {
    if (!authInfo) return { color: "#52525B", text: "Verifying..." }
    switch (authInfo.status) {
      case "ready":
        return { color: "#10B981", text: "Ready" }
      case "needs_user_auth":
        return { color: "#F59E0B", text: "Requires connection" }
      case "expired":
        return { color: "#F59E0B", text: "Session expired" }
      case "error":
        return { color: "#EF4444", text: "Error" }
      case "not_required":
        return { color: "#71717A", text: categoryNames[category || ""] || category || "App" }
      default:
        return { color: "#71717A", text: categoryNames[category || ""] || category || "App" }
    }
  }

  const status = getStatusText()

  // Show category for ready/not_required, show status for others
  const needsAttention =
    authInfo?.status === "needs_user_auth" ||
    authInfo?.status === "expired" ||
    authInfo?.status === "error"

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexBasis: "30%",
        flexGrow: 1,
        minWidth: 250,
        backgroundColor: "rgba(24, 24, 27, 0.9)",
        borderRadius: 12,
        padding: 14,
        borderWidth: 1,
        borderColor: needsAttention ? "rgba(245, 158, 11, 0.3)" : "rgba(39, 39, 42, 0.6)",
      }}
    >
      <XStack gap="$3" alignItems="center">
        {/* Icon */}
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: color || "rgba(255, 255, 255, 0.05)",
            justifyContent: "center",
            alignItems: "center",
            overflow: "hidden",
          }}
        >
          {isImageUrl(icon) ? (
            <Image
              source={{ uri: getIconUrl(icon) }}
              style={{ width: 24, height: 24 }}
              resizeMode="contain"
            />
          ) : IconComponent ? (
            <IconComponent size={20} color="#FAFAFA" />
          ) : (
            <Text fontSize={20}>{icon}</Text>
          )}
        </View>

        {/* Content */}
        <YStack flex={1}>
          <Text fontSize={14} fontWeight="500" color="#FAFAFA" numberOfLines={1}>
            {name}
          </Text>
          <Text fontSize={11} color={loading ? "#52525B" : status.color} numberOfLines={1}>
            {loading ? "Verifying..." : status.text}
          </Text>
        </YStack>

        {/* Arrow */}
        <ChevronRight size={16} color="#3F3F46" />
      </XStack>
    </TouchableOpacity>
  )
}
