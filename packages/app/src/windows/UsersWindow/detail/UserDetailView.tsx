/**
 * UserDetailView — the per-user drill-in for the admin Users panel (TER-684 · PR3).
 *
 * A fragmented, tabbed detail in the OS prototype vocabulary: `Page` → a
 * `PageHead` with the user's `Avatar` + name (role / status badges in the lead)
 * and a ghost "← Usuarios" back action → `PTabs` Resumen / Facturación / Acceso.
 * The expensive per-user enrichment (agents/workspaces/cost/tokens + full billing)
 * is loaded lazily on mount with an EXPLICIT { loading | error | loaded } state —
 * so an error shows a recoverable banner in Resumen instead of blanking the view.
 *
 * The caller's role/id (for gating the Acceso actions) come from the auth store;
 * impersonation is orchestrated here (it swaps the session token + reconnects).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View, useWindowDimensions } from "react-native"
import { Avatar } from "../../../components/Avatar"
import { Badge, Btn, Page, PageHead, PTabs, T } from "../../../components/ui/ds"
import type { UserDetailEnrichment, UserRole, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useAuthStore } from "../../../store/authStore"
import { useNavbarStore } from "../../../store/navbarStore"
import { useTilingStore } from "../../../store/tilingStore"
import { useWorkspaceStore } from "../../../store/workspaceStore"
import { roleTone, userStatusMeta, userStatusTone } from "../usersModel"
import { AccesoTab } from "./AccesoTab"
import { FacturacionTab } from "./FacturacionTab"
import { ResumenTab } from "./ResumenTab"
import { wsUrl } from "../../../config/runtime"

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
  const serverUrl = wsUrl()
  if (!serverUrl) throw new Error("WebSocket URL is not configured")
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
    { key: "resumen" as const, label: t("windows.usersPanel.detail.tabs.resumen"), icon: "user" },
    {
      key: "facturacion" as const,
      label: t("windows.usersPanel.detail.tabs.billing"),
      icon: "credit-card",
    },
    {
      key: "acceso" as const,
      label: t("windows.usersPanel.detail.tabs.access"),
      icon: "shield-check",
    },
  ]

  return (
    <Page>
      <View testID="user-detail-view">
        <IdentityHead user={user} displayName={displayName} onBack={onBack} />
        <PTabs<TabKey> items={tabs} value={tab} onChange={setTab} />
        <View style={{ marginTop: 16 }}>
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
        </View>
      </View>
    </Page>
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

/** `PageHead` with the user's avatar beside the eyebrow + serif name. */
function IdentityHead({
  user,
  displayName,
  onBack,
}: {
  user: UserSummary
  displayName: string
  onBack: () => void
}) {
  const { t } = useTranslation()
  const { width } = useWindowDimensions()
  const statusMeta = userStatusMeta(user.status)
  const avatarSize = width <= 620 ? 44 : 56

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 20 }}>
      <Avatar name={displayName} imageUrl={user.profile.avatarUrl} size={avatarSize} />
      <PageHead
        style={{ flex: 1, marginBottom: 0 }}
        eyebrow={t("users.eyebrow", { defaultValue: "ADMINISTRACIÓN DE LA PLATAFORMA" })}
        title={displayName}
        lead={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {user.profile.email ? (
              <T step="sm" tone="text3" numberOfLines={1}>
                {user.profile.email}
              </T>
            ) : null}
            <Badge tone={roleTone(user.role)}>{t(`windows.usersPanel.role.${user.role}`)}</Badge>
            <Badge tone={userStatusTone(user.status)} dot>
              {t(statusMeta.labelKey)}
            </Badge>
          </View>
        }
        actions={
          <Btn
            variant="ghost"
            icon="arrow-left"
            onPress={onBack}
            aria-label={`Back to ${t("windows.usersPanel.title")}`}
          >
            {t("windows.usersPanel.title")}
          </Btn>
        }
      />
    </View>
  )
}
