/**
 * AppCard — one installed app of the OS prototype's "Mis apps" grid (`.myapp`):
 * a lifted Card with the brand Tile, the app name, a secondary line (account /
 * category / error) and a status Badge at the right.
 *
 *   Lista · green dot      ready
 *   Sin conectar · amber   needs_user_auth
 *   Requiere configuración needs_system_setup
 *   Sesión caducada        expired
 *   Error · red            error (+ the message in the sub line)
 *   category (muted)       not_required / unknown
 *
 * Used by AppsWindow (inside a `Grid`, `layout="fill"`) and WorkspaceWindow
 * (inside a wrapping XStack, the default `layout="wrap"`).
 */

import { useTranslation } from "react-i18next"
import { View } from "react-native"
import type { AppAuthInfo } from "./apps"
import { useColors } from "./mca/primitives/useColors"
import { McaIcon } from "./mca/McaIcon"
import { Badge, type BadgeTone, Card, IconBtn, T, Tile } from "./ui/ds"

interface AppCardProps {
  appId: string
  name: string
  icon?: string
  color?: string
  category?: string
  authInfo?: AppAuthInfo | null
  loading?: boolean
  onPress: (e?: any) => void
  onUninstall?: () => void
  showUninstall?: boolean
  mcaId?: string
  /** `fill` stretches to the parent (Grid cell); `wrap` keeps the legacy flex-wrap sizing. */
  layout?: "fill" | "wrap"
}

const categoryKeyMap: Record<string, string> = {
  google: "apps.categoryGoogle",
  microsoft: "apps.categoryMicrosoft",
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

/** Status → badge tone + label. Exported so the Apps window can count/filter by the same rule. */
export function appStatusMeta(
  authInfo: AppAuthInfo | null | undefined,
  loading: boolean | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { tone: BadgeTone; label: string; kind: "ready" | "attention" | "idle" | "loading" } {
  if (loading || !authInfo) return { tone: "muted", label: t("apps.verifying"), kind: "loading" }
  switch (authInfo.status) {
    case "ready":
      return { tone: "g", label: t("apps.ready"), kind: "ready" }
    case "needs_user_auth":
      return { tone: "a", label: t("apps.requiresConnection"), kind: "attention" }
    case "needs_system_setup":
      return { tone: "a", label: t("apps.requiresSetup"), kind: "attention" }
    case "expired":
      return { tone: "a", label: t("apps.sessionExpired"), kind: "attention" }
    case "error":
      return { tone: "r", label: t("apps.error"), kind: "attention" }
    default:
      return { tone: "muted", label: t("apps.idle", { defaultValue: "Idle" }), kind: "idle" }
  }
}

export function AppCard({
  name,
  icon,
  category,
  authInfo,
  loading,
  onPress,
  onUninstall,
  showUninstall = false,
  mcaId,
  layout = "wrap",
}: AppCardProps) {
  const { t } = useTranslation()
  const c = useColors()

  const categoryLabel = (() => {
    const key = categoryKeyMap[category || ""]
    return key ? t(key) : category || t("apps.app")
  })()

  const status = appStatusMeta(authInfo, loading, t)
  const isError = !loading && authInfo?.status === "error"
  // Secondary line: the error message when broken, the connected account when
  // we know it, the category otherwise.
  const sub = isError
    ? authInfo?.error || authInfo?.message || categoryLabel
    : authInfo?.oauth?.email || categoryLabel

  return (
    <Card
      hov
      pad
      onPress={onPress}
      style={
        layout === "fill" ? { width: "100%" } : { flexBasis: "30%", flexGrow: 1, minWidth: 250 }
      }
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Tile>
          <McaIcon
            icon={icon}
            mcaId={mcaId}
            size={24}
            color={c.accent}
            backgroundColor="transparent"
            borderRadius={0}
          />
        </Tile>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="base" ellipsis>
            {name}
          </T>
          <T step="sm" tone={isError ? "danger" : "text3"} ellipsis style={{ marginTop: 2 }}>
            {sub}
          </T>
        </View>
        <Badge tone={status.tone} pill dot={status.tone !== "muted"} sm>
          {status.label}
        </Badge>
        {showUninstall && onUninstall ? (
          <IconBtn
            icon="trash"
            plain
            sm
            danger
            onPress={(e: any) => {
              e?.stopPropagation?.()
              onUninstall()
            }}
          />
        ) : null}
      </View>
    </Card>
  )
}
