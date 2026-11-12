/**
 * App Window Content
 *
 * Configure an app instance: auth, permissions, agents, rename, scope,
 * instructions, uninstall — in the OS prototype's language: a hero Card
 * (Tile lg · serif name · mono id · status Badge · connect/disconnect pill),
 * then PTabs (Overview / Permissions / Agents / Settings). Every handler and
 * data flow is unchanged; only the presentation moved to `ui/ds`.
 */

import { useRouter } from "expo-router"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, Image, Platform, Pressable, View } from "react-native"
import { FONT_SERIF } from "../../components/mca/primitives/fonts"
import { useColors } from "../../components/mca/primitives/useColors"
import { Avatar } from "../../components/Avatar"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { AgentAccess } from "../../services/AppApi"
import {
  AuthPanel,
  type CredentialField,
  DisconnectButton,
  type GitHubInstallation,
  type GitHubSavedBranch,
  type OAuthInfo,
  PermissionsPanel,
  type ToolPermission,
  type ToolWithPermission,
} from "../../components/apps"
import { useToast } from "../../components/Toast"
import type { AppWindowProps } from "./definition"
import { AppSpinner, FullscreenLoader } from "../../components/ui"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { McaIcon } from "../../components/mca/McaIcon"
import {
  Badge,
  type BadgeTone,
  Btn,
  Card,
  DangerZone,
  EmptyState,
  Field,
  IconBtn,
  LGroup,
  LRow,
  OptionRow,
  Page,
  Ph,
  PTabs,
  SectionLabel,
  Switch,
  T,
  Tile,
} from "../../components/ui/ds"

interface App {
  appId: string
  name: string
  mcaId: string
  mcaName: string
  description: string
  category: string
  status: string
  icon?: string
  color?: string
  context?: string
  accentColors?: string[]
  /** App scope — 'personal' (per-user credentials, blocked in shared conversations) or 'shared' (workspace-level). Missing = 'personal'. */
  scope?: "personal" | "shared"
}

interface BackendAuthExtraField {
  name: string
  label: string
  type: "text" | "password"
  required: boolean
  placeholder?: string
  hint?: string
  value?: string
}

interface BackendAuthInfo {
  status: "ready" | "needs_system_setup" | "needs_user_auth" | "expired" | "error" | "not_required"
  authType: "oauth2" | "apikey" | "none" | "github-app"
  oauth?: {
    provider: string
    connected: boolean
    email?: string
    /** GitHub `login` / Notion `name` etc. — preferred over email when present. */
    userLogin?: string
    expiresAt?: string
    scopes?: string[]
    extraFields?: BackendAuthExtraField[]
  }
  apikey?: {
    configured: boolean
    fields: Array<{
      name: string
      label: string
      type: "text" | "password"
      required: boolean
      placeholder?: string
      hint?: string
    }>
  }
  githubApp?: {
    installed: boolean
    appSlug: string
    installationId?: string
    account?: string
    repositoryCount?: number
    manageUrl?: string
    installUrl?: string
    installations?: GitHubInstallation[]
    savedBranches?: GitHubSavedBranch[]
  }
  message?: string
  error?: string
}

interface BackendPermissionsData {
  appId: string
  appName?: string
  mcaName?: string
  agentId?: string
  defaultPermission: ToolPermission
  tools: Array<{ name: string; permission: ToolPermission; autoAllowed?: boolean }>
  summary: {
    allow: number
    ask: number
    forbid: number
  }
}

interface AppWindowContentProps extends AppWindowProps {
  windowId: string
}

type Translate = (key: string, opts?: Record<string, unknown>) => string

// ─── Presentation helpers (pure — no state/logic) ───────────────────────────
//
// These derive UI-only descriptors from the auth/permissions state that the
// component already holds. They read state; they never mutate it. The backend
// remains the source of truth for the connection status — here we only map it
// to a badge tone + label for the hero.

type ConnState = "connected" | "needs_signin" | "needs_admin" | "error" | "none"

/**
 * Hero status badge descriptor. Derived purely from the backend auth info so
 * the badge tone matches the AuthPanel's own status dot — single source of
 * truth, two surfaces.
 */
function deriveConnection(
  info: BackendAuthInfo | null,
  t: Translate,
): {
  state: ConnState
  tone: BadgeTone
  label: string
  identity?: string
} {
  if (!info || info.authType === "none" || info.status === "not_required") {
    return {
      state: "none",
      tone: "muted",
      label: t("apps.noAuthRequired", { defaultValue: "No auth required" }),
    }
  }
  // Identity for the "Connected as …" transparency line (HubSpot/Salesforce
  // pattern): prefer the provider handle, fall back to email.
  const identity = info.oauth?.userLogin
    ? `@${info.oauth.userLogin}`
    : (info.oauth?.email ?? info.githubApp?.account)
  switch (info.status) {
    case "ready":
      return { state: "connected", tone: "g", label: t("apps.connected"), identity }
    case "needs_system_setup":
      return { state: "needs_admin", tone: "a", label: t("apps.requiresSetup") }
    case "expired":
      return { state: "error", tone: "a", label: t("apps.sessionExpired"), identity }
    case "error":
      return {
        state: "error",
        tone: "r",
        label: t("apps.connectionError", { defaultValue: "Connection error" }),
      }
    default:
      return { state: "needs_signin", tone: "a", label: t("apps.requiresConnection") }
  }
}

type Tab = "overview" | "permissions" | "agents" | "settings"

export function AppWindowContent({ windowId, appId, workspaceId }: AppWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const toast = useToast()
  const router = useRouter()

  const [app, setApp] = useState<App | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("overview")

  // Auth state
  const [backendAuthInfo, setBackendAuthInfo] = useState<BackendAuthInfo | null>(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // Credentials state
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
  const [hasCredentialChanges, setHasCredentialChanges] = useState(false)

  // Edit Context State
  const [editContextOpen, setEditContextOpen] = useState(false)
  const [contextText, setContextText] = useState("")
  const [isContextSaving, setIsContextSaving] = useState(false)
  const [savingCredentials, setSavingCredentials] = useState(false)

  // Permissions state
  const [permissionsData, setPermissionsData] = useState<BackendPermissionsData | null>(null)
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [permissionsSaving, setPermissionsSaving] = useState(false)

  // Agent access state — which of the workspace's agents can use this app.
  const [agentAccess, setAgentAccess] = useState<AgentAccess[]>([])
  const [agentAccessLoading, setAgentAccessLoading] = useState(false)
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null)

  // Rename state
  const [isEditing, setIsEditing] = useState(false)
  const [editingName, setEditingName] = useState("")
  const [isRenaming, setIsRenaming] = useState(false)

  // Uninstall state
  const [isUninstalling, setIsUninstalling] = useState(false)

  // App scope state (REQ-6) — toggle between 'personal' and 'shared'
  const [isChangingScope, setIsChangingScope] = useState(false)
  // MUW-REQ-27: sharing collided with another member's app name → ask for a new name
  const [collisionName, setCollisionName] = useState<string | null>(null)

  // Progressive disclosure (UI-only): instructions preview is hidden until the
  // user expands it. Drives nothing on the backend — the actual edit still goes
  // through the existing context modal + handleSaveContext.
  const [instructionsExpanded, setInstructionsExpanded] = useState(false)

  // Helper functions
  const isImageUrl = (str?: string): boolean => {
    if (!str) return false
    return str.startsWith("http://") || str.startsWith("https://")
  }

  const isEmoji = (str?: string): boolean => {
    if (!str) return false
    return str.length <= 2 && /\p{Emoji}/u.test(str)
  }

  const getOAuthInfo = (): OAuthInfo | null => {
    if (!backendAuthInfo) return null

    const statusMap: Record<BackendAuthInfo["status"], OAuthInfo["status"]> = {
      ready: "connected",
      needs_user_auth: "disconnected",
      expired: "expired",
      error: "error",
      needs_system_setup: "error",
      not_required: "disconnected",
    }

    if (backendAuthInfo.authType === "github-app") {
      // GitHub App with userOAuth: backend populates `oauth` with the user's
      // login, email and expiry. Surface @login as primary identity.
      return {
        provider: "GitHub",
        status: statusMap[backendAuthInfo.status] || "disconnected",
        authType: "github-app",
        installationId: backendAuthInfo.githubApp?.installationId,
        appSlug: backendAuthInfo.githubApp?.appSlug,
        installed: backendAuthInfo.githubApp?.installed,
        installUrl: backendAuthInfo.githubApp?.installUrl,
        installations: backendAuthInfo.githubApp?.installations,
        savedBranches: backendAuthInfo.githubApp?.savedBranches,
        userLogin: backendAuthInfo.oauth?.userLogin,
        email:
          backendAuthInfo.oauth?.email ??
          (backendAuthInfo.githubApp?.account
            ? `@${backendAuthInfo.githubApp.account}`
            : undefined),
        expiresAt: backendAuthInfo.oauth?.expiresAt,
        error: backendAuthInfo.error,
      }
    }

    if (backendAuthInfo.authType !== "oauth2") return null

    return {
      provider: backendAuthInfo.oauth?.provider || "OAuth",
      status: statusMap[backendAuthInfo.status] || "disconnected",
      authType: "oauth2",
      email: backendAuthInfo.oauth?.email,
      userLogin: backendAuthInfo.oauth?.userLogin,
      expiresAt: backendAuthInfo.oauth?.expiresAt,
      scopes: backendAuthInfo.oauth?.scopes,
      error: backendAuthInfo.error,
    }
  }

  const getCredentialFields = (): CredentialField[] => {
    const fields: CredentialField[] = []

    // Standard API key fields
    if (backendAuthInfo?.apikey?.fields) {
      fields.push(
        ...backendAuthInfo.apikey.fields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          hint: field.hint,
          value: credentialValues[field.name] || "",
          isSet: !!(backendAuthInfo.apikey?.configured && !credentialValues[field.name]),
        })),
      )
    }

    // Extra fields for OAuth apps (e.g., TEAM_ID for Figma)
    if (backendAuthInfo?.oauth?.extraFields) {
      fields.push(
        ...backendAuthInfo.oauth.extraFields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          hint: field.hint,
          // Local edits take priority; fall back to server-stored value
          value:
            credentialValues[field.name] !== undefined
              ? credentialValues[field.name]
              : field.value || "",
          isSet: !!(field.value && credentialValues[field.name] === undefined),
        })),
      )
    }

    return fields
  }

  // Load functions
  const loadAuthStatus = useCallback(
    async (targetAppId: string) => {
      setAuthLoading(true)
      try {
        const info = (await client.app.getAuthStatus(targetAppId)).auth
        setBackendAuthInfo(info as any)
        setCredentialValues({})
        setHasCredentialChanges(false)
      } catch (err) {
        console.error("Failed to load auth status:", err)
        setBackendAuthInfo({
          status: "error",
          authType: "none",
          error: err instanceof Error ? err.message : t("errors.app.authStatusFailed"),
        })
      } finally {
        setAuthLoading(false)
      }
    },
    [client],
  )

  const loadPermissions = useCallback(
    async (targetAppId: string) => {
      setPermissionsLoading(true)
      try {
        const data = (await client.app.getTools(targetAppId)) as BackendPermissionsData
        setPermissionsData(data)
      } catch (err) {
        console.error("Failed to load permissions:", err)
      } finally {
        setPermissionsLoading(false)
      }
    },
    [client],
  )

  const loadAgentAccess = useCallback(
    async (targetAppId: string) => {
      setAgentAccessLoading(true)
      try {
        const { agents } = await client.app.listAgentAccess(targetAppId)
        setAgentAccess(agents)
      } catch (err) {
        console.error("Failed to load agent access:", err)
      } finally {
        setAgentAccessLoading(false)
      }
    },
    [client],
  )

  const handleToggleAgent = useCallback(
    async (agentId: string, nextHasAccess: boolean) => {
      if (!app || togglingAgentId) return
      setTogglingAgentId(agentId)
      // Optimistic flip — revert on error so the switch never lies.
      setAgentAccess((prev) =>
        prev.map((a) => (a.agentId === agentId ? { ...a, hasAccess: nextHasAccess } : a)),
      )
      try {
        if (nextHasAccess) {
          await client.app.grantAccess(agentId, app.appId)
        } else {
          await client.app.revokeAccess(agentId, app.appId)
        }
      } catch (err) {
        console.error("Failed to toggle agent access:", err)
        setAgentAccess((prev) =>
          prev.map((a) => (a.agentId === agentId ? { ...a, hasAccess: !nextHasAccess } : a)),
        )
        toast.error(
          nextHasAccess
            ? t("apps.errorGrantingAccess", "Could not grant access")
            : t("apps.errorRevokingAccess", "Could not revoke access"),
          err instanceof Error ? err.message : t("common.error", "Error"),
        )
      } finally {
        setTogglingAgentId(null)
      }
    },
    [app, togglingAgentId, client, toast, t],
  )

  // Auth handlers
  const handleCredentialChange = useCallback((name: string, value: string) => {
    setCredentialValues((prev) => ({ ...prev, [name]: value }))
    setHasCredentialChanges(true)
  }, [])

  const handleSaveCredentials = useCallback(async () => {
    if (!app) return

    // Collect all configurable fields (apikey + oauth extraFields)
    const allFields = [
      ...(backendAuthInfo?.apikey?.fields || []),
      ...(backendAuthInfo?.oauth?.extraFields || []),
    ]

    if (allFields.length === 0) return

    // Validate required fields
    const emptyRequiredFields = allFields
      .filter((field) => field.required && !credentialValues[field.name]?.trim())
      .map((field) => field.label || field.name)

    if (emptyRequiredFields.length > 0) {
      toast.error(
        t("apps.requiredFields"),
        t("apps.pleaseComplete", { fields: emptyRequiredFields.join(", ") }),
      )
      return
    }

    // Only send fields that have been locally edited (credentialValues)
    // This ensures we do a minimal merge — never wiping tokens we didn't touch
    const toSave: Record<string, string> = {}
    for (const [key, val] of Object.entries(credentialValues)) {
      if (val !== undefined) toSave[key] = val
    }

    if (Object.keys(toSave).length === 0) return

    setSavingCredentials(true)
    try {
      await client.app.configureCredentials(app.appId, toSave)
      toast.success(t("apps.saved"), t("apps.credentialsSaved"))
      setHasCredentialChanges(false)
      await loadAuthStatus(app.appId)
    } catch (err) {
      console.error("Save credentials failed:", err)
      toast.error(
        t("apps.error"),
        err instanceof Error ? err.message : t("apps.errorSavingCredentials"),
      )
    } finally {
      setSavingCredentials(false)
    }
  }, [app, backendAuthInfo, credentialValues, client, toast, loadAuthStatus])

  const handleConnect = useCallback(async () => {
    if (!app) return

    setConnecting(true)
    try {
      await client.connectAppOAuth(app.appId)
      toast.success(t("apps.connected"), t("apps.accountConnected"))
      await loadAuthStatus(app.appId)
    } catch (err) {
      console.error("OAuth connect failed:", err)
      toast.error(t("apps.error"), err instanceof Error ? err.message : t("apps.errorConnecting"))
    } finally {
      setConnecting(false)
    }
  }, [app, client, toast, loadAuthStatus])

  const handleDisconnect = useCallback(async () => {
    if (!app) return

    setDisconnecting(true)
    try {
      await client.app.disconnectAuth(app.appId)
      toast.success(t("apps.disconnected"), t("apps.accountDisconnected"))
      await loadAuthStatus(app.appId)
    } catch (err) {
      console.error("Disconnect failed:", err)
      toast.error(
        t("apps.error"),
        err instanceof Error ? err.message : t("apps.errorDisconnecting"),
      )
    } finally {
      setDisconnecting(false)
    }
  }, [app, client, toast, loadAuthStatus])

  const handleRefresh = useCallback(async () => {
    if (!app) return
    await loadAuthStatus(app.appId)
  }, [app, loadAuthStatus])

  // Permission handlers
  const handleToolPermissionChange = useCallback(
    async (toolName: string, permission: ToolPermission) => {
      if (!app || !permissionsData) return

      setPermissionsData((prev) => {
        if (!prev) return prev
        // Toggling pins the tool explicitly → it is no longer auto-allowed by
        // the read-only policy. Recompute the EFFECTIVE summary from the tools
        // (effective = autoAllowed ? 'allow' : permission) so the header stays
        // consistent with the per-row badges and with the backend.
        const tools = prev.tools.map((t) =>
          t.name === toolName ? { ...t, permission, autoAllowed: false } : t,
        )
        const summary = { allow: 0, ask: 0, forbid: 0 }
        for (const t of tools) summary[t.autoAllowed ? "allow" : t.permission]++
        return { ...prev, tools, summary }
      })

      setPermissionsSaving(true)
      try {
        await client.app.updateToolPermission(app.appId, toolName, permission)
      } catch (err) {
        console.error("Failed to update tool permission:", err)
        toast.error(t("apps.error"), t("apps.errorUpdatingPermission"))
        await loadPermissions(app.appId)
      } finally {
        setPermissionsSaving(false)
      }
    },
    [app, permissionsData, client, toast, loadPermissions],
  )

  const handleSetAllPermissions = useCallback(
    async (permission: ToolPermission) => {
      if (!app) return

      setPermissionsSaving(true)
      try {
        await client.setAllToolPermissions(app.appId, permission)
        await loadPermissions(app.appId)
        toast.success(t("apps.updated"), t("apps.allPermissionsChanged", { permission }))
      } catch (err) {
        console.error("Failed to set all permissions:", err)
        toast.error(t("apps.error"), t("apps.errorUpdatingPermissions"))
      } finally {
        setPermissionsSaving(false)
      }
    },
    [app, client, toast, loadPermissions],
  )

  // Context handlers
  const startEditingContext = () => {
    if (app) {
      setContextText(app.context || "")
      setEditContextOpen(true)
    }
  }

  const handleSaveContext = async () => {
    if (!app || !contextText.trim()) return

    setIsContextSaving(true)
    try {
      const result = await client.updateApp(app.appId, { context: contextText.trim() })

      if (result.error) {
        toast.error(t("apps.error"), result.error || t("apps.errorUpdatingContext"))
        return
      }

      toast.success(t("apps.saved"), t("apps.contextUpdated"))
      setEditContextOpen(false)
      setContextText("")
      setIsContextSaving(false)
    } catch (error) {
      console.error("Error saving app context:", error)
      toast.error(t("apps.error"), t("apps.errorUpdatingContext"))
    } finally {
      setIsContextSaving(false)
    }
  }

  // Rename handlers
  const startEditing = () => {
    if (app) {
      setEditingName(app.name)
      setIsEditing(true)
    }
  }

  const cancelEditing = () => {
    setIsEditing(false)
    setEditingName("")
  }

  const handleRename = useCallback(async () => {
    if (!app) return

    const trimmedName = editingName.trim()
    if (!trimmedName || trimmedName === app.name) {
      cancelEditing()
      return
    }

    setIsRenaming(true)
    try {
      await client.app.renameApp(app.appId, trimmedName)
      setApp((prev) => (prev ? { ...prev, name: trimmedName } : prev))
      toast.success(t("apps.renamed"), t("apps.appRenamed", { name: trimmedName }))
      cancelEditing()
    } catch (err: any) {
      console.error("Error renaming app:", err)
      toast.error(t("apps.error"), err.message || t("apps.errorRenamingApp"))
    } finally {
      setIsRenaming(false)
    }
  }, [app, editingName, client, toast])

  /** MUW-REQ-27: rename, then share — the only way out of a NAME_COLLISION. */
  const handleRenameAndShare = useCallback(async () => {
    if (!app || !collisionName) return
    const newName = collisionName.trim()
    if (!newName) return
    setIsChangingScope(true)
    try {
      await client.app.renameApp(app.appId, newName)
      setApp((prev) => (prev ? { ...prev, name: newName } : prev))
      await client.app.setScope(app.appId, "shared")
      setApp((prev) => (prev ? { ...prev, scope: "shared" } : prev))
      setCollisionName(null)
      toast.success(t("apps.scopeChanged", "Scope updated"), t("apps.scopeChangedShared"))
    } catch (err: any) {
      console.error("Rename and share failed:", err)
      toast.error(t("apps.scopeChangeError", "Failed to change scope"), err?.message ?? "")
    } finally {
      setIsChangingScope(false)
    }
  }, [app, collisionName, client, toast, t])

  // Uninstall handler
  const handleUninstall = useCallback(async () => {
    if (!app) return

    const doUninstall = async () => {
      setIsUninstalling(true)
      try {
        await client.app.uninstallApp(app.appId)
        toast.success(t("apps.uninstalled"), t("apps.appUninstalled", { name: app.name }))
        // Navigate back to apps list
        router.back()
      } catch (err: any) {
        console.error("Error uninstalling app:", err)
        toast.error(t("apps.error"), err.message || t("apps.errorUninstallingApp"))
        setIsUninstalling(false)
      }
    }

    // Show confirmation - use window.confirm on web, Alert on native
    if (Platform.OS === "web") {
      const confirmed = window.confirm(t("apps.uninstallConfirmMessage", { name: app.name }))
      if (confirmed) {
        await doUninstall()
      }
    } else {
      Alert.alert(t("apps.uninstallApp"), t("apps.uninstallConfirmMessage", { name: app.name }), [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("apps.uninstall"),
          style: "destructive",
          onPress: doUninstall,
        },
      ])
    }
  }, [app, client, toast, router])

  // App scope handler (REQ-6) — change between 'personal' and 'shared'
  const handleSetScope = useCallback(
    async (newScope: "personal" | "shared") => {
      if (!app || isChangingScope) return
      // No change needed
      if ((app.scope ?? "personal") === newScope) return

      setIsChangingScope(true)
      // Optimistic update — revert on error
      const prevScope = app.scope ?? "personal"
      setApp((prev) => (prev ? { ...prev, scope: newScope } : prev))
      try {
        await client.app.setScope(app.appId, newScope)
        toast.success(
          t("apps.scopeChanged", "Scope updated"),
          newScope === "personal"
            ? t(
                "apps.scopeChangedPersonal",
                "This app is now personal — it uses your credentials and is blocked in shared conversations.",
              )
            : t(
                "apps.scopeChangedShared",
                "This app is now shared — it uses workspace credentials and works in all conversations.",
              ),
        )
      } catch (err: any) {
        if (err?.code === "NAME_COLLISION") {
          // MUW-REQ-27: the name clashes with another member's private app once
          // shared. Revert, and ask for a new name — rename + share in one step.
          setApp((prev) => (prev ? { ...prev, scope: prevScope } : prev))
          setCollisionName(`${app.name}-shared`)
          setIsChangingScope(false)
          return
        }
        console.error("Failed to set app scope:", err)
        setApp((prev) => (prev ? { ...prev, scope: prevScope } : prev))
        toast.error(
          t("apps.scopeChangeError", "Failed to change scope"),
          err instanceof Error ? err.message : t("common.error", "Error"),
        )
      } finally {
        setIsChangingScope(false)
      }
    },
    [app, isChangingScope, client, toast, t],
  )

  // Load app on mount
  useEffect(() => {
    const loadApp = async () => {
      if (!appId) {
        setError(t("apps.noAppId"))
        setLoading(false)
        return
      }

      try {
        // Use workspaceId to find apps in the correct scope
        const { apps } = await client.workspace.listWorkspaceApps(
          workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? "",
        )

        const found = apps.find(
          (a) =>
            a.appId === appId ||
            a.appId === `app:${appId}` ||
            a.appId.replace("app:", "") === appId,
        )

        if (found) {
          setApp(found as any)
          loadAuthStatus(found.appId)
          loadPermissions(found.appId)
          loadAgentAccess(found.appId)
        } else {
          setError(t("apps.appNotFound", { appId }))
        }
      } catch (err) {
        console.error("Failed to load app:", err)
        setError(err instanceof Error ? err.message : t("errors.app.loadFailed"))
      } finally {
        setLoading(false)
      }
    }

    if (client.isConnected()) {
      loadApp()
    } else {
      const onConnected = () => {
        loadApp()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)
      return () => {
        client.off("connected", onConnected)
      }
    }
  }, [appId, workspaceId, client, loadAuthStatus, loadPermissions])

  // Listen for app.updated events to keep scope in sync (REQ-6)
  // When another session changes the scope, update the local state.
  useEffect(() => {
    if (!appId) return
    const handleAppUpdated = (data: any) => {
      if (data?.app?.appId === appId && data?.app?.scope) {
        setApp((prev) => (prev ? { ...prev, scope: data.app.scope } : prev))
      }
    }
    client.on("app.updated", handleAppUpdated)
    return () => {
      client.off("app.updated", handleAppUpdated)
    }
  }, [appId, client])

  if (loading) {
    return <FullscreenLoader variant="default" label={t("apps.loadingApp")} />
  }

  if (error) {
    return (
      <Page>
        <EmptyState icon="warning" title={t("apps.error")} text={error} />
      </Page>
    )
  }

  const oauthInfo = getOAuthInfo()
  const credentialFields = getCredentialFields()
  const tools: ToolWithPermission[] = permissionsData?.tools || []

  // Hero presentation values (pure derivations — no logic).
  const conn = deriveConnection(backendAuthInfo, t)
  // Primary hero action mirrors the connection state. The actual work is still
  // done by the existing handlers / the AuthPanel below — this is the prominent
  // shortcut, placed where the eye lands first (hero, top-right).
  const heroAction: { label: string; kind: "connect" | "disconnect"; busy: boolean } | null =
    conn.state === "connected"
      ? {
          label: t("apps.disconnect", { defaultValue: "Disconnect" }),
          kind: "disconnect",
          busy: disconnecting,
        }
      : conn.state === "needs_signin"
        ? {
            label: t("apps.connect", { defaultValue: "Connect" }),
            kind: "connect",
            busy: connecting,
          }
        : conn.state === "error"
          ? {
              label: t("apps.reconnect", { defaultValue: "Reconnect" }),
              kind: "connect",
              busy: connecting,
            }
          : null

  const currentScope = app?.scope ?? "personal"
  const agentsWithAccess = agentAccess.filter((a) => a.hasAccess).length

  const tabs: Array<{ key: Tab; label: string; icon: string; count?: number }> = [
    {
      key: "overview",
      label: t("apps.tabOverview", { defaultValue: "Overview" }),
      icon: "plugs-connected",
    },
    {
      key: "permissions",
      label: t("apps.permissions", "Permissions"),
      icon: "shield-check",
      count: tools.length || undefined,
    },
    {
      key: "agents",
      label: t("apps.agents", "Agents"),
      icon: "users-three",
      count: agentAccess.length ? agentsWithAccess : undefined,
    },
    {
      key: "settings",
      label: t("apps.tabSettings", { defaultValue: "Settings" }),
      icon: "gear-six",
    },
  ]

  return (
    <View style={{ flex: 1 }}>
      <Page>
        {app && (
          <>
            {/* ── HERO ───────────────────────────────────────────────────────
              Identity (Tile + name + mcaId·category), the connection status
              badge — the single most important fact about an installed app —
              and the primary connection action at the right. */}
            <Card xl pad={32} style={{ marginBottom: 20 }}>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 24, flexWrap: "wrap" }}
              >
                <Tile lg>
                  {isImageUrl(app.icon) ? (
                    <Image
                      source={{ uri: app.icon }}
                      style={{ width: 72, height: 72 }}
                      resizeMode="cover"
                    />
                  ) : isEmoji(app.icon) ? (
                    <T step="2xl" style={{ fontSize: 32, lineHeight: 40 }}>
                      {app.icon}
                    </T>
                  ) : (
                    <McaIcon
                      icon={app.icon}
                      mcaId={app.mcaId}
                      size={40}
                      color={c.accent}
                      backgroundColor="transparent"
                      borderRadius={0}
                    />
                  )}
                </Tile>

                <View style={{ flex: 1, minWidth: 240, gap: 6 }}>
                  {isEditing ? (
                    <Field
                      value={editingName}
                      onChangeText={setEditingName}
                      onSubmitEditing={handleRename}
                      autoFocus
                      lg
                      containerStyle={{ maxWidth: 460, height: 48 }}
                      style={{ fontFamily: FONT_SERIF, fontSize: 28, letterSpacing: -0.5 }}
                      right={
                        <View style={{ flexDirection: "row", gap: 2 }}>
                          {isRenaming ? (
                            <AppSpinner size="sm" variant="default" />
                          ) : (
                            <IconBtn
                              icon="check"
                              plain
                              sm
                              onPress={handleRename}
                              title={t("common.save")}
                            />
                          )}
                          <IconBtn
                            icon="x"
                            plain
                            sm
                            onPress={cancelEditing}
                            title={t("common.cancel")}
                          />
                        </View>
                      }
                    />
                  ) : (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <T step="2xl" ellipsis style={{ flexShrink: 1 }}>
                        {app.name || appId}
                      </T>
                      <IconBtn
                        icon="pencil-simple"
                        plain
                        sm
                        onPress={startEditing}
                        title={t("common.edit")}
                      />
                    </View>
                  )}
                  <T step="code" tone="text3" ellipsis>
                    {app.mcaId}
                    {app.category ? ` · ${app.category}` : ""}
                  </T>

                  {/* Status badge + identity — the headline fact about this install */}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                      marginTop: 8,
                    }}
                  >
                    <Badge tone={conn.tone} dot={conn.tone !== "muted"} lg pill>
                      {conn.label}
                    </Badge>
                    {/* Connection transparency (HubSpot/Salesforce): show the
                      connected account so the user knows *whose* access this is. */}
                    {conn.identity ? (
                      <T step="sm" tone="text2" ellipsis>
                        {t("apps.connectedAs", { defaultValue: "as" })}{" "}
                        <T step="code13" tone="text">
                          {conn.identity}
                        </T>
                      </T>
                    ) : null}
                    {/* Manual refresh of auth status — quiet, secondary */}
                    {authLoading ? (
                      <AppSpinner size="sm" variant="default" />
                    ) : (
                      <IconBtn
                        icon="arrows-clockwise"
                        plain
                        sm
                        onPress={() => loadAuthStatus(app.appId)}
                        title={t("apps.refreshStatus", { defaultValue: "Refresh status" })}
                      />
                    )}
                  </View>
                </View>

                {/* Primary connection action (top-right) */}
                {heroAction?.kind === "disconnect" ? (
                  <DisconnectButton
                    provider={oauthInfo?.provider ?? app.name}
                    label={heroAction.label}
                    busy={heroAction.busy}
                    onConfirm={handleDisconnect}
                  />
                ) : heroAction ? (
                  <Btn variant="primary" icon="plugs-connected" loading={heroAction.busy} onPress={handleConnect}>
                    {heroAction.label}
                  </Btn>
                ) : null}
              </View>
            </Card>

            {app.description ? (
              <T step="base" tone="text2" style={{ maxWidth: 620, marginBottom: 20 }}>
                {app.description}
              </T>
            ) : null}

            <PTabs<Tab> value={tab} onChange={setTab} items={tabs} style={{ marginBottom: 20 }} />

            {/* ── OVERVIEW: CONNECTION ──────────────────────────────────────
              The AuthPanel already renders status, connected account and
              connect/disconnect/credentials controls. */}
            {tab === "overview" ? (
              <View>
                <SectionLabel label={t("apps.connection", "Connection")} />
                <AuthPanel
                  oauth={oauthInfo}
                  credentials={credentialFields}
                  loading={authLoading}
                  hasChanges={hasCredentialChanges}
                  saving={savingCredentials}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                  onRefresh={handleRefresh}
                  connecting={connecting}
                  disconnecting={disconnecting}
                  onCredentialChange={handleCredentialChange}
                  onSaveCredentials={handleSaveCredentials}
                  defaultExpanded={true}
                  systemSetupMessage={
                    backendAuthInfo?.status === "needs_system_setup"
                      ? backendAuthInfo.message
                      : undefined
                  }
                />
              </View>
            ) : null}

            {/* ── PERMISSIONS ─────────────────────────────────────────────
              Default permission + per-tool toggles. */}
            {tab === "permissions" ? (
              <View>
                <SectionLabel
                  label={t("apps.permissions", "Permissions")}
                  count={tools.length || undefined}
                />
                <T step="12" tone="text3" style={{ marginBottom: 12 }}>
                  {t(
                    "apps.permissionsHint",
                    "Per tool: Auto runs without asking · Confirm asks you each time · Block forbids it entirely.",
                  )}
                </T>
                {tools.length > 0 || permissionsLoading ? (
                  <PermissionsPanel
                    tools={tools}
                    summary={permissionsData?.summary}
                    loading={permissionsLoading}
                    saving={permissionsSaving}
                    onToolPermissionChange={handleToolPermissionChange}
                    onSetAllPermissions={handleSetAllPermissions}
                    defaultExpanded={true}
                  />
                ) : (
                  <EmptyState
                    icon="shield-check"
                    title={t("apps.noTools", { defaultValue: "This app exposes no tools yet." })}
                  />
                )}
              </View>
            ) : null}

            {/* ── AGENTS ──────────────────────────────────────────────────
              Which of the workspace's agents can use this app. The inverse
              view (an agent's apps) lives in the AgentWindow; toggling here
              drives the same grant/revoke, so both stay in sync. */}
            {tab === "agents" ? (
              <View>
                <SectionLabel
                  label={t("apps.agents", "Agents")}
                  count={
                    agentAccess.length ? `${agentsWithAccess}/${agentAccess.length}` : undefined
                  }
                />
                <T step="12" tone="text3" style={{ marginBottom: 12 }}>
                  {t("apps.agentsHint", "Choose which agents in this workspace can use this app.")}
                </T>
                {agentAccessLoading ? (
                  <AppSpinner />
                ) : agentAccess.length === 0 ? (
                  <EmptyState
                    icon="users-three"
                    title={t("apps.noAgents", { defaultValue: "No agents in this workspace yet." })}
                  />
                ) : (
                  <LGroup>
                    {agentAccess.map((agent) => (
                      <LRow key={agent.agentId}>
                        <Avatar imageUrl={agent.avatarUrl} name={agent.name} size={32} isAgent />
                        <View
                          style={{
                            flex: 1,
                            minWidth: 0,
                            flexDirection: "row",
                            alignItems: "baseline",
                            gap: 6,
                          }}
                        >
                          <T step="sm" ellipsis style={{ flexShrink: 1 }}>
                            {agent.name}
                          </T>
                          {agent.role ? (
                            <T step="sm" tone="text3" ellipsis style={{ flexShrink: 1 }}>
                              · {agent.role}
                            </T>
                          ) : null}
                        </View>
                        {togglingAgentId === agent.agentId ? (
                          <AppSpinner size="sm" variant="default" />
                        ) : null}
                        <Switch
                          on={agent.hasAccess}
                          disabled={togglingAgentId === agent.agentId}
                          onToggle={() => handleToggleAgent(agent.agentId, !agent.hasAccess)}
                        />
                      </LRow>
                    ))}
                  </LGroup>
                )}
              </View>
            ) : null}

            {/* ── SETTINGS: instructions · scope · danger zone ─────────────── */}
            {tab === "settings" ? (
              <View style={{ gap: 28 }}>
                {/* Instructions / context — hidden behind progressive disclosure:
                  advanced, optional, so collapsed until requested. */}
                <View>
                  <SectionLabel label={t("apps.instructions", "Instructions")} />
                  <LGroup>
                    <LRow
                      hov
                      onPress={() => {
                        // No instructions yet → jump straight to the editor.
                        // Otherwise toggle the inline preview (progressive disclosure).
                        if (!app.context) {
                          startEditingContext()
                        } else {
                          setInstructionsExpanded((v) => !v)
                        }
                      }}
                    >
                      <Tile sm icon="file-text" />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T step="sm">{t("apps.instructions", "Instructions")}</T>
                        <T step="12" tone="text3">
                          {t(
                            "apps.instructionsHint",
                            "Added to an agent's prompt whenever it has access to this app.",
                          )}
                        </T>
                      </View>
                      {app.context ? (
                        <Ph
                          name={instructionsExpanded ? "caret-up" : "caret-down"}
                          size={14}
                          color={c.text3}
                        />
                      ) : (
                        <Btn variant="ghost" size="sm" icon="plus" onPress={startEditingContext}>
                          {t("apps.addInstructions", "Add instructions")}
                        </Btn>
                      )}
                    </LRow>
                    {app.context && instructionsExpanded ? (
                      <View style={{ padding: 16, gap: 12, backgroundColor: c.wash }}>
                        <T step="sm" tone="text2" style={{ lineHeight: 20 }}>
                          {app.context}
                        </T>
                        <Btn
                          variant="sec"
                          size="sm"
                          icon="pencil-simple"
                          onPress={startEditingContext}
                          style={{ alignSelf: "flex-start" }}
                        >
                          {t("apps.editInstructions", "Edit")}
                        </Btn>
                      </View>
                    ) : null}
                  </LGroup>
                </View>

                {/* App scope (REQ-6): 'personal' vs 'shared'. Defaults to
                  'personal' when scope is missing. */}
                <View>
                  <SectionLabel label={t("apps.scope", "App scope")} />
                  <T step="12" tone="text3" style={{ marginBottom: 12 }}>
                    {t(
                      "apps.scopeHint",
                      "Personal apps use your own credentials and are blocked in shared conversations. Shared apps use workspace credentials and work in all conversations.",
                    )}
                  </T>
                  <Card pad={6}>
                    <OptionRow
                      on={currentScope === "shared"}
                      title={t("apps.scopeShared", "Shared")}
                      sub={t(
                        "apps.scopeSharedDesc",
                        "Workspace credentials · works in all conversations",
                      )}
                      onPress={() => (isChangingScope ? undefined : handleSetScope("shared"))}
                    />
                    <OptionRow
                      on={currentScope === "personal"}
                      title={t("apps.scopePersonal", "Personal")}
                      sub={t(
                        "apps.scopePersonalDesc",
                        "Your credentials · blocked in shared conversations",
                      )}
                      onPress={() => (isChangingScope ? undefined : handleSetScope("personal"))}
                    />
                  </Card>
                  {isChangingScope ? (
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 8,
                        paddingHorizontal: 4,
                      }}
                    >
                      <AppSpinner size="sm" variant="default" />
                      <T step="12" tone="text3">
                        {t("apps.scopeChanging", "Changing scope…")}
                      </T>
                    </View>
                  ) : null}
                  {collisionName !== null ? (
                    <Card pad={12} style={{ marginTop: 12, gap: 8 }} testID="app-scope-collision">
                      <T step="base">{t("apps.collisionTitle", "Rename before sharing")}</T>
                      <T step="12" tone="text3">
                        {t("apps.collisionHint")}
                      </T>
                      <Field
                        value={collisionName}
                        onChangeText={setCollisionName}
                        autoCapitalize="none"
                        autoCorrect={false}
                        testID="app-scope-collision-name"
                      />
                      <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                        <Btn variant="sec" onPress={() => setCollisionName(null)}>
                          {t("common.cancel", "Cancel")}
                        </Btn>
                        <Btn
                          variant="primary"
                          loading={isChangingScope}
                          disabled={!collisionName.trim() || isChangingScope}
                          onPress={handleRenameAndShare}
                          testID="app-scope-collision-submit"
                        >
                          {t("apps.collisionRenameAndShare", "Rename and share")}
                        </Btn>
                      </View>
                    </Card>
                  ) : null}
                </View>

                {/* Danger zone — destructive action isolated at the bottom, gated
                  by the existing confirmation in handleUninstall. */}
                <View>
                  <SectionLabel label={t("apps.dangerZone", "Danger zone")} />
                  <DangerZone
                    title={t("apps.uninstallApp")}
                    text={t(
                      "apps.uninstallDescription",
                      "Removes the app and all its settings from this workspace. This cannot be undone.",
                    )}
                    action={
                      <Btn
                        variant="dangerSoft"
                        icon="trash"
                        loading={isUninstalling}
                        onPress={handleUninstall}
                      >
                        {t("apps.uninstall", "Uninstall")}
                      </Btn>
                    }
                  />
                </View>
              </View>
            ) : null}
          </>
        )}
      </Page>

      {/* Context Edit Modal */}
      {editContextOpen ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(23, 20, 31, 0.55)",
            justifyContent: "center",
            alignItems: "center",
            padding: 20,
            zIndex: 1000,
          }}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setEditContextOpen(false)
              setContextText("")
              setIsContextSaving(false)
            }}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          />
          <Card xl pad={24} style={{ width: "100%", maxWidth: 520 }}>
            <T step="xl" style={{ marginBottom: 16 }}>
              {t("apps.editContext")}
            </T>
            <Field
              area
              minHeight={160}
              value={contextText}
              onChangeText={setContextText}
              placeholder={t("apps.contextPlaceholder")}
              autoFocus
            />
            <View
              style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 20 }}
            >
              <Btn
                variant="ghost"
                onPress={() => {
                  setEditContextOpen(false)
                  setContextText("")
                  setIsContextSaving(false)
                }}
              >
                {t("common.cancel")}
              </Btn>
              <Btn
                variant="primary"
                icon="check"
                loading={isContextSaving}
                disabled={!contextText.trim()}
                onPress={handleSaveContext}
              >
                {t("common.save")}
              </Btn>
            </View>
          </Card>
        </View>
      ) : null}
    </View>
  )
}
