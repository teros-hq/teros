/**
 * Catalog Window Content
 *
 * Shows available MCAs to install.
 */

import {
  Bot,
  Bug,
  Calendar,
  Check,
  CheckSquare,
  Clock,
  Cloud,
  Database,
  Download,
  FileText,
  Folder,
  Globe,
  Mail,
  MessageSquare,
  Package,
  Plus,
  Search,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
} from "@tamagui/lucide-icons"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import { Image, ScrollView, TextInput, TouchableOpacity, View } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import { getTerosClient } from "../../../app/_layout"
import { useToast } from "../../components/Toast"
import { AppSpinner, FullscreenLoader } from "../../components/ui"
import type { CatalogWindowProps } from "./definition"

interface CatalogMca {
  mcaId: string
  name: string
  description: string
  icon?: string
  color?: string
  category: string
  tools: string[]
  availability: {
    enabled: boolean
    multi: boolean
    system: boolean
    hidden: boolean
    role: "user" | "admin" | "super"
  }
}

interface InstalledApp {
  appId: string
  mcaId: string
  name: string
}

// Map icon names to Lucide components
const iconMap: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  terminal: Terminal,
  folder: Folder,
  globe: Globe,
  package: Package,
  wrench: Wrench,
  message: MessageSquare,
  "message-square": MessageSquare,
  mail: Mail,
  calendar: Calendar,
  clock: Clock,
  database: Database,
  cloud: Cloud,
  settings: Settings,
  "check-square": CheckSquare,
  search: Search,
  bot: Bot,
  file: FileText,
  shield: Shield,
  bug: Bug,
  sparkles: Sparkles,
}

// Category display names
const categoryNames: Record<string, string> = {
  system: "Sistema",
  productivity: "Productividad",
  communication: "Communication",
  integration: "Integration",
  ai: "Inteligencia Artificial",
  development: "Desarrollo",
  data: "Datos",
  media: "Media",
  other: "Otros",
}

interface CatalogWindowContentProps extends CatalogWindowProps {
  windowId: string
}

export function CatalogWindowContent({
  windowId,
  category: initialCategory,
  search: initialSearch,
}: CatalogWindowContentProps) {
  const [catalog, setCatalog] = useState<CatalogMca[]>([])
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [installingMcaId, setInstallingMcpId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState(initialSearch || "")
  const [selectedCategory, setSelectedCategory] = useState<string | null>(initialCategory || null)

  const client = getTerosClient()
  const toast = useToast()

  useEffect(() => {
    const tryLoadData = async () => {
      if (client.isConnected()) {
        loadData()
      } else {
        const onConnected = () => {
          client.off("connected", onConnected)
          loadData()
        }
        client.on("connected", onConnected)
        return () => {
          client.off("connected", onConnected)
        }
      }
    }
    tryLoadData()
  }, [])

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [catalogResult, appsResult] = await Promise.all([
        client.app.listCatalog(),
        client.app.listApps(),
      ])
      setCatalog(catalogResult.catalog as CatalogMca[])
      setInstalledApps(appsResult.apps)
    } catch (err: any) {
      console.error("Error loading catalog:", err)
      toast.error("Error", "Could not load the catalog")
    } finally {
      setIsLoading(false)
    }
  }

  const handleInstall = async (mca: CatalogMca) => {
    setInstallingMcpId(mca.mcaId)
    try {
      const { app } = await client.app.installApp(mca.mcaId)
      setInstalledApps((prev) => [
        ...prev,
        {
          appId: app.appId,
          mcaId: app.mcaId,
          name: app.name,
        },
      ])
      toast.success("Installed", `${mca.name} instalada correctamente`)
    } catch (err: any) {
      console.error("Error installing app:", err)
      toast.error("Error", `No se pudo instalar ${mca.name}`)
    } finally {
      setInstallingMcpId(null)
    }
  }

  const isInstalled = (mcaId: string) => {
    return installedApps.some((app) => app.mcaId === mcaId)
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

  // Get available categories from catalog
  const availableCategories = [...new Set(catalog.map((mca) => mca.category))]
  const categoryOrder = [
    "productivity",
    "development",
    "ai",
    "data",
    "communication",
    "media",
    "system",
    "other",
  ]
  const sortedAvailableCategories = availableCategories.sort((a, b) => {
    const aIndex = categoryOrder.indexOf(a)
    const bIndex = categoryOrder.indexOf(b)
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex)
  })

  // Filter catalog based on search and category
  const filteredCatalog = catalog.filter((mca) => {
    // Category filter
    if (selectedCategory && mca.category !== selectedCategory) {
      return false
    }
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return (
        mca.name.toLowerCase().includes(query) ||
        mca.description.toLowerCase().includes(query) ||
        mca.tools.some((t) => {
          const toolName = typeof t === 'string' ? t : (t as any)?.name ?? '';
          return toolName.toLowerCase().includes(query);
        })
      );
    }
    return true
  })

  // Group filtered catalog by category
  const groupedCatalog = filteredCatalog.reduce(
    (acc, mca) => {
      const category = mca.category || "other"
      if (!acc[category]) {
        acc[category] = []
      }
      acc[category].push(mca)
      return acc
    },
    {} as Record<string, CatalogMca[]>,
  )

  const sortedCategories = Object.keys(groupedCatalog).sort((a, b) => {
    const aIndex = categoryOrder.indexOf(a)
    const bIndex = categoryOrder.indexOf(b)
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex)
  })

  // Render catalog card
  const renderCatalogCard = (mca: CatalogMca) => {
    const IconComponent = getIcon(mca.icon)
    const installed = isInstalled(mca.mcaId)
    const installing = installingMcaId === mca.mcaId
    const isSystem = mca.availability.system
    const isMulti = mca.availability.multi
    const instanceCount = installedApps.filter((a) => a.mcaId === mca.mcaId).length

    return (
      <View
        key={mca.mcaId}
        style={{
          flexBasis: "30%",
          flexGrow: 1,
          minWidth: 280,
          backgroundColor: "rgba(24, 24, 27, 0.9)",
          borderRadius: 12,
          padding: 16,
          borderWidth: 1,
          borderColor: "rgba(39, 39, 42, 0.6)",
        }}
      >
        <XStack gap="$3" alignItems="flex-start">
          {/* Icon */}
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              backgroundColor: mca.color || "rgba(255, 255, 255, 0.05)",
              justifyContent: "center",
              alignItems: "center",
              overflow: "hidden",
            }}
          >
            {isImageUrl(mca.icon) ? (
              <Image
                source={{ uri: mca.icon }}
                style={{ width: 24, height: 24 }}
                resizeMode="contain"
              />
            ) : IconComponent ? (
              <IconComponent size={20} color="#FAFAFA" />
            ) : (
              <Text fontSize={20}>{mca.icon}</Text>
            )}
          </View>

          {/* Content */}
          <YStack flex={1} gap={2}>
            <XStack alignItems="center" gap="$2" flexWrap="wrap">
              <Text fontSize={14} fontWeight="500" color="#FAFAFA">
                {mca.name}
              </Text>
              {isSystem && (
                <View
                  style={{
                    backgroundColor: "rgba(99, 102, 241, 0.15)",
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                  }}
                >
                  <Text fontSize={9} color="#818CF8" fontWeight="500">
                    SISTEMA
                  </Text>
                </View>
              )}
              {installed && !isSystem && (
                <View
                  style={{
                    backgroundColor: "rgba(16, 185, 129, 0.15)",
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                  }}
                >
                  <Text fontSize={9} color="#10B981" fontWeight="500">
                    {instanceCount > 1 ? `${instanceCount} INSTALADAS` : "INSTALADA"}
                  </Text>
                </View>
              )}
            </XStack>
            <Text fontSize={11} color="#71717A">
              {mca.tools.length} {mca.tools.length === 1 ? "herramienta" : "herramientas"}
            </Text>
          </YStack>
        </XStack>

        {/* Description */}
        <Text fontSize={12} color="#A1A1AA" marginTop="$2" numberOfLines={2}>
          {mca.description}
        </Text>

        {/* Tools preview */}
        {mca.tools.length > 0 && (
          <XStack marginTop="$2" gap="$1" flexWrap="wrap">
            {mca.tools.slice(0, 3).map((tool) => {
              const toolName = typeof tool === 'string' ? tool : (tool as any)?.name ?? '';
              return (
                <View
                  key={toolName}
                  style={{
                    backgroundColor: 'rgba(39, 39, 42, 0.6)',
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                  }}
                >
                  <Text fontSize={10} color="#71717A">
                    {toolName.split('_').pop()}
                  </Text>
                </View>
              );
            })}
            {mca.tools.length > 3 && (
              <View
                style={{
                  backgroundColor: "rgba(39, 39, 42, 0.6)",
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                }}
              >
                <Text fontSize={10} color="#52525B">
                  +{mca.tools.length - 3}
                </Text>
              </View>
            )}
          </XStack>
        )}

        {/* Action button */}
        <XStack marginTop="$3" justifyContent="flex-end">
          {isSystem ? (
            <View
              style={{
                backgroundColor: "rgba(99, 102, 241, 0.1)",
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Shield size={12} color="#818CF8" />
              <Text color="#818CF8" fontSize={12} fontWeight="500">
                Incluida
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => handleInstall(mca)}
              disabled={installing || (installed && !isMulti)}
              style={{
                backgroundColor:
                  installed && !isMulti ? "rgba(39, 39, 42, 0.4)" : "rgba(59, 130, 246, 0.1)",
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                opacity: installed && !isMulti ? 0.5 : 1,
              }}
            >
              {installing ? (
                <AppSpinner size="sm" variant="default" />
              ) : (
                <>
                  {isMulti && installed ? (
                    <Plus size={12} color="#3B82F6" />
                  ) : installed ? (
                    <Check size={12} color="#71717A" />
                  ) : (
                    <Download size={12} color="#3B82F6" />
                  )}
                  <Text
                    color={installed && !isMulti ? "#71717A" : "#3B82F6"}
                    fontSize={12}
                    fontWeight="500"
                  >
                    {isMulti && installed ? "Add another" : installed ? "Installed" : "Install"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </XStack>
      </View>
    )
  }

  // Render category filter chip
  const renderCategoryChip = (category: string | null, label: string) => {
    const isActive = selectedCategory === category
    return (
      <TouchableOpacity
        onPress={() => setSelectedCategory(category)}
        style={{
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 12,
          backgroundColor: isActive ? "rgba(59, 130, 246, 0.15)" : "rgba(39, 39, 42, 0.4)",
          borderWidth: 1,
          borderColor: isActive ? "rgba(59, 130, 246, 0.3)" : "transparent",
        }}
      >
        <Text
          fontSize={11}
          color={isActive ? "#3B82F6" : "#A1A1AA"}
          fontWeight={isActive ? "500" : "400"}
        >
          {label}
        </Text>
      </TouchableOpacity>
    )
  }

  return (
    <YStack flex={1} backgroundColor="#09090B">
      {/* Header */}
      <YStack borderBottomWidth={1} borderBottomColor="rgba(39, 39, 42, 0.6)">
        {/* Title and Search */}
        <XStack
          paddingHorizontal="$3"
          paddingTop="$2"
          paddingBottom="$2"
          justifyContent="space-between"
          alignItems="center"
        >
          <Text fontSize={16} fontWeight="600" color="#FAFAFA">
            Catalog
          </Text>

          {/* Search */}
          <XStack
            backgroundColor="rgba(39, 39, 42, 0.6)"
            borderRadius={6}
            paddingHorizontal="$2"
            paddingVertical="$1"
            alignItems="center"
            gap="$2"
            width={160}
            borderWidth={1}
            borderColor="rgba(63, 63, 70, 0.5)"
          >
            <Search size={12} color="#71717A" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Buscar..."
              placeholderTextColor="#52525B"
              style={{
                flex: 1,
                color: "#FAFAFA",
                fontSize: 12,
              }}
            />
          </XStack>
        </XStack>

        {/* Category filters */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ paddingBottom: 8 }}
          contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }}
        >
          <XStack gap="$1">
            {renderCategoryChip(null, "Todas")}
            {sortedAvailableCategories.map((cat) => (
              <View key={cat}>{renderCategoryChip(cat, categoryNames[cat] || cat)}</View>
            ))}
          </XStack>
        </ScrollView>
      </YStack>

      {isLoading ? (
        <FullscreenLoader variant="default" label="Cargando..." />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
          {sortedCategories.length > 0 ? (
            sortedCategories.map((category) => (
              <YStack key={category} marginBottom="$4">
                {/* Category header */}
                <YStack marginBottom="$2">
                  <Text fontSize={13} fontWeight="500" color="#FAFAFA">
                    {categoryNames[category] || category}
                  </Text>
                  <Text fontSize={11} color="#52525B" marginTop={2}>
                    {groupedCatalog[category].length}{" "}
                    {groupedCatalog[category].length === 1 ? "app" : "apps"}
                  </Text>
                </YStack>

                {/* Apps grid */}
                <XStack flexWrap="wrap" gap="$2">
                  {groupedCatalog[category].map(renderCatalogCard)}
                </XStack>
              </YStack>
            ))
          ) : (
            <YStack alignItems="center" padding="$6">
              <Search size={40} color="#27272A" />
              <Text color="#52525B" marginTop="$3" textAlign="center" fontSize={13}>
                No se encontraron apps
              </Text>
            </YStack>
          )}
        </ScrollView>
      )}
    </YStack>
  )
}
