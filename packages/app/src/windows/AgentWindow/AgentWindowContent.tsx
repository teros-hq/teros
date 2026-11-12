/**
 * Agent Window Content
 *
 * Configure an agent: view conversations, edit info, manage context, apps, and model.
 *
 * OS prototype vocabulary (design-testing): a Page on the sheet, the AgentHero
 * card (violet glow, 96px story avatar, serif name, mono role, meta badges,
 * actions column), PTabs for the sections, Cards with uppercase FieldLabels +
 * Fields, LGroup rows for lists, a DangerZone for deletion.
 */

import { useLucideIcons } from "../../lib/lucideIcons"
import {
  COLOR_PALETTE,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  type WorkspaceColor,
  resolveRetention,
} from "@teros/shared"
import { useRouter } from "expo-router"
import type React from "react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native"
import { Sheet } from "tamagui"
import { useToast } from "../../components/Toast"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useNavbarStore } from "../../store/navbarStore"
import { useTilingStore } from "../../store/tilingStore"
import { WorkspaceIcon } from "../../components/WorkspaceIcon"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { AgentWindowProps } from "./definition"
import { AppSpinner, FullscreenLoader } from "../../components/ui"
import {
  RetentionBadge,
  RetentionConfirmModal,
  useRetentionGuard,
} from "../../components/dataRetention"
import { useColors, useMcaTheme } from "../../components/mca/primitives/useColors"
import { SystemCapabilitiesSection } from "../../components/SystemCapabilitiesSection"
import {
  Badge,
  Btn,
  Card,
  DangerZone,
  Dot,
  EmptyState,
  Field,
  FieldHelp,
  FieldLabel,
  IconBtn,
  LGroup,
  LRow,
  OptionRow,
  Page,
  PTabs,
  Ph,
  SectionLabel,
  Switch,
  T,
  Tile,
  type PTabItem,
} from "../../components/ui/ds"
import { colors as semanticColors } from "../../components/mca/primitives/colors"
import { AgentHero } from "./AgentHero"

const RED = semanticColors.red

// App icon names stored on apps → Phosphor glyphs
const APP_ICON_PH: Record<string, string> = {
  terminal: "terminal",
  folder: "folder",
  package: "package",
}

interface Agent {
  agentId: string
  name: string
  fullName: string
  role: string
  intro: string
  context?: string
  avatarUrl?: string
  maxSteps?: number
  selectedProviderId?: string | null
  selectedModelId?: string | null
  appearance?: { color?: string; icon?: string }
  coreId?: string
  workspaceId?: string
  /** System-capability toggles (v1.4.4) — echoed by agent.list/update. */
  disabledSystemApps?: string[]
  enabledSystemApps?: string[]
}

interface UserProvider {
  providerId: string
  providerType: string
  displayName: string
  /** Provider config (e.g. zhipu `useChina`) — needed to resolve the retention
   * tier accurately, same as the backend does for AgentCoresWindow. */
  config?: Record<string, unknown>
  models: Array<{
    modelId: string
    /** Catalogue display name (Teros sizes read "Model L"); absent on old snapshots. */
    name?: string
    modelString: string
  }>
  status: "active" | "error" | "disabled"
}

interface App {
  appId: string
  name: string
  mcaId: string
  description: string
  category: string
  status: string
  icon?: string
  color?: string
}

interface AppWithAccess extends App {
  hasAccess: boolean
}

interface Conversation {
  channelId: string
  title: string
  lastMessageAt?: string | null
  lastMessageContent?: string
  status?: "active" | "closed"
  unreadCount?: number
  externalActionRequested?: boolean
}

interface AgentWindowContentProps extends AgentWindowProps {
  windowId: string
}

type TabId = "conversations" | "general" | "context" | "apps" | "model" | "skills"

interface Skill {
  skillId: string
  name: string
  description?: string
  icon?: string
}

interface SkillWithAccess extends Skill {
  hasAccess: boolean
  enabled: boolean
}

/** The 32px app tile: image / emoji / glyph / initial on the app colour. */
function AppGlyph({ app, size = 32 }: { app: App; size?: number }) {
  const c = useColors()
  const bg = app.color || c.tile
  const fg = app.color ? "#FFFFFF" : c.accent
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {app.icon && app.icon.startsWith("http") ? (
        <img
          src={app.icon}
          alt={app.name}
          style={{ width: size * 0.62, height: size * 0.62, objectFit: "contain" }}
        />
      ) : app.icon && app.icon.length <= 2 ? (
        <T step="base" color={fg}>
          {app.icon}
        </T>
      ) : app.icon && APP_ICON_PH[app.icon] ? (
        <Ph name={APP_ICON_PH[app.icon]} size={size / 2} color={fg} />
      ) : (
        <T step="bserif" color={fg}>
          {app.name.charAt(0).toUpperCase()}
        </T>
      )}
    </View>
  )
}

export function AgentWindowContent({ windowId, agentId, workspaceId }: AgentWindowContentProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const client = getTerosClient()
  const toast = useToast()
  const { closeWindow, openWindow, findWindow, focusWindow } = useTilingStore()
  const { removeAgent } = useNavbarStore()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const c = useColors()
  const { width: winWidth } = useWindowDimensions()
  const [menuOpen, setMenuOpen] = useState(false)
  const isDark = useMcaTheme() === "dark"
  const { guard: retentionGuard, modalProps: retentionModalProps } = useRetentionGuard()
  const [activeTab, setActiveTab] = useState<TabId>("conversations")
  const [agent, setAgent] = useState<Agent | null>(null)
  const [apps, setApps] = useState<AppWithAccess[]>([])
  const [providers, setProviders] = useState<UserProvider[]>([])
  /**
   * Zero Data Retention filter — mirrors the active workspace's
   * `settings.zdrOnly`. When true, the model picker below only offers models
   * whose resolved retention tier is `zdr` (local Ollama, ZDR-by-contract
   * providers, or models marked `providerConfig.zdr` in the catalog).
   */
  const [zdrOnly, setZdrOnly] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [totalActiveCount, setTotalActiveCount] = useState(0)
  const [totalInactiveCount, setTotalInactiveCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [conversationsLoaded, setConversationsLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removingApp, setRemovingApp] = useState<string | null>(null)
  const [showAddApp, setShowAddApp] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({
    name: "",
    fullName: "",
    role: "",
    intro: "",
    context: "",
    maxSteps: undefined as number | undefined,
  })
  const [saving, setSaving] = useState(false)
  const [contextValue, setContextValue] = useState("")
  const [savingContext, setSavingContext] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Appearance modal state
  const [showAppearanceModal, setShowAppearanceModal] = useState(false)
  const [selectedColor, setSelectedColor] = useState<string>("cyan")
  const [selectedIcon, setSelectedIcon] = useState<string>("bot")
  const [iconSearch, setIconSearch] = useState<string>("")
  // The full Lucide set is its own chunk, fetched once the appearance picker opens.
  const LucideIcons = useLucideIcons(showAppearanceModal)
  const [savingAppearance, setSavingAppearance] = useState(false)

  // Skills tab state
  const [skills, setSkills] = useState<SkillWithAccess[]>([])
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [togglingSkill, setTogglingSkill] = useState<string | null>(null)

  // Appearance modal helpers
  const pascalToKebab = (name: string): string =>
    name
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase()

  const getFilteredIcons = (): string[] => {
    const query = iconSearch.trim().toLowerCase()
    if (!query) return [...WORKSPACE_ICONS]
    return Object.keys(LucideIcons ?? {})
      .map(pascalToKebab)
      .filter((name) => /^[a-z][a-z0-9-]+$/.test(name) && name.includes(query))
  }

  const openAppearanceModal = () => {
    if (!agent) return
    setSelectedColor(agent.appearance?.color || "cyan")
    setSelectedIcon(agent.appearance?.icon || "bot")
    setIconSearch("")
    setShowAppearanceModal(true)
  }

  const handleSaveAppearance = async () => {
    if (!agent) return
    setSavingAppearance(true)
    try {
      const updated = await client.updateAgent({
        agentId: agent.agentId,
        appearance: { color: selectedColor, icon: selectedIcon },
      })
      setAgent((prev) =>
        prev
          ? {
              ...prev,
              appearance: (updated as any).appearance ?? {
                color: selectedColor,
                icon: selectedIcon,
              },
            }
          : null,
      )
      setShowAppearanceModal(false)
    } catch (err: any) {
      alert(t("agent.failedSaveAppearance", { error: err?.message || t("agent.unknownError") }))
    } finally {
      setSavingAppearance(false)
    }
  }

  // Handle avatar upload
  const handleAvatarUpload = async (file: File) => {
    if (!agent) return

    setUploadingAvatar(true)
    try {
      const formData = new FormData()
      formData.append("file", file)

      const backendUrl = client.getBackendBaseUrl()
      // The avatar endpoint requires auth (Bearer token); without it the backend
      // responds 401 "Authentication required". Mirror the chat upload + client.ts.
      const token = client.getSessionToken()
      const response = await fetch(`${backendUrl}/api/upload/avatar/${agent.agentId}`, {
        method: "POST",
        credentials: "include",
        body: formData,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })

      const result = await response.json()

      if (result.success && result.url) {
        setAgent((prev) => (prev ? { ...prev, avatarUrl: result.url } : null))
      } else {
        alert(result.error || t("agent.failedUploadAvatar"))
      }
    } catch (err) {
      console.error("Upload error:", err)
      alert(t("agent.failedUploadAvatar"))
    } finally {
      setUploadingAvatar(false)
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      if (!file.type.startsWith("image/")) {
        alert(t("agent.selectImageFile"))
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        alert(t("agent.fileTooLarge"))
        return
      }
      handleAvatarUpload(file)
    }
    event.target.value = ""
  }

  const startEditing = () => {
    if (agent) {
      setEditForm({
        name: agent.name || "",
        fullName: agent.fullName || "",
        role: agent.role || "",
        intro: agent.intro || "",
        context: agent.context || "",
        maxSteps: agent.maxSteps || undefined,
      })
      setIsEditing(true)
    }
  }

  const cancelEditing = () => {
    setIsEditing(false)
    setEditForm({ name: "", fullName: "", role: "", intro: "", context: "", maxSteps: undefined })
  }

  const saveAgent = async () => {
    if (!agent) return

    setSaving(true)
    try {
      const updated = await client.updateAgent({
        agentId: agent.agentId,
        name: editForm.name,
        fullName: editForm.fullName,
        role: editForm.role,
        intro: editForm.intro,
        context: editForm.context,
        maxSteps: editForm.maxSteps,
      })

      setAgent({
        ...agent,
        name: updated.name,
        fullName: updated.fullName,
        role: updated.role,
        intro: updated.intro,
        context: updated.context,
        maxSteps: updated.maxSteps,
      })
      setContextValue(updated.context || "")
      setIsEditing(false)
    } catch (err: any) {
      alert(t("agent.failedUpdateAgent", { error: err?.message || t("agent.unknownError") }))
    } finally {
      setSaving(false)
    }
  }

  const saveAgentContext = async () => {
    if (!agent) return
    setSavingContext(true)
    try {
      const updated = await client.updateAgent({
        agentId: agent.agentId,
        context: contextValue,
      })
      setAgent((prev) => (prev ? { ...prev, context: updated.context } : null))
    } catch (err: any) {
      alert(`Failed to update context: ${err?.message || "Unknown error"}`)
    } finally {
      setSavingContext(false)
    }
  }

  const deleteAgent = async () => {
    if (!agent) return

    setDeleting(true)
    try {
      await client.deleteAgent(agent.agentId)
      // Remove from navbar
      removeAgent(agent.agentId)
      // Close this window and open launcher
      closeWindow(windowId)
      openWindow("launcher", {}, true, windowId)
    } catch (err: any) {
      alert(t("agent.failedDeleteAgent", { error: err?.message || t("agent.unknownError") }))
      setDeleting(false)
    }
  }

  const loadConversations = async () => {
    if (!agent) return

    setLoadingConversations(true)
    try {
      const { channels } = await client.channel.list(workspaceId)

      // Filter conversations for this agent
      const agentConvs: Conversation[] = channels
        .filter((ch: any) => ch.agentId === agent.agentId)
        .map((ch: any) => ({
          channelId: ch.channelId,
          title: ch.metadata?.name || "Chat",
          lastMessageAt: ch.lastMessageAt || ch.lastMessage?.timestamp || ch.updatedAt,
          lastMessageContent: ch.lastMessage?.content || "",
          status: ch.status || "active",
          unreadCount: ch.unreadCount || 0,
          externalActionRequested: ch.externalActionRequested || false,
        }))

      // Backend already sorts by lastMessageAt desc — no re-sort here.
      // Only keep top 10 conversations
      const topConvs = agentConvs.slice(0, 10)

      // Store conversations and counts
      setConversations(topConvs)
      setTotalActiveCount(agentConvs.length)
      setTotalInactiveCount(0)
    } catch (err) {
      console.error("[AgentWindow] Error loading conversations:", err)
    } finally {
      setLoadingConversations(false)
      setConversationsLoaded(true)
    }
  }

  const loadSkills = async () => {
    if (!agent || !workspaceId) return

    setLoadingSkills(true)
    try {
      const [allSkills, agentSkills] = await Promise.all([
        client.skillRequest("skill.list", { workspaceId }),
        client.skillRequest("skill.get-agent-skills", { agentId }),
      ])

      const agentSkillMap = new Map<string, { enabled: boolean }>(
        ((agentSkills as any)?.skills ?? []).map((s: any) => [
          s.skillId,
          { enabled: s.enabled ?? true },
        ]),
      )

      const combined: SkillWithAccess[] = ((allSkills as any)?.skills ?? []).map((s: Skill) => ({
        ...s,
        hasAccess: agentSkillMap.has(s.skillId),
        enabled: agentSkillMap.get(s.skillId)?.enabled ?? false,
      }))

      setSkills(combined)
      setSkillsLoaded(true)
    } catch (err) {
      console.error("[AgentWindow] Error loading skills:", err)
      toast.error("Skills", err instanceof Error ? err.message : "No se pudieron cargar las skills")
      setSkillsLoaded(true)
    } finally {
      setLoadingSkills(false)
    }
  }

  const handleSelectConversation = async (conv: Conversation) => {
    // Mark as read if there are unread messages
    if (conv.unreadCount && conv.unreadCount > 0) {
      try {
        await client.channel.markRead(conv.channelId)
        setConversations((prev) =>
          prev.map((c) => (c.channelId === conv.channelId ? { ...c, unreadCount: 0 } : c)),
        )
      } catch (err) {
        console.error("Error marking channel as read:", err)
      }
    }

    const existingWindow = findWindow("chat", (props) => props.channelId === conv.channelId)

    if (existingWindow) {
      focusWindow(existingWindow.id)
    } else {
      // Preview routing (preview-tabs.md): a plain click reuses the desktop's
      // preview tab; only ctrl/cmd-click opens a separate tab.
      openWindow(
        "chat",
        {
          channelId: conv.channelId,
          agentId: agent?.agentId,
          agentName: agent?.name,
          workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
        },
        false,
        windowId,
      )
    }
  }

  const handleNewConversation = () => {
    if (!agent) return

    // The configure-agent → Chat repro (Pablo 2026-11-01): a draft chat is
    // NEW CONTENT — it opens in the desktop's preview tab (which, acting from
    // the agent window itself, IS this tab). It stops being "aparte".
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      },
      false,
      windowId,
    )
  }

  const handleVoiceConversation = () => {
    if (!agent) return
    // Open a chat window — voice mode is activated inline from the chat header mic button.
    // Same preview routing: the draft chat reuses the desktop's preview tab.
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      },
      false,
      windowId,
    )
  }

  useEffect(() => {
    const loadAgent = async () => {
      if (!agentId) {
        setError(t("errors.agent.noId"))
        setLoading(false)
        return
      }

      const effectiveWorkspaceId = workspaceId ?? activeWorkspaceId ?? undefined

      // Wait until the workspace store has hydrated before attempting to load
      if (effectiveWorkspaceId === undefined) {
        return
      }

      try {
        // Search in parallel: global agents + workspace agents (to support superagents with workspaceId: null)
        const [globalAgents, workspaceAgents] = await Promise.all([
          client.agent
            .listAgents()
            .then((r) => r.agents)
            .catch(() => []),
          effectiveWorkspaceId
            ? client.agent
                .listAgents(effectiveWorkspaceId)
                .then((r) => r.agents)
                .catch(() => [])
            : Promise.resolve([]),
        ])
        const allAgents = [...globalAgents, ...workspaceAgents]
        const found = allAgents.find((a) => a.agentId === agentId)

        if (found) {
          setAgent(found)
          setContextValue(found.context || "")

          try {
            const [appsList, agentApps, providersList] = await Promise.all([
              client.workspace
                .listWorkspaceApps(effectiveWorkspaceId ?? activeWorkspaceId ?? "")
                .then((r) => r.apps),
              client.getAgentApps(found.agentId, effectiveWorkspaceId),
              client.provider.list(),
            ])

            // ZDR filter: read the active workspace's settings.zdrOnly. Fetched
            // separately (not in the Promise.all) because it is best-effort —
            // a failure must not break agent loading, the filter just stays off.
            if (effectiveWorkspaceId ?? activeWorkspaceId) {
              try {
                const { workspace: ws } = await client.workspace.getWorkspace(
                  (effectiveWorkspaceId ?? activeWorkspaceId) as string,
                )
                setZdrOnly(ws?.settings?.zdrOnly === true)
              } catch (e) {
                console.error("Failed to load workspace settings for ZDR filter:", e)
              }
            }

            const accessSet = new Set(agentApps.map((a: any) => a.appId))
            const appsWithAccess: AppWithAccess[] = appsList.map((app: App) => ({
              ...app,
              hasAccess: accessSet.has(app.appId),
            }))

            setApps(appsWithAccess)
            setProviders(providersList.providers.filter((p: UserProvider) => p.status === "active"))
          } catch (e) {
            console.error("Failed to load apps:", e)
          }
        } else {
          setError(t("errors.agent.notFound", { agentId }))
        }
      } catch (err) {
        console.error("Failed to load agent:", err)
        setError(err instanceof Error ? err.message : t("errors.agent.loadFailed"))
      } finally {
        setLoading(false)
      }
    }

    if (client.isConnected()) {
      loadAgent()
    } else {
      const onConnected = () => {
        loadAgent()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)
      return () => {
        client.off("connected", onConnected)
      }
    }
  }, [agentId, workspaceId, activeWorkspaceId, client])

  // Load conversations when switching to conversations tab
  useEffect(() => {
    if (activeTab === "conversations" && agent && !conversationsLoaded) {
      loadConversations()
    }
  }, [activeTab, agent, conversationsLoaded])

  // Lazy-load skills when switching to skills tab
  useEffect(() => {
    if (activeTab === "skills" && agent && !skillsLoaded) {
      loadSkills()
    }
  }, [activeTab, agent])

  const copyAgentId = () => {
    if (!agent) return
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(agent.agentId).catch(() => {})
      toast.success(t("common.copied"), agent.agentId)
    }
  }

  if (loading) {
    return <FullscreenLoader label={t("agent.loadingAgent")} />
  }

  if (error) {
    return (
      <Page>
        <EmptyState icon="warning-circle" title={t("common.error")} text={error} />
      </Page>
    )
  }

  const grantedApps = apps.filter((a) => a.hasAccess)
  const grantedSkills = skills.filter((s) => s.hasAccess)
  const modelLabel = agent?.selectedModelId || t("agent.systemDefault")
  const wide = winWidth > 760

  const tabs: PTabItem<TabId>[] = [
    {
      key: "conversations",
      label: t("agent.tabConversations"),
      icon: "chat-circle",
      count: conversationsLoaded && totalActiveCount > 0 ? totalActiveCount : undefined,
    },
    { key: "general", label: t("agent.tabGeneral"), icon: "identification-card" },
    { key: "context", label: t("agent.tabContext"), icon: "brain" },
    {
      key: "apps",
      label: t("agent.tabApps"),
      icon: "squares-four",
      count: grantedApps.length || undefined,
    },
    {
      key: "skills",
      label: t("agent.tabSkills"),
      icon: "lightning",
      count: skillsLoaded && grantedSkills.length > 0 ? grantedSkills.length : undefined,
    },
    { key: "model", label: t("agent.tabModel"), icon: "cpu" },
  ]

  const renderAppRow = (app: AppWithAccess) => (
    <LRow key={app.appId} padV={10} padH={12} gap={12}>
      <AppGlyph app={app} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm" ellipsis>
          {app.name}
        </T>
        <T step="12" tone="text3" ellipsis>
          {app.description}
        </T>
      </View>
      <IconBtn
        icon="x"
        plain
        sm
        danger
        title={t("common.delete")}
        disabled={removingApp === app.appId}
        onPress={async () => {
          if (!agent) return
          setRemovingApp(app.appId)
          try {
            await client.app.revokeAccess(agent.agentId, app.appId)
            setApps((prev) =>
              prev.map((a) => (a.appId === app.appId ? { ...a, hasAccess: false } : a)),
            )
          } catch (err) {
            console.error("Failed to remove app access:", err)
          } finally {
            setRemovingApp(null)
          }
        }}
      />
    </LRow>
  )

  const renderConversationItem = (conv: Conversation) => {
    const hasUnread = !!(conv.unreadCount && conv.unreadCount > 0)
    const externalActionRequested = conv.externalActionRequested || false

    return (
      <LRow key={conv.channelId} hov onPress={() => handleSelectConversation(conv)}>
        <Tile
          sm
          icon="chat-circle"
          tone={externalActionRequested ? "amber" : hasUnread ? "accent" : "muted"}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="sm" ellipsis>
            {conv.title}
          </T>
          {conv.lastMessageContent ? (
            <T step="12" tone="text3" ellipsis>
              {conv.lastMessageContent}
            </T>
          ) : null}
        </View>
        {conv.lastMessageAt ? (
          <T step="codenote" tone="text3">
            {new Date(conv.lastMessageAt).toLocaleDateString()}
          </T>
        ) : null}
        {/* Red dot: external action requested (awaiting human or other agent) */}
        {externalActionRequested ? <Dot color={RED} /> : null}
        {/* Violet dot: has unread content */}
        {!externalActionRequested && hasUnread ? <Dot color={c.accent} /> : null}
      </LRow>
    )
  }

  const editActions = !isEditing ? (
    <Btn variant="sec" size="sm" icon="pencil-simple" onPress={startEditing}>
      {t("common.edit")}
    </Btn>
  ) : (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <Btn variant="ghost" size="sm" onPress={cancelEditing} disabled={saving}>
        {t("common.cancel")}
      </Btn>
      <Btn
        variant="primary"
        size="sm"
        icon="floppy-disk"
        onPress={saveAgent}
        disabled={saving}
        loading={saving}
      >
        {saving ? t("common.saving") : t("common.save")}
      </Btn>
    </View>
  )

  return (
    <Page>
      {agent && (
        <>
          {Platform.OS === "web" && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={handleFileChange}
              style={{ display: "none" }}
            />
          )}

          <AgentHero
            name={agent.name || agent.fullName}
            fullName={agent.fullName}
            role={agent.role}
            avatarUrl={agent.avatarUrl}
            badges={[
              { icon: "cpu", label: modelLabel },
              {
                icon: "squares-four",
                label: `${grantedApps.length} ${t("agent.tabApps").toLowerCase()}`,
              },
              ...(skillsLoaded
                ? [
                    {
                      icon: "lightning",
                      label: `${grantedSkills.length} ${t("agent.tabSkills").toLowerCase()}`,
                    },
                  ]
                : []),
            ]}
            uploading={uploadingAvatar}
            avatarHint={t("agent.avatarUploadHint")}
            onAvatarPress={() => {
              if (Platform.OS === "web" && fileInputRef.current) {
                fileInputRef.current.click()
              }
            }}
            newChatLabel={t("agent.chat")}
            onNewChat={handleNewConversation}
            voiceLabel={t("agent.voice")}
            onVoice={handleVoiceConversation}
            appearanceLabel={t("agent.customizeAppearance")}
            onAppearance={openAppearanceModal}
            moreLabel={t("common.open")}
            menuOpen={menuOpen}
            onToggleMenu={() => setMenuOpen((v) => !v)}
            menu={[
              {
                icon: "copy",
                label: `${t("common.copy")} · ${t("agent.fieldAgentId")}`,
                onPress: () => {
                  setMenuOpen(false)
                  copyAgentId()
                },
              },
              {
                icon: "trash",
                label: t("common.delete"),
                danger: true,
                onPress: () => {
                  setMenuOpen(false)
                  setShowDeleteConfirm(true)
                },
              },
            ]}
          />

          <PTabs<TabId>
            value={activeTab}
            onChange={(k) => {
              setMenuOpen(false)
              setActiveTab(k)
            }}
            items={tabs}
            style={{ marginBottom: 16 }}
          />

          {/* Conversations Tab */}
          {activeTab === "conversations" && (
            <View>
              <SectionLabel
                label={t("agent.recentConversations")}
                count={
                  totalActiveCount > 0
                    ? t("agent.showingCount", {
                        shown: conversations.length,
                        total: totalActiveCount,
                      })
                    : undefined
                }
              />

              {loadingConversations ? (
                <View style={{ padding: 32, alignItems: "center", gap: 12 }}>
                  <AppSpinner size="lg" variant="brand" />
                  <T step="sm" tone="text2">
                    {t("agent.loadingConversations")}
                  </T>
                </View>
              ) : conversations.length === 0 ? (
                <Card>
                  <EmptyState
                    icon="chat-circle"
                    title={t("agent.noConversationsYet")}
                    text={t("agent.noConversationsHint")}
                    action={
                      <Btn variant="primary" icon="chat-circle" onPress={handleNewConversation}>
                        {t("agent.chat")}
                      </Btn>
                    }
                  />
                </Card>
              ) : (
                <View style={{ gap: 10 }}>
                  <LGroup>{conversations.map(renderConversationItem)}</LGroup>

                  {/* Show more button if there are more active conversations */}
                  {totalActiveCount > 10 && (
                    <Btn
                      variant="sec"
                      iconRight="caret-right"
                      full
                      onPress={() => {
                        openWindow("conversations", {}, false, windowId)
                      }}
                    >
                      {t("agent.viewMoreActive", { count: totalActiveCount - 10 })}
                    </Btn>
                  )}

                  {/* Show inactive count if there are any */}
                  {totalInactiveCount > 0 && (
                    <Btn
                      variant="ghost"
                      full
                      onPress={() => {
                        openWindow("conversations", {}, false, windowId)
                      }}
                    >
                      {t("agent.inactiveConversationsCount", { count: totalInactiveCount })}
                    </Btn>
                  )}
                </View>
              )}
            </View>
          )}

          {/* General Tab */}
          {activeTab === "general" && (
            <View style={{ gap: 16 }}>
              <Card pad>
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 }}
                >
                  <T step="xs" tone="text2" style={{ flex: 1 }}>
                    {t("agent.generalInformation")}
                  </T>
                  {editActions}
                </View>

                <View style={{ flexDirection: wide ? "row" : "column", gap: 16 }}>
                  <View style={{ flex: 1 }}>
                    <FieldLabel required>{t("agent.fieldName")}</FieldLabel>
                    <Field
                      placeholder={t("agent.placeholderAgentName")}
                      value={isEditing ? editForm.name : agent.name}
                      editable={isEditing}
                      onChangeText={(text: string) =>
                        setEditForm((prev) => ({ ...prev, name: text }))
                      }
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <FieldLabel>{t("agent.fieldFullName")}</FieldLabel>
                    <Field
                      placeholder={t("agent.placeholderAgentFullName")}
                      value={isEditing ? editForm.fullName : agent.fullName}
                      editable={isEditing}
                      onChangeText={(text: string) =>
                        setEditForm((prev) => ({ ...prev, fullName: text }))
                      }
                    />
                  </View>
                </View>

                <View style={{ marginTop: 16 }}>
                  <FieldLabel>{t("agent.fieldRole")}</FieldLabel>
                  <Field
                    icon="user"
                    placeholder={t("agent.placeholderAgentRole")}
                    value={isEditing ? editForm.role : agent.role}
                    editable={isEditing}
                    onChangeText={(text: string) =>
                      setEditForm((prev) => ({ ...prev, role: text }))
                    }
                  />
                </View>

                <View style={{ marginTop: 16 }}>
                  <FieldLabel>{t("agent.fieldIntroduction")}</FieldLabel>
                  <Field
                    area
                    minHeight={110}
                    placeholder={t("agent.placeholderAgentIntro")}
                    value={isEditing ? editForm.intro : agent.intro}
                    editable={isEditing}
                    onChangeText={(text: string) =>
                      setEditForm((prev) => ({ ...prev, intro: text }))
                    }
                  />
                </View>

                <View style={{ flexDirection: wide ? "row" : "column", gap: 16, marginTop: 16 }}>
                  <View style={{ flex: 1 }}>
                    <FieldLabel>{t("agent.fieldMaxSteps")}</FieldLabel>
                    <Field
                      placeholder={t("agent.placeholderMaxSteps")}
                      keyboardType="numeric"
                      editable={isEditing}
                      value={
                        isEditing
                          ? editForm.maxSteps === undefined
                            ? ""
                            : editForm.maxSteps.toString()
                          : agent.maxSteps === 0
                            ? `∞ (${t("agent.maxStepsUnlimited")})`
                            : String(agent.maxSteps || 20)
                      }
                      onChangeText={(text: string) => {
                        if (text === "") {
                          setEditForm((prev) => ({ ...prev, maxSteps: undefined }))
                        } else {
                          const num = parseInt(text, 10)
                          setEditForm((prev) => ({
                            ...prev,
                            maxSteps: isNaN(num) ? undefined : num,
                          }))
                        }
                      }}
                      right={
                        isEditing ? (
                          <View style={{ flexDirection: "row", gap: 2, marginRight: -6 }}>
                            <IconBtn
                              icon="minus"
                              sm
                              onPress={() =>
                                setEditForm((prev) => ({
                                  ...prev,
                                  maxSteps: Math.max(0, (prev.maxSteps ?? 20) - 1),
                                }))
                              }
                            />
                            <IconBtn
                              icon="plus"
                              sm
                              onPress={() =>
                                setEditForm((prev) => ({
                                  ...prev,
                                  maxSteps: (prev.maxSteps ?? 20) + 1,
                                }))
                              }
                            />
                          </View>
                        ) : undefined
                      }
                    />
                    <FieldHelp>{t("agent.placeholderMaxSteps")}</FieldHelp>
                  </View>
                  <View style={{ flex: 1 }}>
                    <FieldLabel>{t("agent.fieldAgentId")}</FieldLabel>
                    <Field
                      mono
                      value={agent.agentId}
                      editable={false}
                      right={
                        <IconBtn
                          icon="copy"
                          plain
                          sm
                          title={t("common.copy")}
                          onPress={copyAgentId}
                          style={{ marginRight: -6 }}
                        />
                      }
                    />
                  </View>
                </View>
              </Card>

              <DangerZone
                title={t("agent.deleteAgent")}
                text={t("agent.deleteAgentConfirm", { name: agent.fullName || agent.name })}
                action={
                  <Btn variant="dangerSoft" icon="trash" onPress={() => setShowDeleteConfirm(true)}>
                    {t("common.delete")}
                  </Btn>
                }
              />
            </View>
          )}

          {/* Context Tab */}
          {activeTab === "context" && (
            <Card pad>
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}
              >
                <T step="xs" tone="text2" style={{ flex: 1 }}>
                  {t("agent.systemContext")}
                </T>
                {editActions}
              </View>
              <FieldHelp style={{ marginTop: 0, marginBottom: 12 }}>
                {t("agent.systemContextHint")}
              </FieldHelp>

              {isEditing ? (
                <Field
                  area
                  mono
                  minHeight={300}
                  placeholder={t("agent.placeholderContext")}
                  value={editForm.context}
                  onChangeText={(text: string) =>
                    setEditForm((prev) => ({ ...prev, context: text }))
                  }
                />
              ) : (
                <View
                  style={{
                    minHeight: 200,
                    padding: 14,
                    borderRadius: 10,
                    backgroundColor: c.field,
                    borderWidth: 1,
                    borderColor: c.border,
                  }}
                >
                  {agent.context ? (
                    <T step="code" style={{ lineHeight: 18 }}>
                      {agent.context}
                    </T>
                  ) : (
                    <T step="12" tone="text3" style={{ fontStyle: "italic" }}>
                      {t("agent.noContextConfigured")}
                    </T>
                  )}
                </View>
              )}
            </Card>
          )}

          {/* Apps Tab */}
          {activeTab === "apps" && (
            <View>
              <SectionLabel
                label={t("agent.tabApps")}
                count={grantedApps.length || undefined}
                right={
                  <Btn variant="primary" size="sm" icon="plus" onPress={() => setShowAddApp(true)}>
                    {t("agent.addApp")}
                  </Btn>
                }
              />

              {(() => {
                const sortedApps = [...grantedApps].sort((a, b) => a.name.localeCompare(b.name))

                if (sortedApps.length === 0) {
                  return (
                    <Card>
                      <EmptyState
                        icon="squares-four"
                        title={t("agent.noAppsAssigned")}
                        text={t("agent.noAppsHint")}
                        action={
                          <Btn variant="primary" icon="plus" onPress={() => setShowAddApp(true)}>
                            {t("agent.addApp")}
                          </Btn>
                        }
                      />
                    </Card>
                  )
                }

                const midpoint = wide ? Math.ceil(sortedApps.length / 2) : sortedApps.length
                const leftColumn = sortedApps.slice(0, midpoint)
                const rightColumn = sortedApps.slice(midpoint)

                return (
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <View style={{ flex: 1, gap: 10 }}>{leftColumn.map(renderAppRow)}</View>
                    {rightColumn.length > 0 && (
                      <View style={{ flex: 1, gap: 10 }}>{rightColumn.map(renderAppRow)}</View>
                    )}
                  </View>
                )
              })()}

              {/* System capabilities (v1.4.4) — ONE section with live per-agent
                  toggles, completely isolated from the third-party apps above.
                  memory visible + disableable, power caps default OFF. */}
              <SystemCapabilitiesSection
                agentId={agent?.agentId}
                disabledSystemApps={agent?.disabledSystemApps}
                enabledSystemApps={agent?.enabledSystemApps}
                onToggled={({ disabled, enabled }) => {
                  setAgent((prev) =>
                    prev
                      ? { ...prev, disabledSystemApps: disabled, enabledSystemApps: enabled }
                      : prev,
                  )
                }}
                style={{ marginTop: 28 }}
              />
            </View>
          )}

          {/* Skills Tab */}
          {activeTab === "skills" && (
            <View>
              <SectionLabel
                label={t("agent.skillsTitle")}
                count={grantedSkills.length || undefined}
              />
              <FieldHelp style={{ marginTop: -6, marginBottom: 14 }}>
                {t("agent.skillsHint")}
              </FieldHelp>

              {loadingSkills ? (
                <View style={{ padding: 32, alignItems: "center", gap: 12 }}>
                  <AppSpinner size="lg" variant="brand" />
                  <T step="sm" tone="text2">
                    {t("agent.loadingSkills")}
                  </T>
                </View>
              ) : skills.length === 0 ? (
                <Card>
                  <EmptyState
                    icon="lightning"
                    title={t("agent.noSkillsAvailable")}
                    text={t("agent.noSkillsHint")}
                  />
                </Card>
              ) : (
                <LGroup>
                  {skills.map((skill) => (
                    <LRow key={skill.skillId}>
                      <Tile sm icon="lightning" tone={skill.hasAccess ? "accent" : "muted"} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T step="sm" tone={skill.hasAccess ? "text" : "text2"} ellipsis>
                          {skill.name}
                        </T>
                        {skill.description ? (
                          <T step="12" tone="text3" numberOfLines={2}>
                            {skill.description}
                          </T>
                        ) : null}
                      </View>
                      {togglingSkill === skill.skillId ? (
                        <AppSpinner size="sm" variant="muted" />
                      ) : null}
                      <Switch
                        on={skill.hasAccess}
                        disabled={togglingSkill === skill.skillId}
                        onToggle={async () => {
                          if (!agent || togglingSkill === skill.skillId) return
                          setTogglingSkill(skill.skillId)
                          try {
                            if (skill.hasAccess) {
                              await client.skillRequest("skill.revoke-access", {
                                agentId: agent.agentId,
                                skillId: skill.skillId,
                              })
                              setSkills((prev) =>
                                prev.map((s) =>
                                  s.skillId === skill.skillId
                                    ? { ...s, hasAccess: false, enabled: false }
                                    : s,
                                ),
                              )
                            } else {
                              await client.skillRequest("skill.grant-access", {
                                agentId: agent.agentId,
                                skillId: skill.skillId,
                              })
                              setSkills((prev) =>
                                prev.map((s) =>
                                  s.skillId === skill.skillId
                                    ? { ...s, hasAccess: true, enabled: true }
                                    : s,
                                ),
                              )
                            }
                          } catch (err) {
                            console.error("[AgentWindow] Failed to toggle skill:", err)
                            toast.error(
                              skill.hasAccess
                                ? "No se pudo desactivar la skill"
                                : "No se pudo activar la skill",
                              err instanceof Error ? err.message : "Error desconocido",
                            )
                          } finally {
                            setTogglingSkill(null)
                          }
                        }}
                      />
                    </LRow>
                  ))}
                </LGroup>
              )}
            </View>
          )}

          {/* Model Tab */}
          {activeTab === "model" && (
            <View>
              <SectionLabel label={t("agent.llmModel")} />
              <FieldHelp style={{ marginTop: -6, marginBottom: 14 }}>
                {t("agent.modelSelectHint")}
              </FieldHelp>

              {/* ZDR filter active notice — explains why non-ZDR models are absent */}
              {zdrOnly && providers.length > 0 && (
                <Card pad={10} style={{ marginBottom: 14 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <RetentionBadge info={{ tier: "zdr", noticeSlug: "zdr" }} compact />
                    <T step="12" tone="text2" style={{ flex: 1 }}>
                      {t("agent.zdrFilterActive")}
                    </T>
                  </View>
                </Card>
              )}

              {providers.length === 0 ? (
                <View
                  style={{
                    padding: 16,
                    borderRadius: 16,
                    backgroundColor: c.tint.r.bg,
                    borderWidth: 1,
                    borderColor: c.tint.r.bd,
                    gap: 6,
                  }}
                >
                  <T step="sm" color={c.tint.r.tx}>
                    {t("agent.noProvidersConfigured")}
                  </T>
                  <T step="12" tone="text2">
                    {t("agent.noProvidersHint")}
                  </T>
                  <T step="12" tone="text2">
                    {t("agent.noProvidersAction")}
                  </T>
                </View>
              ) : (
                <View style={{ gap: 16 }}>
                  {/* System default option */}
                  <Card pad={6}>
                    <OptionRow
                      on={!agent.selectedModelId}
                      title={t("agent.systemDefault")}
                      sub={t("agent.systemDefaultHint")}
                      right={
                        !agent.selectedModelId ? (
                          savingProvider ? (
                            <AppSpinner size="sm" variant="muted" />
                          ) : (
                            <Badge tone="g" dot>
                              {t("agent.active")}
                            </Badge>
                          )
                        ) : undefined
                      }
                      onPress={async () => {
                        if (!agent.selectedModelId) return
                        setSavingProvider(true)
                        try {
                          await client.updateAgent({
                            agentId: agent.agentId,
                            selectedProviderId: null,
                            selectedModelId: null,
                          })
                          setAgent({
                            ...agent,
                            selectedProviderId: null,
                            selectedModelId: null,
                          })
                        } catch (err) {
                          console.error("Failed to clear model:", err)
                        } finally {
                          setSavingProvider(false)
                        }
                      }}
                    />
                  </Card>

                  {/* Provider models */}
                  {/*
                    ZDR filter (workspace settings.zdrOnly): when active, only
                    providers whose resolved retention tier is `zdr` are listed.
                    Provider-level tier covers every model of the provider; the
                    model-level `providerConfig.zdr` override is resolved by the
                    same call. Non-ZDR providers are hidden entirely — with ZDR
                    on, a non-ZDR model must not even appear as an option.
                  */}
                  {(zdrOnly
                    ? providers.filter(
                        (p) => resolveRetention(p.providerType, p.config).tier === "zdr",
                      )
                    : providers
                  ).map((provider) => (
                    <View key={provider.providerId}>
                      <SectionLabel
                        label={provider.displayName}
                        count={provider.models.length}
                        dot={false}
                        style={{ marginTop: 0 }}
                      />
                      <Card pad={6}>
                        {provider.models.map((model) => {
                          const isSelected = agent.selectedModelId === model.modelId
                          return (
                            <OptionRow
                              key={model.modelId}
                              on={isSelected}
                              title={model.name ?? model.modelId}
                              sub={model.name ? model.modelId : model.modelString}
                              right={
                                <View
                                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                                >
                                  <RetentionBadge
                                    info={resolveRetention(provider.providerType)}
                                    compact
                                  />
                                  {isSelected ? (
                                    savingProvider ? (
                                      <AppSpinner size="sm" variant="muted" />
                                    ) : (
                                      <Badge tone="g" dot>
                                        {t("agent.active")}
                                      </Badge>
                                    )
                                  ) : null}
                                </View>
                              }
                              onPress={() => {
                                if (isSelected) return
                                retentionGuard(
                                  resolveRetention(provider.providerType, provider.config),
                                  model.modelId,
                                  model.modelId,
                                  async () => {
                                    setSavingProvider(true)
                                    try {
                                      await client.updateAgent({
                                        agentId: agent.agentId,
                                        selectedProviderId: provider.providerId,
                                        selectedModelId: model.modelId,
                                      })
                                      setAgent((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              selectedProviderId: provider.providerId,
                                              selectedModelId: model.modelId,
                                            }
                                          : prev,
                                      )
                                    } catch (err) {
                                      console.error("Failed to update model:", err)
                                    } finally {
                                      setSavingProvider(false)
                                    }
                                  },
                                )
                              }}
                            />
                          )
                        })}
                      </Card>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Data-retention confirmation when switching to a 🔴 model */}
          <RetentionConfirmModal {...retentionModalProps} />

          {/* Add App Sheet */}
          <Sheet
            modal
            open={showAddApp}
            onOpenChange={setShowAddApp}
            snapPoints={[70]}
            dismissOnSnapToBottom
            zIndex={100000}
          >
            <Sheet.Overlay
              animation={"lazy" as any}
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
              backgroundColor={isDark ? "rgba(0,0,0,0.5)" : "rgba(32,28,39,0.3)"}
            />
            <Sheet.Frame
              backgroundColor={c.bgSheet}
              padding={20}
              gap={14}
              borderTopLeftRadius={24}
              borderTopRightRadius={24}
            >
              <Sheet.Handle backgroundColor={c.borderStrong} />

              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <T step="xl" style={{ flex: 1 }}>
                  {t("agent.addApp")}
                </T>
                <IconBtn
                  icon="x"
                  plain
                  onPress={() => setShowAddApp(false)}
                  title={t("common.close")}
                />
              </View>

              <Field
                icon="magnifying-glass"
                placeholder={t("agent.searchApps")}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />

              <ScrollView style={{ maxHeight: 400 }}>
                <LGroup>
                  {apps
                    .filter((a) => !a.hasAccess)
                    .filter(
                      (a) =>
                        searchQuery === "" ||
                        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        a.description.toLowerCase().includes(searchQuery.toLowerCase()),
                    )
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((app) => (
                      <LRow
                        key={app.appId}
                        hov
                        onPress={async () => {
                          if (!agent) return
                          try {
                            await client.app.grantAccess(agent.agentId, app.appId)
                            setApps((prev) =>
                              prev.map((a) =>
                                a.appId === app.appId ? { ...a, hasAccess: true } : a,
                              ),
                            )
                          } catch (err) {
                            console.error("Failed to add app access:", err)
                          }
                        }}
                      >
                        <AppGlyph app={app} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T step="sm" ellipsis>
                            {app.name}
                          </T>
                          <T step="12" tone="text3" ellipsis>
                            {app.description}
                          </T>
                        </View>
                        <Ph name="plus" size={16} color={c.accent} />
                      </LRow>
                    ))}
                </LGroup>
                {apps
                  .filter((a) => !a.hasAccess)
                  .filter(
                    (a) =>
                      searchQuery === "" ||
                      a.name.toLowerCase().includes(searchQuery.toLowerCase()),
                  ).length === 0 && (
                  <T step="sm" tone="text3" center style={{ padding: 16 }}>
                    {searchQuery ? t("agent.noAppsFound") : t("agent.allAppsAssigned")}
                  </T>
                )}
              </ScrollView>
            </Sheet.Frame>
          </Sheet>

          {/* Delete Confirmation Sheet */}
          <Sheet
            modal
            open={showDeleteConfirm}
            onOpenChange={setShowDeleteConfirm}
            snapPoints={[35]}
            dismissOnSnapToBottom
            zIndex={100000}
          >
            <Sheet.Overlay
              animation={"lazy" as any}
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
              backgroundColor={isDark ? "rgba(0,0,0,0.5)" : "rgba(32,28,39,0.3)"}
            />
            <Sheet.Frame
              backgroundColor={c.bgSheet}
              padding={20}
              gap={16}
              borderTopLeftRadius={24}
              borderTopRightRadius={24}
            >
              <Sheet.Handle backgroundColor={c.borderStrong} />

              <View style={{ gap: 12, alignItems: "center" }}>
                <Tile lg tone="pink" icon="trash" />
                <T step="xl" center>
                  {t("agent.deleteAgent")}
                </T>
                <T step="sm" tone="text2" center style={{ maxWidth: 420 }}>
                  {t("agent.deleteAgentConfirm", { name: agent.fullName || agent.name })}
                </T>

                <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
                  <Btn
                    variant="sec"
                    size="lg"
                    onPress={() => setShowDeleteConfirm(false)}
                    disabled={deleting}
                  >
                    {t("common.cancel")}
                  </Btn>
                  <Btn
                    variant="danger"
                    size="lg"
                    icon="trash"
                    onPress={deleteAgent}
                    disabled={deleting}
                    loading={deleting}
                  >
                    {deleting ? t("agent.deleting") : t("common.delete")}
                  </Btn>
                </View>
              </View>
            </Sheet.Frame>
          </Sheet>
        </>
      )}

      {/* Appearance Modal */}
      <Modal
        visible={showAppearanceModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAppearanceModal(false)}
      >
        <Pressable
          onPress={() => setShowAppearanceModal(false)}
          style={{
            flex: 1,
            backgroundColor: isDark ? "rgba(0,0,0,0.6)" : "rgba(32,28,39,0.45)",
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={[
              {
                width: "100%",
                maxWidth: 440,
                maxHeight: "90%",
                borderRadius: 24,
                backgroundColor: c.bgSheet,
                overflow: "hidden",
              },
              Platform.OS === "web"
                ? ({ boxShadow: c.elevRaised, cursor: "default" } as any)
                : null,
            ]}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                padding: 20,
                paddingBottom: 8,
              }}
            >
              <T step="xl" style={{ flex: 1 }}>
                {t("agent.customizeAppearance")}
              </T>
              <IconBtn
                icon="x"
                plain
                onPress={() => setShowAppearanceModal(false)}
                title={t("common.close")}
              />
            </View>

            <ScrollView
              style={{ maxHeight: 500 }}
              contentContainerStyle={{ padding: 20, paddingTop: 8 }}
            >
              {/* Preview */}
              <View style={{ alignItems: "center", marginBottom: 20, gap: 8 }}>
                <WorkspaceIcon
                  icon={selectedIcon}
                  color={selectedColor}
                  size={32}
                  containerSize={64}
                />
                <T step="codenote" tone="text3">
                  {t("agent.preview")}
                </T>
              </View>

              {/* Color Picker */}
              <FieldLabel>{t("agent.labelColor")}</FieldLabel>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
                {WORKSPACE_COLORS.map((color) => {
                  const isSelected = selectedColor === color
                  const palette = COLOR_PALETTE[color as WorkspaceColor]
                  return (
                    <Pressable
                      key={color}
                      accessibilityRole="button"
                      onPress={() => setSelectedColor(color)}
                      style={[
                        {
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          backgroundColor: palette["500"],
                          justifyContent: "center",
                          alignItems: "center",
                          borderWidth: 2,
                          borderColor: isSelected ? c.text : "transparent",
                        },
                        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                      ]}
                    >
                      {isSelected && <Ph name="check" size={16} color="#FFFFFF" weight="bold" />}
                    </Pressable>
                  )
                })}
              </View>

              {/* Icon Picker */}
              <FieldLabel>{t("agent.labelIcon")}</FieldLabel>
              <Field
                icon="magnifying-glass"
                value={iconSearch}
                onChangeText={setIconSearch}
                placeholder={t("agent.searchIconPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                containerStyle={{ marginBottom: 10 }}
              />

              {/* Icon grid — the stored icon names are Lucide names (WorkspaceIcon
                  renders them), so the picker draws the Lucide glyphs on purpose. */}
              {(() => {
                const icons = getFilteredIcons()
                const palette = COLOR_PALETTE[selectedColor as WorkspaceColor] || COLOR_PALETTE.cyan

                if (icons.length === 0) {
                  return (
                    <T step="12" tone="text3" center style={{ paddingVertical: 12 }}>
                      {t("agent.noIconsFound", { query: iconSearch })}
                    </T>
                  )
                }

                return (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {icons.map((icon) => {
                      const isSelected = selectedIcon === icon
                      const iconName = icon
                        .split("-")
                        .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
                        .join("")
                      const IconComponent = LucideIcons?.[iconName] || LucideIcons?.Folder || (() => null)
                      return (
                        <Pressable
                          key={icon}
                          accessibilityRole="button"
                          onPress={() => setSelectedIcon(icon)}
                          style={[
                            {
                              width: 36,
                              height: 36,
                              borderRadius: 10,
                              backgroundColor: isSelected ? palette["900"] + "60" : c.wash,
                              justifyContent: "center",
                              alignItems: "center",
                              borderWidth: 1,
                              borderColor: isSelected ? palette["500"] : "transparent",
                            },
                            Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                          ]}
                        >
                          <IconComponent size={16} color={isSelected ? palette["500"] : c.text3} />
                        </Pressable>
                      )
                    })}
                  </View>
                )
              })()}
            </ScrollView>

            {/* Footer */}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "flex-end",
                gap: 8,
                padding: 16,
                borderTopWidth: 1,
                borderTopColor: c.border,
              }}
            >
              <Btn variant="ghost" onPress={() => setShowAppearanceModal(false)}>
                {t("common.cancel")}
              </Btn>
              <Btn
                variant="primary"
                icon="check"
                onPress={handleSaveAppearance}
                disabled={savingAppearance}
                loading={savingAppearance}
              >
                {t("common.save")}
              </Btn>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Page>
  )
}
