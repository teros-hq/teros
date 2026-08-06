/**
 * UserDetailView — the per-user drill-in for the admin Users panel (TER-684 · PR3).
 *
 * A fragmented, tabbed detail: identity header + Resumen / Facturación / Acceso.
 * The expensive per-user enrichment (agents/workspaces/cost/tokens + full billing)
 * is loaded lazily on mount with an EXPLICIT { loading | error | loaded } state —
 * replacing UserCard's implicit `stats.agents !== undefined` marker — so an error
 * shows a recoverable banner in Resumen instead of blanking the view.
 *
 * The caller's role/id (for gating the Acceso actions) come from the auth store,
 * the SAME source UserCard used; impersonation is orchestrated here (it swaps the
 * session token + reconnects). Colours are monitoring tokens end-to-end.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ScrollView, Text, XStack, YStack } from "tamagui"
import { Avatar, Badge } from "../../../components/mca/primitives"
import { scrollbarThin, tokens } from "../../../components/monitoring/colors"
import { SegmentedTabs } from "../../../components/monitoring/SegmentedTabs"
import type { UserDetailEnrichment, UserRole, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useAuthStore } from "../../../store/authStore"
import { useNavbarStore } from "../../../store/navbarStore"
import { useTilingStore } from "../../../store/tilingStore"
import { useWorkspaceStore } from "../../../store/workspaceStore"
import { UsersHeader } from "../UsersHeader"
import { roleBadgeVariant, userStatusMeta } from "../usersModel"
import { AccesoTab } from "./AccesoTab"
import { FacturacionTab } from "./FacturacionTab"
import { ResumenTab } from "./ResumenTab"

type TerosClient = ReturnType<typeof getTerosClient>

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; detail: UserDetailEnrichment }

type TabKey = "resumen" | "facturacion" | "acceso"

type Actor = { userId?: string; name?: string; email?: string } | null | undefined

type StartImpersonation = (
  targetUser: {
    userId: string
    email: string
    name?: string
    avatarUrl?: string
    role?: string
    accessGranted?: boolean
  },
  token: string,
  meta: { impersonatedBy: string; impersonatedByName: string },
) => void

/** Swap the session to the target user, reset cached UI state, and reconnect. */
async function startImpersonationFlow(
  client: TerosClient,
  targetUserId: string,
  startImpersonation: StartImpersonation,
  actor: Actor,
) {
  const serverUrl = process.env.EXPO_PUBLIC_WS_URL
  if (!serverUrl) throw new Error("EXPO_PUBLIC_WS_URL is not defined")
  const result = await client.admin.impersonate(targetUserId)
  startImpersonation(
    {
      userId: result.targetUser.userId,
      email: result.targetUser.email,
      name: result.targetUser.displayName,
      avatarUrl: result.targetUser.avatarUrl,
      role: result.targetUser.role,
      accessGranted: (result.targetUser as { accessGranted?: boolean }).accessGranted,
    },
    result.impersonationToken,
    {
      impersonatedBy: actor?.userId ?? "",
      impersonatedByName: actor?.name ?? actor?.email ?? "Admin",
    },
  )
  useNavbarStore.getState().reset()
  useWorkspaceStore.getState().clearActiveWorkspace()
  useTilingStore.getState().resetState()
  client.setSessionToken(result.impersonationToken)
  client.connect(serverUrl)
}

export interface UserDetailViewProps {
  user: UserSummary
  onBack: () => void
  onUpdate: (patch: Partial<UserSummary>) => void
}

export function UserDetailView({ user, onBack, onUpdate }: UserDetailViewProps) {
  const { t } = useTranslation()
  const client = getTerosClient()

  const currentUser = useAuthStore((s) => s.user)
  const impersonation = useAuthStore((s) => s.impersonation)
  const startImpersonation = useAuthStore((s) => s.startImpersonation)

  const [state, setState] = useState<DetailState>({ status: "loading" })
  const [reloadKey, setReloadKey] = useState(0)
  const [tab, setTab] = useState<TabKey>("resumen")

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional refetch trigger
  useEffect(() => {
    let cancelled = false
    setState({ status: "loading" })
    client.admin
      .getUserDetail(user.userId)
      .then((detail) => {
        if (!cancelled) setState({ status: "loaded", detail })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const message =
            (e as { message?: string })?.message ?? t("windows.usersPanel.detail.enrichmentError")
          setState({ status: "error", message })
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, user.userId, t, reloadKey])

  const handleImpersonate = useCallback(
    () => startImpersonationFlow(client, user.userId, startImpersonation, currentUser),
    [client, user.userId, startImpersonation, currentUser],
  )

  const detail = state.status === "loaded" ? state.detail : null
  const enrichedUser: UserSummary = detail
    ? {
        ...user,
        billing: detail.billing ?? user.billing,
        stats: { ...user.stats, ...detail.stats },
      }
    : user

  const displayName =
    user.profile.displayName ?? user.profile.email ?? t("windows.usersPanel.detail.thisUser")

  const tabs = [
    { key: "resumen", label: t("windows.usersPanel.detail.tabs.resumen") },
    { key: "facturacion", label: t("windows.usersPanel.detail.tabs.billing") },
    { key: "acceso", label: t("windows.usersPanel.detail.tabs.access") },
  ]

  return (
    <YStack flex={1} backgroundColor={tokens.bg}>
      <UsersHeader
        crumbs={[{ label: t("windows.usersPanel.title"), onPress: onBack }, { label: displayName }]}
      />
      <ScrollView
        flex={1}
        // @ts-expect-error — RN-Web thin scrollbar (Teros standard)
        style={scrollbarThin}
      >
        <YStack padding={24} gap={20} testID="user-detail-view">
          <IdentityRow user={user} displayName={displayName} />
          <SegmentedTabs tabs={tabs} active={tab} onChange={(k) => setTab(k as TabKey)} />
          <DetailBody
            tab={tab}
            user={user}
            enrichedUser={enrichedUser}
            detail={detail}
            state={state}
            onRetry={() => setReloadKey((k) => k + 1)}
            onUpdate={onUpdate}
            callerRole={currentUser?.role as UserRole | undefined}
            callerUserId={currentUser?.userId}
            isImpersonating={impersonation?.isImpersonating === true}
            onImpersonate={handleImpersonate}
          />
        </YStack>
      </ScrollView>
    </YStack>
  )
}

function DetailBody({
  tab,
  user,
  enrichedUser,
  detail,
  state,
  onRetry,
  onUpdate,
  callerRole,
  callerUserId,
  isImpersonating,
  onImpersonate,
}: {
  tab: TabKey
  user: UserSummary
  enrichedUser: UserSummary
  detail: UserDetailEnrichment | null
  state: DetailState
  onRetry: () => void
  onUpdate: (patch: Partial<UserSummary>) => void
  callerRole?: UserRole
  callerUserId?: string
  isImpersonating: boolean
  onImpersonate: () => Promise<void>
}) {
  if (tab === "facturacion") {
    return (
      <FacturacionTab user={enrichedUser} detail={detail} onUpdate={onUpdate} onChanged={onRetry} />
    )
  }
  if (tab === "acceso") {
    return (
      <AccesoTab
        user={user}
        callerRole={callerRole}
        callerUserId={callerUserId}
        isImpersonating={isImpersonating}
        onUpdate={onUpdate}
        onImpersonate={onImpersonate}
      />
    )
  }
  return (
    <ResumenTab
      user={user}
      detail={detail}
      loading={state.status === "loading"}
      error={state.status === "error" ? state.message : null}
      onRetry={onRetry}
    />
  )
}

function IdentityRow({ user, displayName }: { user: UserSummary; displayName: string }) {
  const { t } = useTranslation()
  const statusMeta = userStatusMeta(user.status)

  return (
    <XStack ai="center" gap={14} flexWrap="wrap">
      <Avatar src={user.profile.avatarUrl} name={displayName} size={48} />
      <YStack gap={4} minWidth={0} flex={1}>
        <XStack ai="center" gap={8} flexWrap="wrap">
          <Text fontSize={20} fontWeight="650" color={tokens.text} numberOfLines={1}>
            {displayName}
          </Text>
          <Badge
            text={t(`windows.usersPanel.role.${user.role}`)}
            variant={roleBadgeVariant(user.role)}
          />
        </XStack>
        <XStack ai="center" gap={10} flexWrap="wrap">
          {user.profile.email ? (
            <Text fontSize={13} color={tokens.textTertiary} numberOfLines={1}>
              {user.profile.email}
            </Text>
          ) : null}
          <XStack ai="center" gap={6}>
            <YStack width={7} height={7} borderRadius={9999} backgroundColor={statusMeta.color} />
            <Text fontSize={12} color={tokens.textSecondary}>
              {t(statusMeta.labelKey)}
            </Text>
          </XStack>
        </XStack>
      </YStack>
    </XStack>
  )
}
