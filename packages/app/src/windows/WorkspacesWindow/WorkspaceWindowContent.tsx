/**
 * Workspace Window Content
 *
 * Shows details of a single workspace: volume, apps, agents, members.
 *
 * Look: the OS prototype's workspace settings card — tile + serif name +
 * badges, a mint banner for the private space, PTabs for Chats / Agentes /
 * Apps / Miembros / Contexto, LGroup lists and centred modal cards for the
 * install-app / appearance / context editors (COLOR swatches + ICONO grid).
 */

import { useLucideIcons } from "../../lib/lucideIcons"
import {
  COLOR_PALETTE,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  type WorkspaceColor,
} from "@teros/shared"
import React, { useCallback, useEffect, useState } from "react"
import { Image, Platform, Pressable, ScrollView, View } from "react-native"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import { AppCard } from "../../components/AppCard"
import type { AppAuthInfo } from "../../components/apps"
import { useToast } from "../../components/Toast"
import { WorkspaceIcon } from "../../components/WorkspaceIcon"
import { Avatar } from "../../components/Avatar"
import { useClickModifiers } from "../../hooks/useClickModifiers"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useAuthStore } from "../../store/authStore"
import type { WorkspaceWindowProps } from "./definition"
import { AppSpinner, FullscreenLoader } from "../../components/ui"
import { ContextEditor } from "../../components/ContextEditor"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  Btn,
  ChipBtn,
  CountPill,
  EmptyState,
  Field,
  FieldHelp,
  FieldLabel,
  IconBtn,
  LGroup,
  LRow,
  Page,
  Ph,
  PTabs,
  T,
} from "../../components/ui/ds"

interface WorkspaceDetails {
  workspaceId: string
  name: string
  description?: string
  context?: string
  volumeId?: string
  ownerId?: string
  members?: Array<{
    role: "admin" | "write" | "read"
    status: "active" | "pending"
    joinedAt: string
    addedAt?: string
    addedBy?: string
    email?: string
    invitation?: {
      invitedBy: string
      invitedAt: string
      sentAt: string[]
      acceptedAt?: string
      cancelledAt?: string
    }
  }>
  settings?: {
    defaultBranch?: string
  }
  appearance?: {
    color?: string
    icon?: string
  }
  /** Workspace type — 'private' is the user's personal workspace and cannot be deleted/archived */
  type?: "private" | "shared"
  role?: string
  status: string
  createdAt: string
  updatedAt?: string
}

/** Human member with profile data (from workspace.list-humans — owner + active members). */
interface HumanMember {
  userId: string
  displayName: string
  avatarUrl?: string
  email: string
  role: string
  status: string
}

/** Row model for the members panel: an active human or a pending invitation. */
interface MemberRow {
  key: string
  /** Account id — active members only (pending invitations have no account yet). */
  userId?: string
  email?: string
  /** Display name — pending members have none (no account yet). */
  displayName?: string
  avatarUrl?: string
  role: string
  status: "active" | "pending"
  /** Display name of the inviter (pending only, resolved server-side — Guard 2). */
  invitedBy?: string
}

interface WorkspaceApp {
  appId: string
  name: string
  mcaId: string
  mcaName?: string
  description: string
  icon?: string
  color?: string
  category: string
  status: string
  volumes?: any[]
}

interface WorkspaceAgent {
  agentId: string
  name: string
  fullName: string
  role: string
  intro: string
  avatarUrl?: string
  coreId?: string
}

interface AgentCore {
  coreId: string
  name: string
  fullName: string
  version: string
  personality: string[]
  capabilities: string[]
  avatarUrl?: string
  status: string
}

interface WorkspaceChannel {
  channelId: string
  agentId: string
  status: "active" | "closed"
  metadata: {
    name?: string
  }
  createdAt: string
  updatedAt: string
  lastMessage?: {
    content: string
    timestamp: string
    role?: "user" | "assistant"
  }
  unreadCount?: number
}

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
  }
}

const roleIcons: Record<string, { icon: string }> = {
  owner: { icon: "crown" },
  admin: { icon: "gear-six" },
  write: { icon: "pencil-simple" },
  read: { icon: "eye" },
}

type TabType = "conversations" | "agents" | "apps" | "members" | "context"
type ModalType = "none" | "install-app" | "edit-appearance" | "edit-context" | "add-member"

interface WorkspaceWindowContentProps extends WorkspaceWindowProps {
  windowId: string
}

export function WorkspaceWindowContent({ windowId, workspaceId }: WorkspaceWindowContentProps) {
  const { t } = useTranslation()
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null)
  const [workspaceApps, setWorkspaceApps] = useState<WorkspaceApp[]>([])
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgent[]>([])
  const [workspaceChannels, setWorkspaceChannels] = useState<WorkspaceChannel[]>([])
  const [memberRows, setMemberRows] = useState<MemberRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingApps, setIsLoadingApps] = useState(false)
  const [isLoadingAgents, setIsLoadingAgents] = useState(false)
  const [isLoadingChannels, setIsLoadingChannels] = useState(false)
  const [isLoadingMembers, setIsLoadingMembers] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>("conversations")
  const [activeModal, setActiveModal] = useState<ModalType>("none")
  const [authStatuses, setAuthStatuses] = useState<Record<string, AppAuthInfo | null>>({})
  const [loadingAuthStatus, setLoadingAuthStatus] = useState<Record<string, boolean>>({})

  // Create agent modal state

  // Install app modal state
  const [catalog, setCatalog] = useState<CatalogMca[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [installingMcaId, setInstallingMcaId] = useState<string | null>(null)

  // Edit appearance modal state
  const [selectedColor, setSelectedColor] = useState<string>("amber")
  const [selectedIcon, setSelectedIcon] = useState<string>("folder")
  const [savingAppearance, setSavingAppearance] = useState(false)
  const [iconSearch, setIconSearch] = useState<string>("")
  // Searching lists every Lucide name: that set is its own chunk, fetched on first search.
  const LucideIcons = useLucideIcons(iconSearch.trim() !== "")

  // Edit context state
  const [savingContext, setSavingContext] = useState(false)
  const [contextText, setContextText] = useState(workspace?.context || "")

  // Add member modal state (MUW-14)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<"admin" | "write" | "read">("write")
  const [isInviting, setIsInviting] = useState(false)
  /** Per-email busy flag for row actions (resend / revoke). */
  const [memberActionBusy, setMemberActionBusy] = useState<Record<string, boolean>>({})

  const client = getTerosClient()
  const toast = useToast()
  const { closeWindow, updateWindowProps, openWindow } = useTilingStore()
  const { shouldOpenInNewTab } = useClickModifiers()
  const c = useColors()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  // Load workspace details on mount
  useEffect(() => {
    const loadData = async () => {
      if (!workspaceId) return

      setIsLoading(true)
      try {
        const { workspace: data } = await client.workspace.getWorkspace(workspaceId)
        setWorkspace(data)
        updateWindowProps(windowId, { name: data.name })
        loadWorkspaceChannels(workspaceId)
        loadWorkspaceApps(workspaceId)
        loadWorkspaceAgents(workspaceId)
        loadWorkspaceMembers(workspaceId, data.members)
      } catch (err: any) {
        console.error("Error loading workspace:", err)
        toast.error(t("workspaceDetail.error"), t("workspaceDetail.loadError"))
      } finally {
        setIsLoading(false)
      }
    }

    if (client.isConnected()) {
      loadData()
    } else {
      const onConnected = () => {
        client.off("connected", onConnected)
        loadData()
      }
      client.on("connected", onConnected)
      return () => client.off("connected", onConnected)
    }
  }, [workspaceId])

  const loadWorkspaceApps = async (wsId: string) => {
    setIsLoadingApps(true)
    try {
      const { apps } = await client.workspace.listWorkspaceApps(wsId)
      setWorkspaceApps(apps)
      loadAllAuthStatuses(apps)
    } catch (err: any) {
      console.error("Error loading workspace apps:", err)
    } finally {
      setIsLoadingApps(false)
    }
  }

  const loadWorkspaceAgents = async (wsId: string) => {
    setIsLoadingAgents(true)
    try {
      const agents = await client.agent.listAgents(wsId).then((r) => r.agents)
      setWorkspaceAgents(agents)
    } catch (err: any) {
      console.error("Error loading workspace agents:", err)
    } finally {
      setIsLoadingAgents(false)
    }
  }

  const loadWorkspaceChannels = async (wsId: string) => {
    setIsLoadingChannels(true)
    try {
      const { channels } = await client.channel.list(wsId)
      setWorkspaceChannels(channels as WorkspaceChannel[])
    } catch (err: any) {
      console.error("Error loading workspace channels:", err)
    } finally {
      setIsLoadingChannels(false)
    }
  }

  /**
   * Load the members panel rows (MUW-14).
   *
   * Two sources merged:
   *  - `workspace.list-humans` → owner + active members WITH profile data
   *    (displayName, avatar, email, role). Pending members are excluded there
   *    by design (that endpoint feeds task assignee selectors).
   *  - `pendingFromGet` → the sanitized `workspace.members` payload from
   *    workspace.get (Guard 2: no userId): the pending invitations, keyed by
   *    email, with invitation metadata.
   *
   * Merge key: normalized email. Active humans win; pending entries that
   * already resolved to an active account are skipped (shouldn't happen —
   * activation rewrites the entry — but defense in depth).
   *
   * `pendingFromGet` is passed explicitly by callers (not read from state) so
   * the mount effect can use the fresh workspace.get response without waiting
   * for a re-render.
   */
  const loadWorkspaceMembers = useCallback(
    async (wsId: string, pendingFromGet?: WorkspaceDetails["members"]) => {
      setIsLoadingMembers(true)
      try {
        const { humans } = await client.workspace.listHumans(wsId)

        // Active humans: owner first, then the rest
        const rows: MemberRow[] = humans.map((h) => ({
          key: `human:${h.userId}`,
          userId: h.userId,
          email: h.email,
          displayName: h.displayName,
          avatarUrl: h.avatarUrl,
          role: h.role,
          status: "active" as const,
        }))

        // Pending invitations from the sanitized workspace.get payload
        const activeEmails = new Set(
          rows.map((r) => r.email?.toLowerCase()).filter(Boolean) as string[],
        )
        for (const m of pendingFromGet ?? []) {
          const status = m.status ?? "active"
          const email = m.email?.toLowerCase()
          if (status !== "pending" || !email || activeEmails.has(email)) continue
          rows.push({
            key: `pending:${email}`,
            email,
            role: m.role,
            status: "pending",
            invitedBy: m.invitation?.invitedBy,
          })
        }

        setMemberRows(rows)
      } catch (err: any) {
        console.error("Error loading workspace members:", err)
      } finally {
        setIsLoadingMembers(false)
      }
    },
    [client],
  )

  // MUW-REQ-23: membership changes (accept, remove, role, revoke) refresh the
  // panel live; losing the membership closes the window.
  useEffect(() => {
    if (!workspaceId) return
    const onMembersChanged = async (data: any) => {
      if (data?.workspaceId !== workspaceId) return
      try {
        const { workspace: fresh } = await client.workspace.getWorkspace(workspaceId)
        loadWorkspaceMembers(workspaceId, fresh.members)
      } catch (err) {
        console.warn("[WorkspaceWindow] members refresh failed:", err)
      }
    }
    const onMembershipRemoved = (data: any) => {
      if (data?.workspaceId === workspaceId) closeWindow(windowId)
    }
    client.on("workspace.members_changed", onMembersChanged)
    client.on("workspace.membership_removed", onMembershipRemoved)
    return () => {
      client.off("workspace.members_changed", onMembersChanged)
      client.off("workspace.membership_removed", onMembershipRemoved)
    }
  }, [workspaceId, client, closeWindow, windowId, loadWorkspaceMembers])

  const loadAuthStatus = useCallback(
    async (appId: string) => {
      setLoadingAuthStatus((prev) => ({ ...prev, [appId]: true }))
      try {
        const authInfo = (await client.app.getAuthStatus(appId)).auth
        setAuthStatuses((prev) => ({ ...prev, [appId]: authInfo as any }))
      } catch (err) {
        console.error(`Error loading auth status for ${appId}:`, err)
        setAuthStatuses((prev) => ({ ...prev, [appId]: null }))
      } finally {
        setLoadingAuthStatus((prev) => ({ ...prev, [appId]: false }))
      }
    },
    [client],
  )

  const loadAllAuthStatuses = useCallback(
    async (apps: WorkspaceApp[]) => {
      await Promise.all(apps.map((app) => loadAuthStatus(app.appId)))
    },
    [loadAuthStatus],
  )

  const handleOpenChat = (channel: WorkspaceChannel, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow(
      "chat",
      {
        channelId: channel.channelId,
        workspaceId: workspaceId,
      },
      inNewTab,
      windowId,
    )
  }

  const handleNewChat = (agent: WorkspaceAgent, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        workspaceId: workspaceId,
      },
      inNewTab,
      windowId,
    )
  }

  const handleArchiveWorkspace = async () => {
    if (!workspace) return
    // Guard: private workspaces cannot be archived/deleted
    if (workspace.type === "private") {
      toast.error(t("workspaceDetail.notAllowed"), t("workspaceDetail.privateCannotArchive"))
      return
    }
    try {
      await client.workspace.archiveWorkspace(workspace.workspaceId)
      toast.success(
        t("workspaceDetail.archived"),
        t("workspaceDetail.archivedMessage", { name: workspace.name }),
      )
      closeWindow(windowId)
    } catch (err: any) {
      console.error("Error archiving workspace:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.archiveError"))
    }
  }

  const handleOpenAgent = (agent: WorkspaceAgent, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("agent", { agentId: agent.agentId, workspaceId }, inNewTab, windowId)
  }

  const handleOpenApp = (app: WorkspaceApp, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("app", { appId: app.appId }, inNewTab, windowId)
  }

  const handleUninstallApp = async (app: WorkspaceApp) => {
    if (!canEdit) return

    try {
      await client.app.uninstallApp(app.appId)
      setWorkspaceApps((prev) => prev.filter((a) => a.appId !== app.appId))
      toast.success(
        t("workspaceDetail.uninstalled"),
        t("workspaceDetail.uninstalledMessage", { name: app.name }),
      )
    } catch (err: any) {
      console.error("Error uninstalling app:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.uninstallError"))
    }
  }

  // ============================================================================
  // MEMBERS PANEL — MUW-14 (add / resend / revoke)
  // ============================================================================

  const openAddMemberModal = () => {
    setInviteEmail("")
    setInviteRole("write")
    setActiveModal("add-member")
  }

  /**
   * Add a member by email via the canonical MUW-14 flow.
   * Toast message distinguishes the two outcomes:
   *  - active → already had an account, added immediately
   *  - pending → no account, invitation email sent (best-effort)
   */
  const handleAddMember = async () => {
    if (!workspace) return
    const email = inviteEmail.trim().toLowerCase()
    if (!email || isInviting) return

    setIsInviting(true)
    try {
      const result = await client.workspace.addMember({
        workspaceId: workspace.workspaceId,
        email,
        role: inviteRole,
      })
      toast.success(
        t("workspaceDetail.members.invitedTitle"),
        result.status === "active"
          ? t("workspaceDetail.members.addedActive", { email: result.email })
          : result.invitationEmailSent
            ? t("workspaceDetail.members.invitedPending", { email: result.email })
            : t("workspaceDetail.members.invitedNoEmail", { email: result.email }),
      )
      setInviteEmail("")
      setActiveModal("none")
      // Refresh both the sanitized members payload and the panel rows
      const { workspace: fresh } = await client.workspace.getWorkspace(workspace.workspaceId)
      setWorkspace((prev) => (prev ? { ...prev, members: fresh.members } : prev))
      loadWorkspaceMembers(workspace.workspaceId, fresh.members)
    } catch (err: any) {
      console.error("Error adding member:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.members.addError"))
    } finally {
      setIsInviting(false)
    }
  }

  /** Resend the invitation email for a pending member (rate-limited 1/min). */
  const handleResendInvitation = async (email: string) => {
    if (!workspace || memberActionBusy[email]) return
    setMemberActionBusy((prev) => ({ ...prev, [email]: true }))
    try {
      await client.workspace.resendInvitation({ workspaceId: workspace.workspaceId, email })
      toast.success(
        t("workspaceDetail.members.invitedTitle"),
        t("workspaceDetail.members.resent", { email }),
      )
    } catch (err: any) {
      console.error("Error resending invitation:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.members.resendError"))
    } finally {
      setMemberActionBusy((prev) => ({ ...prev, [email]: false }))
    }
  }

  /** Revoke a pending membership — final: the entry disappears entirely. */
  const currentUserId = useAuthStore((s) => s.user?.userId)

  /** MUW-REQ-20 — remove an active member (owner/admin). */
  const handleRemoveMember = async (userId: string, label: string) => {
    if (!workspace) return
    setMemberActionBusy((prev) => ({ ...prev, [userId]: true }))
    try {
      await client.workspace.removeMember({ workspaceId: workspace.workspaceId, userId })
      setMemberRows((prev) => prev.filter((r) => r.userId !== userId))
      toast.success(t("workspaceDetail.members.removedTitle"), t("workspaceDetail.members.removed", { name: label }))
    } catch (err: any) {
      console.error("Error removing member:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.members.removeError"))
    } finally {
      setMemberActionBusy((prev) => ({ ...prev, [userId]: false }))
    }
  }

  /** MUW-REQ-21 — change an active member's role (owner/admin). */
  const handleSetMemberRole = async (userId: string, role: "admin" | "write" | "read", label: string) => {
    if (!workspace) return
    setMemberActionBusy((prev) => ({ ...prev, [userId]: true }))
    try {
      await client.workspace.setMemberRole({ workspaceId: workspace.workspaceId, userId, role })
      setMemberRows((prev) => prev.map((r) => (r.userId === userId ? { ...r, role } : r)))
      toast.success(
        t("workspaceDetail.members.roleUpdatedTitle"),
        t("workspaceDetail.members.roleUpdated", { name: label, role: t(`workspaceDetail.role_${role}`) }),
      )
    } catch (err: any) {
      console.error("Error changing member role:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.members.roleUpdateError"))
    } finally {
      setMemberActionBusy((prev) => ({ ...prev, [userId]: false }))
    }
  }

  /** MUW-REQ-22 — the current user leaves this workspace. */
  const handleLeaveWorkspace = async () => {
    if (!workspace) return
    try {
      await client.workspace.leaveWorkspace(workspace.workspaceId)
      toast.success(t("workspaceDetail.members.leftTitle"), t("workspaceDetail.members.left", { name: workspace.name }))
      closeWindow(windowId)
    } catch (err: any) {
      console.error("Error leaving workspace:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.members.leaveError"))
    }
  }

  const handleRevokeMember = async (email: string) => {
    if (!workspace || memberActionBusy[email]) return
    setMemberActionBusy((prev) => ({ ...prev, [email]: true }))
    try {
      await client.workspace.revokeMember({ workspaceId: workspace.workspaceId, email })
      toast.success(
        t("workspaceDetail.members.revokedTitle"),
        t("workspaceDetail.members.revoked", { email }),
      )
      const { workspace: fresh } = await client.workspace.getWorkspace(workspace.workspaceId)
      setWorkspace((prev) => (prev ? { ...prev, members: fresh.members } : prev))
      loadWorkspaceMembers(workspace.workspaceId, fresh.members)
    } catch (err: any) {
      console.error("Error revoking member:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.members.revokeError"))
    } finally {
      setMemberActionBusy((prev) => ({ ...prev, [email]: false }))
    }
  }

  // ============================================================================
  // CREATE AGENT MODAL
  // ============================================================================

  const openCreateAgentModal = () => {
    // Open the unified CreateAgentWindow with workspaceId
    openWindow("create-agent", { workspaceId }, false, windowId)
  }

  // ============================================================================
  // EDIT CONTEXT INLINE
  // ============================================================================

  const handleSaveContext = async (newContext: string) => {
    if (!workspace) return

    setSavingContext(true)
    try {
      const { workspace: updated } = await client.workspace.updateWorkspace({
        workspaceId: workspace.workspaceId,
        context: newContext.trim(),
      })
      setWorkspace((prev) => (prev ? { ...prev, context: updated.context } : null))
      setActiveModal("none")
      toast.success(t("workspaceDetail.saved"), t("workspaceDetail.contextUpdated"))
    } catch (err: any) {
      console.error("Error saving context:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.contextSaveError"))
    } finally {
      setSavingContext(false)
    }
  }

  // ============================================================================
  // EDIT APPEARANCE MODAL
  // ============================================================================

  const openEditAppearanceModal = () => {
    setSelectedColor(workspace?.appearance?.color || "amber")
    setSelectedIcon(workspace?.appearance?.icon || "folder")
    setIconSearch("")
    setActiveModal("edit-appearance")
  }

  const handleSaveAppearance = async () => {
    if (!workspace) return

    setSavingAppearance(true)
    try {
      const { workspace: updated } = await client.workspace.updateWorkspace({
        workspaceId: workspace.workspaceId,
        appearance: {
          color: selectedColor,
          icon: selectedIcon,
        },
      })
      setWorkspace((prev) => (prev ? { ...prev, appearance: updated.appearance } : null))
      setActiveModal("none")
      toast.success(t("workspaceDetail.saved"), t("workspaceDetail.appearanceUpdated"))
    } catch (err: any) {
      console.error("Error saving appearance:", err)
      toast.error(
        t("workspaceDetail.error"),
        err.message || t("workspaceDetail.appearanceSaveError"),
      )
    } finally {
      setSavingAppearance(false)
    }
  }

  // ============================================================================
  // INSTALL APP MODAL
  // ============================================================================

  const openInstallAppModal = async () => {
    setActiveModal("install-app")
    setLoadingCatalog(true)
    try {
      const { catalog: catalogData } = await client.app.listCatalog()
      // Filter out system apps and already installed MCAs (unless multi)
      const installedMcaIds = workspaceApps.map((a) => a.mcaId)
      const available = catalogData.filter(
        (mca: CatalogMca) =>
          mca.availability.enabled &&
          !mca.availability.system &&
          (mca.availability.multi || !installedMcaIds.includes(mca.mcaId)),
      )
      setCatalog(available)
    } catch (err) {
      console.error("Failed to load catalog:", err)
      toast.error(t("workspaceDetail.error"), t("workspaceDetail.catalogLoadError"))
    } finally {
      setLoadingCatalog(false)
    }
  }

  const handleInstallApp = async (mca: CatalogMca) => {
    setInstallingMcaId(mca.mcaId)
    try {
      const app = await client.installWorkspaceApp(workspaceId, mca.mcaId)
      setWorkspaceApps((prev) => [
        ...prev,
        {
          appId: app.appId,
          name: app.name,
          mcaId: app.mcaId,
          mcaName: mca.name,
          description: mca.description,
          icon: mca.icon,
          color: mca.color,
          category: mca.category,
          status: "active",
        },
      ])
      toast.success(
        t("workspaceDetail.installed"),
        t("workspaceDetail.installedMessage", { name: mca.name }),
      )

      // Remove from catalog if not multi
      if (!mca.availability.multi) {
        setCatalog((prev) => prev.filter((m) => m.mcaId !== mca.mcaId))
      }
    } catch (err: any) {
      console.error("Error installing app:", err)
      toast.error(t("workspaceDetail.error"), err.message || t("workspaceDetail.installError"))
    } finally {
      setInstallingMcaId(null)
    }
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  if (isLoading) {
    return <FullscreenLoader variant="default" label={t("workspaceDetail.loadingWorkspace")} />
  }

  if (!workspace) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}>
        <EmptyState icon="buildings" title={t("workspaceDetail.notFound")} />
      </View>
    )
  }

  const roleKey = workspace.role ?? "read"
  const roleData = roleIcons[roleKey] ?? roleIcons.read
  const roleLabel = t(`workspaceDetail.role_${roleKey}`)
  const canEdit =
    workspace.role === "owner" || workspace.role === "admin" || workspace.role === "write"
  /** MUW-REQ-17: only owner/admin can invite, revoke or resend invitations. */
  const canManageMembers = workspace.role === "owner" || workspace.role === "admin"
  const isPrivate = workspace.type === "private"
  const isCurrent = workspace.workspaceId === activeWorkspaceId

  // ============================================================================
  // ICON PICKER HELPERS
  // ============================================================================

  /** Convert PascalCase Lucide export name to kebab-case icon name */
  const pascalToKebab = (name: string): string =>
    name
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase()

  /**
   * Returns the list of icons to display in the icon picker:
   * - Empty search → curated WORKSPACE_ICONS (~50)
   * - With search → all Lucide icons filtered by kebab-case name
   */
  const getFilteredIcons = (): string[] => {
    const query = iconSearch.trim().toLowerCase()
    if (!query) return [...WORKSPACE_ICONS]

    return Object.keys(LucideIcons ?? {})
      .map(pascalToKebab)
      .filter(
        (name) =>
          // Exclude non-icon exports (they tend to be short or have special chars)
          /^[a-z][a-z0-9-]+$/.test(name) && name.includes(query),
      )
  }

  const tabs = [
    {
      key: "conversations" as TabType,
      label: t("workspaceDetail.tabChats"),
      icon: "chats-circle",
      count: workspaceChannels.length || undefined,
    },
    {
      key: "agents" as TabType,
      label: t("workspaceDetail.tabAgents"),
      icon: "users-three",
      count: workspaceAgents.length || undefined,
    },
    {
      key: "apps" as TabType,
      label: t("workspaceDetail.tabApps"),
      icon: "cube",
      count: workspaceApps.length || undefined,
    },
    {
      key: "members" as TabType,
      label: t("workspaceDetail.tabMembers"),
      icon: "user-circle",
      count: memberRows.length || undefined,
    },
    { key: "context" as TabType, label: t("workspaceDetail.tabContext"), icon: "file-text" },
  ]

  const renderModalShell = (
    title: string,
    children: React.ReactNode,
    footer?: React.ReactNode,
    maxWidth = 480,
    eyebrow?: string,
  ) => (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: "center",
        alignItems: "center",
        padding: 16,
      }}
    >
      <Pressable
        onPress={() => setActiveModal("none")}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: c.bgFrame,
          opacity: 0.6,
        }}
      />
      <View
        style={[
          {
            backgroundColor: c.bgStep,
            borderRadius: 24,
            width: "100%",
            maxWidth,
            maxHeight: "92%",
            overflow: "hidden",
          },
          Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : null,
        ]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 12,
            paddingHorizontal: 24,
            paddingTop: 22,
            paddingBottom: 12,
          }}
        >
          <View style={{ flex: 1, gap: 4 }}>
            {eyebrow ? (
              <T step="xs" tone="accent">
                {eyebrow}
              </T>
            ) : null}
            <T step="xl">{title}</T>
          </View>
          <IconBtn
            icon="x"
            plain
            onPress={() => setActiveModal("none")}
            accessibilityLabel={t("common.close")}
          />
        </View>
        {children}
        {footer ? (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              gap: 10,
              paddingHorizontal: 24,
              paddingVertical: 16,
              borderTopWidth: 1,
              borderTopColor: c.border,
            }}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </View>
  )

  return (
    <View style={{ flex: 1 }}>
      <Page>
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 20,
          }}
        >
          <Pressable
            onPress={canEdit ? openEditAppearanceModal : undefined}
            disabled={!canEdit}
            accessibilityLabel={t("workspaceDetail.customizeAppearance")}
            style={Platform.OS === "web" && canEdit ? ({ cursor: "pointer" } as any) : undefined}
          >
            <WorkspaceIcon
              icon={isPrivate ? "lock" : workspace.appearance?.icon || "folder"}
              color={isPrivate ? "gray" : workspace.appearance?.color || "amber"}
              size={30}
              containerSize={64}
            />
          </Pressable>
          <View style={{ flex: 1, minWidth: 220, gap: 8 }}>
            <T step="xs" tone="accent">
              {t("nav.workspace")}
            </T>
            <T step="2xl">{workspace.name}</T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Badge pill>
                {isPrivate
                  ? t("workspaces.private")
                  : t("workspaces.sharedKind", { defaultValue: "Compartido" })}
              </Badge>
              <Badge
                tone="i"
                pill
                icon={roleData.icon}
              >{`${t("workspaceDetail.yourRole", { defaultValue: "Tu rol" })} · ${roleLabel}`}</Badge>
              {isCurrent ? (
                <Badge tone="m" pill dot>
                  {t("workspaceDetail.youAreHere", { defaultValue: "Estás aquí" })}
                </Badge>
              ) : null}
            </View>
            {workspace.description ? (
              <T step="lg" tone="text2">
                {workspace.description}
              </T>
            ) : null}
            {workspace.volumeId ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ph name="hard-drives" size={12} color={c.text3} />
                <T step="codenote" tone="text3">
                  {workspace.volumeId}
                </T>
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {canEdit && (
              <Btn
                variant="sec"
                icon="palette"
                onPress={openEditAppearanceModal}
                testID="workspace-edit-appearance"
              >
                {t("workspaceDetail.appearance", { defaultValue: "Apariencia" })}
              </Btn>
            )}
            {workspace.role === "owner" && workspace.type !== "private" && (
              <Btn
                variant="dangerSoft"
                icon="archive"
                onPress={handleArchiveWorkspace}
                testID="workspace-archive"
              >
                {t("workspaceDetail.archive", { defaultValue: "Archivar" })}
              </Btn>
            )}
            {workspace.role !== "owner" && workspace.type !== "private" && (
              <Btn
                variant="dangerSoft"
                icon="sign-out"
                onPress={handleLeaveWorkspace}
                testID="workspace-leave"
              >
                {t("workspaceDetail.members.leave")}
              </Btn>
            )}
          </View>
        </View>

        {/* Private-space banner */}
        {isPrivate ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              padding: 14,
              borderRadius: 12,
              backgroundColor: c.tint.m.bg,
              marginBottom: 20,
            }}
          >
            <Ph name="lock" size={16} color={c.tint.m.tx} />
            <T step="sm" color={c.tint.m.tx} style={{ flex: 1 }}>
              {t("workspaceDetail.privateBanner", {
                defaultValue: "Tu espacio privado. No se puede eliminar ni archivar.",
              })}
            </T>
          </View>
        ) : null}

        {/* Tabs */}
        <PTabs
          items={tabs}
          value={activeTab}
          onChange={setActiveTab}
          style={{ marginBottom: 20 }}
        />

        {/* Tab Content */}
        <View style={{ gap: 16 }}>
          {activeTab === "conversations" && (
            <>
              {/* New chat button - show agent selector */}
              {workspaceAgents.length > 0 && (
                <View style={{ gap: 10 }}>
                  <T step="xs" tone="text2">
                    {t("workspaceDetail.newConversationWith")}
                  </T>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {workspaceAgents.map((agent) => (
                      <ChipBtn
                        key={agent.agentId}
                        lg
                        onPress={(e) => handleNewChat(agent, e)}
                        testID={`workspace-new-chat-${agent.agentId}`}
                      >
                        <Avatar
                          name={agent.name || agent.fullName}
                          imageUrl={agent.avatarUrl}
                          size={20}
                          isAgent
                        />
                        <T step="sm">{agent.name}</T>
                      </ChipBtn>
                    ))}
                  </View>
                </View>
              )}
              {isLoadingChannels ? (
                <View style={{ alignItems: "center", paddingVertical: 24 }}>
                  <AppSpinner size="sm" variant="default" />
                </View>
              ) : workspaceChannels.length === 0 ? (
                <LGroup>
                  <EmptyState
                    icon="chats-circle"
                    title={
                      workspaceAgents.length === 0
                        ? t("workspaceDetail.createAgentToChat")
                        : t("workspaceDetail.noConversationsYet")
                    }
                  />
                </LGroup>
              ) : (
                <View testID="workspace-channels">
                  <LGroup>
                    {workspaceChannels.map((channel) => {
                      const agent = workspaceAgents.find((a) => a.agentId === channel.agentId)
                      const agentName = agent?.name || t("workspaceDetail.agent")
                      return (
                        <LRow
                          key={channel.channelId}
                          onPress={(e) => handleOpenChat(channel, e)}
                          padV={12}
                          padH={12}
                          testID={`workspace-channel-${channel.channelId}`}
                        >
                          <Avatar
                            name={agentName}
                            imageUrl={agent?.avatarUrl}
                            size={36}
                            isAgent
                            status={channel.status === "closed" ? "idle" : "live"}
                          />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <T step="base" ellipsis>
                              {channel.metadata?.name ||
                                t("workspaceDetail.chatWith", { name: agentName })}
                            </T>
                            <T step="sm" tone="text3" ellipsis style={{ marginTop: 2 }}>
                              <T step="sm" tone="accent">
                                {agentName}
                              </T>
                              {channel.lastMessage?.content
                                ? ` · ${channel.lastMessage.content}`
                                : ""}
                            </T>
                          </View>
                          {(channel.unreadCount ?? 0) > 0 && (
                            <CountPill n={channel.unreadCount ?? 0} tone="mint" />
                          )}
                          <Ph name="caret-right" size={13} color={c.text3} />
                        </LRow>
                      )
                    })}
                  </LGroup>
                </View>
              )}
            </>
          )}

          {activeTab === "agents" && (
            <>
              {canEdit && (
                <View style={{ flexDirection: "row" }}>
                  <Btn
                    variant="sec"
                    icon="user-plus"
                    onPress={openCreateAgentModal}
                    testID="workspace-create-agent"
                  >
                    {t("workspaceDetail.createAgent")}
                  </Btn>
                </View>
              )}
              {isLoadingAgents ? (
                <View style={{ alignItems: "center", paddingVertical: 24 }}>
                  <AppSpinner size="sm" variant="default" />
                </View>
              ) : workspaceAgents.length === 0 ? (
                <LGroup>
                  <EmptyState icon="users-three" title={t("workspaceDetail.noAgents")} />
                </LGroup>
              ) : (
                <View testID="workspace-agents">
                  <LGroup>
                    {workspaceAgents.map((agent) => (
                      <LRow
                        key={agent.agentId}
                        onPress={(e) => handleOpenAgent(agent, e)}
                        padV={12}
                        padH={12}
                        testID={`workspace-agent-${agent.agentId}`}
                      >
                        <Avatar
                          name={agent.name || agent.fullName}
                          imageUrl={agent.avatarUrl}
                          size={36}
                          isAgent
                        />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T step="base" ellipsis>
                            {agent.name}
                            {agent.role ? (
                              <T step="base" tone="text3">{` · ${agent.role}`}</T>
                            ) : null}
                          </T>
                          {agent.intro ? (
                            <T step="sm" tone="text3" ellipsis>
                              {agent.intro.split("\n")[0]}
                            </T>
                          ) : null}
                        </View>
                        <Ph name="caret-right" size={13} color={c.text3} />
                      </LRow>
                    ))}
                  </LGroup>
                </View>
              )}
            </>
          )}

          {activeTab === "apps" && (
            <>
              {canEdit && (
                <View style={{ flexDirection: "row" }}>
                  <Btn
                    variant="sec"
                    icon="download-simple"
                    onPress={openInstallAppModal}
                    testID="workspace-install-app"
                  >
                    {t("workspaceDetail.installApp")}
                  </Btn>
                </View>
              )}
              {isLoadingApps ? (
                <View style={{ alignItems: "center", paddingVertical: 24 }}>
                  <AppSpinner size="sm" variant="default" />
                </View>
              ) : workspaceApps.length === 0 ? (
                <LGroup>
                  <EmptyState icon="cube" title={t("workspaceDetail.noAppsInstalled")} />
                </LGroup>
              ) : (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                  {workspaceApps.map((app) => (
                    <AppCard
                      key={app.appId}
                      appId={app.appId}
                      name={app.name}
                      icon={app.icon}
                      color={app.color}
                      category={app.category}
                      authInfo={authStatuses[app.appId]}
                      loading={loadingAuthStatus[app.appId]}
                      onPress={(e?: any) => handleOpenApp(app, e)}
                      onUninstall={canEdit ? () => handleUninstallApp(app) : undefined}
                      showUninstall={canEdit}
                    />
                  ))}
                </View>
              )}
            </>
          )}

          {/* Members Tab — MUW-REQ-15..17 */}
          {activeTab === "members" && (
            <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 12,
                  flexWrap: "wrap",
                }}
              >
                <T step="lg">{t("workspaceDetail.membersTitle")}</T>
                {canManageMembers && (
                  <Btn
                    variant="primary"
                    size="sm"
                    icon="user-plus"
                    onPress={openAddMemberModal}
                    testID="add-member-btn"
                  >
                    {t("workspaceDetail.members.addMember")}
                  </Btn>
                )}
              </View>

              {isLoadingMembers ? (
                <View style={{ alignItems: "center", paddingVertical: 32, gap: 8 }}>
                  <AppSpinner size="lg" variant="default" />
                  <T step="sm" tone="text2">
                    {t("workspaceDetail.members.loading")}
                  </T>
                </View>
              ) : memberRows.length === 0 ? (
                <LGroup>
                  <EmptyState icon="users-three" title={t("workspaceDetail.noMembers")} />
                </LGroup>
              ) : (
                <View testID="workspace-members">
                  <LGroup>
                    {memberRows.map((member) => {
                      const mRole = roleIcons[member.role] ?? roleIcons.read
                      const mRoleLabel = t(`workspaceDetail.role_${member.role}`, {
                        defaultValue: member.role,
                      })
                      const isPending = member.status === "pending"
                      const busy = !!(
                        (member.email && memberActionBusy[member.email]) ||
                        (member.userId && memberActionBusy[member.userId])
                      )
                      const isOwnerRow = member.role === "owner"
                      const isSelf = !!member.userId && member.userId === currentUserId
                      const canEditRow = canManageMembers && !isPending && !isOwnerRow && !isSelf && !!member.userId
                      const label = member.displayName || member.email || member.userId || "?"
                      return (
                        <LRow key={member.key} padV={12} padH={12}>
                          <Avatar
                            name={member.displayName || member.email || "?"}
                            imageUrl={member.avatarUrl}
                            size={36}
                          />
                          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                            <T step="base" ellipsis>
                              {member.displayName || member.email}
                            </T>
                            <T step="sm" tone="text3" ellipsis>
                              {isPending
                                ? t("workspaceDetail.members.pendingHint", {
                                    invitedBy: member.invitedBy,
                                    defaultValue: member.invitedBy
                                      ? `Invitado por ${member.invitedBy}`
                                      : undefined,
                                  })
                                : (member.email ?? "")}
                            </T>
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            {isPending ? (
                              <Badge pill dashed icon="hourglass">
                                {t("workspaceDetail.members.statusPending")}
                              </Badge>
                            ) : null}
                            {canEditRow ? (
                              // MUW-REQ-21: role chips for active members (owner/admin only)
                              <View style={{ flexDirection: "row", gap: 4 }} testID={`member-role-${member.userId}`}>
                                {(["admin", "write", "read"] as const).map((r) => (
                                  <ChipBtn
                                    key={r}
                                    on={member.role === r}
                                    icon={roleIcons[r].icon}
                                    disabled={busy}
                                    onPress={() => member.role !== r && handleSetMemberRole(member.userId!, r, label)}
                                    accessibilityRole="radio"
                                    accessibilityState={{ selected: member.role === r }}
                                    accessibilityLabel={t(`workspaceDetail.role_${r}`)}
                                    testID={`member-role-${member.userId}-${r}`}
                                  >
                                    {t(`workspaceDetail.role_${r}`)}
                                  </ChipBtn>
                                ))}
                              </View>
                            ) : (
                              <Badge pill icon={mRole.icon}>
                                {mRoleLabel}
                              </Badge>
                            )}
                            {canEditRow ? (
                              // MUW-REQ-20: remove an active member
                              <IconBtn
                                icon="user-minus"
                                plain
                                disabled={busy}
                                accessibilityLabel={t("workspaceDetail.members.remove")}
                                onPress={() => handleRemoveMember(member.userId!, label)}
                                testID={`member-remove-${member.userId}`}
                              />
                            ) : null}
                            {isPending && canManageMembers && member.email ? (
                              <>
                                <IconBtn
                                  icon="paper-plane-tilt"
                                  plain
                                  disabled={busy}
                                  accessibilityLabel={t("workspaceDetail.members.resend")}
                                  onPress={() => handleResendInvitation(member.email!)}
                                />
                                <IconBtn
                                  icon="x"
                                  plain
                                  disabled={busy}
                                  accessibilityLabel={t("workspaceDetail.members.revoke")}
                                  onPress={() => handleRevokeMember(member.email!)}
                                />
                              </>
                            ) : null}
                          </View>
                        </LRow>
                      )
                    })}
                  </LGroup>
                </View>
              )}
            </>
          )}

          {/* Context Tab */}
          {activeTab === "context" && (
            <ContextEditor
              title={t("workspaceDetail.workspaceContext")}
              description={t("workspaceDetail.workspaceContextDescription")}
              value={workspace?.context ?? ""}
              onChange={(text) =>
                setWorkspace((prev) => (prev ? { ...prev, context: text } : null))
              }
              onSave={async () => {
                await handleSaveContext(workspace?.context ?? "")
              }}
              isSaving={savingContext}
              placeholder={t("workspace.contextPlaceholder")}
            />
          )}
        </View>
      </Page>

      {/* Create Agent Modal */}
      {/* Install App Modal */}
      {activeModal === "install-app" &&
        renderModalShell(
          t("workspaceDetail.installApp"),
          <ScrollView
            style={{ maxHeight: 450 }}
            contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}
          >
            {loadingCatalog ? (
              <View style={{ alignItems: "center", paddingVertical: 24, gap: 8 }}>
                <AppSpinner size="lg" variant="default" />
                <T step="sm" tone="text2">
                  {t("workspaceDetail.loadingCatalog")}
                </T>
              </View>
            ) : catalog.length === 0 ? (
              <EmptyState icon="storefront" title={t("workspaceDetail.noAppsAvailable")} />
            ) : (
              <LGroup>
                {catalog.map((mca) => {
                  const isInstalling = installingMcaId === mca.mcaId
                  return (
                    <LRow key={mca.mcaId} padV={10} padH={12}>
                      <View
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 10,
                          backgroundColor: mca.color || c.tile,
                          justifyContent: "center",
                          alignItems: "center",
                          overflow: "hidden",
                        }}
                      >
                        {mca.icon ? (
                          <Image
                            source={{ uri: mca.icon }}
                            style={{ width: 26, height: 26 }}
                            resizeMode="contain"
                          />
                        ) : (
                          <Ph name="cube" size={20} color={c.accent} />
                        )}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T step="base" ellipsis>
                          {mca.name}
                        </T>
                        <T step="sm" tone="text3" ellipsis>
                          {mca.description}
                        </T>
                        <T step="codenote" tone="text3">
                          {t("workspaceDetail.toolCount", { count: mca.tools.length })}
                        </T>
                      </View>
                      <Btn
                        variant="sec"
                        size="sm"
                        icon="download-simple"
                        loading={isInstalling}
                        onPress={() => handleInstallApp(mca)}
                        testID={`install-${mca.mcaId}`}
                      >
                        {t("workspaceDetail.install")}
                      </Btn>
                    </LRow>
                  )
                })}
              </LGroup>
            )}
          </ScrollView>,
          undefined,
          520,
          t("nav.apps"),
        )}

      {/* Add Member Modal — MUW-14 (email + role → workspace.add_member) */}
      {activeModal === "add-member" &&
        renderModalShell(
          t("workspaceDetail.members.addMember"),
          <View style={{ paddingHorizontal: 24, paddingBottom: 8, gap: 16 }}>
            <FieldLabel>{t("workspaceDetail.members.emailLabel")}</FieldLabel>
            <Field
              icon="envelope-simple"
              value={inviteEmail}
              onChangeText={setInviteEmail}
              placeholder={t("workspaceDetail.members.emailPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              inputMode="email"
              testID="invite-email-field"
            />
            <FieldHelp>{t("workspaceDetail.members.emailHelp")}</FieldHelp>

            <FieldLabel>{t("workspaceDetail.members.roleLabel")}</FieldLabel>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {(["write", "read", "admin"] as const).map((r) => (
                <ChipBtn
                  key={r}
                  on={inviteRole === r}
                  icon={roleIcons[r].icon}
                  onPress={() => setInviteRole(r)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: inviteRole === r }}
                  accessibilityLabel={t(`workspaceDetail.role_${r}`)}
                  testID={`invite-role-${r}`}
                >
                  {t(`workspaceDetail.role_${r}`)}
                </ChipBtn>
              ))}
            </View>
            <FieldHelp>{t("workspaceDetail.members.roleHelp")}</FieldHelp>
          </View>,
          <>
            <Btn variant="sec" onPress={() => setActiveModal("none")}>
              {t("common.cancel", { defaultValue: "Cancelar" })}
            </Btn>
            <Btn
              variant="primary"
              icon="paper-plane-tilt"
              loading={isInviting}
              disabled={inviteEmail.trim() === "" || isInviting}
              onPress={handleAddMember}
              testID="invite-submit-btn"
            >
              {t("workspaceDetail.members.sendInvite")}
            </Btn>
          </>,
          480,
          t("nav.workspace"),
        )}

      {/* Edit Appearance Modal */}
      {activeModal === "edit-appearance" &&
        renderModalShell(
          t("workspaceDetail.customizeAppearance"),
          <ScrollView
            style={{ maxHeight: 500 }}
            contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 20 }}
          >
            {/* Preview */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 20 }}>
              <WorkspaceIcon
                icon={selectedIcon}
                color={selectedColor}
                size={30}
                containerSize={64}
              />
              <View style={{ gap: 2 }}>
                <T step="xl">{workspace.name}</T>
                <T step="sm" tone="text3">
                  {t("workspaceDetail.preview")}
                </T>
              </View>
            </View>

            {/* Color Picker */}
            <FieldLabel>{t("workspaceDetail.color")}</FieldLabel>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
              {WORKSPACE_COLORS.map((color) => {
                const isSelected = selectedColor === color
                const palette = COLOR_PALETTE[color]
                return (
                  <Pressable
                    key={color}
                    onPress={() => setSelectedColor(color)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={color}
                    testID={`color-${color}`}
                    style={[
                      {
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        backgroundColor: palette["500"],
                        justifyContent: "center",
                        alignItems: "center",
                        borderWidth: 2,
                        borderColor: c.bgStep,
                      },
                      Platform.OS === "web"
                        ? ({
                            cursor: "pointer",
                            transition: "transform 0.2s",
                            boxShadow: isSelected
                              ? `0 0 0 2px ${c.text}`
                              : "inset 0 0 0 1px rgba(0,0,0,0.08)",
                          } as any)
                        : isSelected
                          ? { borderColor: c.text }
                          : null,
                    ]}
                  >
                    {isSelected && <Ph name="check" size={14} color="#FFFFFF" weight="bold" />}
                  </Pressable>
                )
              })}
            </View>

            {/* Icon Picker */}
            <FieldLabel>{t("workspaceDetail.icon")}</FieldLabel>
            <Field
              icon="magnifying-glass"
              value={iconSearch}
              onChangeText={setIconSearch}
              placeholder={t("workspace.searchIconPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              containerStyle={{ marginBottom: 12 }}
            />

            {/* Icon grid */}
            {(() => {
              const icons = getFilteredIcons()
              const palette = COLOR_PALETTE[selectedColor as WorkspaceColor] || COLOR_PALETTE.amber

              if (icons.length === 0) {
                return (
                  <T step="sm" tone="text3" center style={{ paddingVertical: 12 }}>
                    {t("workspaceDetail.noIconsFound", { query: iconSearch })}
                  </T>
                )
              }

              return (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {icons.map((icon) => {
                    const isSelected = selectedIcon === icon
                    return (
                      <Pressable
                        key={icon}
                        onPress={() => setSelectedIcon(icon)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: isSelected }}
                        accessibilityLabel={icon}
                        testID={`icon-${icon}`}
                        style={[
                          {
                            width: 40,
                            height: 40,
                            borderRadius: 10,
                            backgroundColor: isSelected ? c.navActive : c.wash,
                            justifyContent: "center",
                            alignItems: "center",
                            borderWidth: 1,
                            borderColor: isSelected ? palette["500"] : "transparent",
                          },
                          Platform.OS === "web"
                            ? ({ cursor: "pointer", transition: "background 0.2s" } as any)
                            : null,
                        ]}
                      >
                        <WorkspaceIcon
                          icon={icon}
                          color={selectedColor}
                          size={18}
                          showBackground={false}
                          iconColor={isSelected ? palette["500"] : c.text2}
                        />
                      </Pressable>
                    )
                  })}
                </View>
              )
            })()}
          </ScrollView>,
          <>
            <Btn variant="ghost" onPress={() => setActiveModal("none")}>
              {t("common.cancel")}
            </Btn>
            <Btn
              variant="primary"
              icon="check"
              loading={savingAppearance}
              onPress={handleSaveAppearance}
              testID="appearance-save"
            >
              {t("common.save")}
            </Btn>
          </>,
          460,
          workspace.name,
        )}

      {/* Edit Context Modal */}
      {activeModal === "edit-context" &&
        renderModalShell(
          t("workspaceDetail.editContext"),
          <View style={{ paddingHorizontal: 24, paddingBottom: 20 }}>
            <FieldLabel>{t("workspaceDetail.workspaceContext")}</FieldLabel>
            <Field
              area
              minHeight={180}
              value={contextText}
              onChangeText={setContextText}
              placeholder={t("workspace.contextPlaceholder")}
              editable={!savingContext}
            />
            <FieldHelp>{t("workspaceDetail.workspaceContextDescription")}</FieldHelp>
          </View>,
          <>
            <Btn variant="ghost" disabled={savingContext} onPress={() => setActiveModal("none")}>
              {t("common.cancel")}
            </Btn>
            <Btn
              variant="primary"
              icon="check"
              loading={savingContext}
              onPress={() => handleSaveContext(contextText)}
            >
              {t("common.save")}
            </Btn>
          </>,
          520,
          workspace.name,
        )}
    </View>
  )
}
