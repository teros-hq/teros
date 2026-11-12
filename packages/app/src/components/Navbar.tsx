import { LinearGradient } from "expo-linear-gradient"
import { useChatStore } from "../store/chatStore"
import { useRouter } from "expo-router"
import type React from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../services/terosClientSingleton"
import { useClickModifiers } from "../hooks/useClickModifiers"
import {
  useNavbarRealtimeSync,
  type NavbarRealtimeConversation,
  type NavbarRealtimeProject,
} from "../hooks/navbar/useNavbarRealtimeSync"
import { useBillingStore } from "../store/billingStore"
import { getResolvedFlag, useFeatureFlagsStore } from "../store/featureFlagsStore"
import { useVoiceSession } from "../contexts/VoiceSessionContext"
import { PresenceDot } from "./voice/PresenceDot"
import { VoicePresenceBlock } from "./voice/VoicePresenceBlock"
import { useNavbarStore } from "../store/navbarStore"
import { type LayoutNode, selectActiveContainerId, useTilingStore } from "../store/tilingStore"
import { belongsInWorkspaceList } from "@teros/shared"
import { useWorkspaceStore } from "../store/workspaceStore"
import { useUiPreferencesStore } from "../store/uiPreferencesStore"
import { Avatar } from "./Avatar"
import { DesktopIndicator } from "./DesktopIndicator"
import { NewConversationModal } from "./NewConversationModal"
import { TerosLogo } from "./TerosLogo"
import { TerosWordmark } from "./TerosWordmark"
import { WorkspaceIcon } from "./WorkspaceIcon"
import { PermissionIndicator } from "./navbar/PermissionIndicator"
import { FrameMelt } from "./workspace/FrameMelt"
import { useColors } from "./mca/primitives/useColors"
import { colors as semanticColors } from "./mca/primitives/colors"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "./mca/primitives/fonts"
import { fx } from "../styles/fx"
import {
  Btn,
  CountPill,
  EmptyHint,
  Field,
  FieldLabel,
  IconBtn,
  InkToggle,
  Ph,
  SecH,
  SelectField,
  T,
} from "./ui/ds"
import { Halo } from "./ui/ds/Halo"

/**
 * Navbar — the OS sidebar of the design-testing prototype (Oct 2026).
 *
 * Expanded (272px): brand row · agent switch + new chat · pending approvals
 * banner · workspace select · scrolling sections (Agentes / Proyectos /
 * Conversaciones / Apps / Cuenta / Admin) · desktops segment · user row with
 * the theme toggle. Collapsed (64px): the avatar rail. The data/handlers are
 * unchanged — only the render and the styles moved to the prototype's
 * vocabulary (`.side`, `.item`, `.sec-h`, `.agent-switch`, `.menu`, `.rail`).
 */

// Breakpoints
const MOBILE_BREAKPOINT = 768
const COLLAPSED_WIDTH = 64
const EXPANDED_WIDTH = 272

interface NavbarProps {
  userName?: string
  userRole?: string
  onLogout?: () => void
  onWhatsNew?: () => void
  children?: React.ReactNode
}

export function Navbar({
  userName = "User",
  userRole = "user",
  onLogout,
  onWhatsNew,
  children,
}: NavbarProps) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = useUiPreferencesStore((st) => st.theme) === "dark"
  const styles = useNavbarStyles()
  const [hoveredSection, setHoveredSection] = useState<string | null>(null)
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const client = getTerosClient()

  // Stores
  const {
    agents,
    apps,
    workspaces,
    isLoaded,
    isExpanded,
    isMobileMenuOpen,
    setAgents,
    addAgent,
    setApps,
    setWorkspaces,
    setLoaded,
    setExpanded,
    setMobileMenuOpen,
    loadExpandedState,
  } = useNavbarStore()

  const { openWindow } = useTilingStore()
  const pendingBillingRequests = useBillingStore((s) => s.pendingAdminRequests)
  const { shouldOpenInNewTab } = useClickModifiers()

  // Academy gate (academy.enabled) — hidden until the real video content lands
  const academyFlags = useFeatureFlagsStore((s) => s.flags)
  const academyEnabled = getResolvedFlag<boolean>({ flags: academyFlags }, "academy.enabled")

  // Automate gate (automate_v1) — scheduler + webhook starters management
  const automateFlags = useFeatureFlagsStore((s) => s.flags)
  const automateEnabled = getResolvedFlag<boolean>({ flags: automateFlags }, "automate_v1")

  // v2 (ui-evolution §3.7): voice presence in the navbar. The provider already
  // wraps the Navbar (app/(workspace)/_layout.tsx) — the dot just reads the
  // context. Gated behind voice.enabled && voice.mode-ui: with the flag off,
  // the agent rows render exactly as before (zero regression).
  const voiceModeUiFlags = useFeatureFlagsStore((s) => s.flags)
  const voiceModeUiEnabled =
    getResolvedFlag<boolean>({ flags: voiceModeUiFlags }, "voice.enabled") &&
    getResolvedFlag<boolean>({ flags: voiceModeUiFlags }, "voice.mode-ui")
  const voiceSession = useVoiceSession()
  const voiceActiveAgentId =
    voiceModeUiEnabled && voiceSession.presence !== "off" ? voiceSession.activeAgentId : null
  // Active workspace
  const { activeWorkspaceId, setActiveWorkspace, hydrateActiveWorkspace } = useWorkspaceStore()

  // Recent conversations state (loaded from backend)
  const [recentConversations, setRecentConversations] = useState<
    Array<{
      channelId: string
      title: string
      agentId?: string
      agentName?: string
      agentAvatarUrl?: string
      lastMessageAt?: string
    }>
  >([])
  const [totalActiveConvs, setTotalActiveConvs] = useState(0)
  const [totalInactiveConvs, setTotalInactiveConvs] = useState(0)
  const [totalArchivedConvs, setTotalArchivedConvs] = useState(0)

  // Loads the conversation list (top-10 recent + per-bucket totals) from the
  // backend and recomputes the derived state. Called on initial load AND after
  // structural channel mutations (create/archive) so the totals that feed the
  // "N more" button stay in sync with the list instead of drifting until the
  // next full reload. Reads the agents cache from the navbar store (hydrated by
  // loadData) so it needs no agent args.
  //
  // Bumped by every realtime conversation event. A `created` event triggers this refresh,
  // and a rename landing right after it is applied from its own `updated` event; if the
  // list response was read before the rename, writing it would put the old title back
  // (the whole list is replaced). So a response that raced an event is discarded and the
  // list re-fetched — the next read already includes the change.
  const conversationEventSeq = useRef(0)
  const refreshConversations = useCallback(async () => {
    const currentWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
    let channels: any[]
    for (let attempt = 0; ; attempt++) {
      const seqAtStart = conversationEventSeq.current
      channels = (await client.channel.list(currentWorkspaceId ?? undefined)).channels
      if (conversationEventSeq.current === seqAtStart || attempt >= 2) break
    }
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000

    // Exclude headless and sub-conversations (delegated); split into buckets.
    const parentChannels = channels.filter((ch: any) => !ch.headless && !ch.originChannelId)
    const archivedChannels = parentChannels.filter((ch: any) => ch.status === "closed")
    const nonClosedChannels = parentChannels.filter((ch: any) => ch.status !== "closed")
    const isActive = (ch: any) => {
      const lastActivity = ch.lastMessageAt || ch.lastMessage?.timestamp || ch.updatedAt
      return !!lastActivity && new Date(lastActivity).getTime() >= threeHoursAgo
    }
    const activeChannels = nonClosedChannels.filter(isActive)
    const inactiveChannels = nonClosedChannels.filter((ch: any) => !isActive(ch))

    setTotalActiveConvs(activeChannels.length)
    setTotalInactiveConvs(inactiveChannels.length)
    setTotalArchivedConvs(archivedChannels.length)

    // Top-10 most recent (active first, then inactive), resolved against the
    // navbar agents cache. Backend already sorts by lastMessageAt desc — no re-sort here.
    const agents = useNavbarStore.getState().agents
    const sortedChannels = [...activeChannels, ...inactiveChannels].slice(0, 10)

    setRecentConversations(
      sortedChannels.map((ch: any) => {
        const agent = agents.find((a) => a.agentId === ch.agentId)
        if (!ch.workspaceId) {
          // Superagents (workspaceId: null on the agent) are valid — no workspace.
          const isSuperagent = agent && !agent.workspaceId
          if (!isSuperagent) {
            console.warn(
              `[Navbar] Channel ${ch.channelId} has no workspaceId and agent is not a superagent — possible data integrity issue`,
            )
          }
        }
        return {
          channelId: ch.channelId,
          title: ch.metadata?.name || t("nav.chat"),
          agentId: ch.agentId,
          agentName: agent?.name,
          agentAvatarUrl: agent?.avatarUrl,
          lastMessageAt: ch.lastMessageAt || ch.lastMessage?.timestamp || ch.updatedAt,
        }
      }),
    )
  }, [client, t])

  // Projects state
  const [projects, setProjects] = useState<Array<{ projectId: string; name: string }>>([])
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [newProjectDescription, setNewProjectDescription] = useState("")

  // State for modals
  const [showNewConversationModal, setShowNewConversationModal] = useState(false)
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false)
  const workspaceSelectorRef = useRef<View>(null)
  const [dropdownTop, setDropdownTop] = useState(48)

  // Measure selector position when dropdown opens
  useLayoutEffect(() => {
    if (showWorkspaceDropdown && workspaceSelectorRef.current && Platform.OS === "web") {
      workspaceSelectorRef.current.measureInWindow((x, y, width, height) => {
        setDropdownTop(y + height + 4)
      })
    }
  }, [showWorkspaceDropdown])

  // Scroll state for gradient indicators
  const [scrollState, setScrollState] = useState({ canScrollUp: false, canScrollDown: false })
  const scrollViewRef = useRef<ScrollView>(null)

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const canScrollUp = contentOffset.y > 5
    const canScrollDown = contentOffset.y < contentSize.height - layoutMeasurement.height - 5
    setScrollState({ canScrollUp, canScrollDown })
  }, [])

  const handleContentSizeChange = useCallback((contentWidth: number, contentHeight: number) => {
    // Check initial scroll state when content size changes
    const current = scrollViewRef.current
    if (current && "measure" in current) {
      ;(current as any).measure((_x: number, _y: number, _width: number, height: number) => {
        const canScrollDown = contentHeight > height
        setScrollState((prev) => ({ ...prev, canScrollDown }))
      })
    }
  }, [])

  // Superagents: agents without a workspaceId
  const superAgents = useMemo(() => agents.filter((agent) => !agent.workspaceId), [agents])

  // Workspace agents: agents belonging to the active workspace
  const workspaceAgents = useMemo(
    () => agents.filter((agent) => agent.workspaceId && agent.workspaceId === activeWorkspaceId),
    [agents, activeWorkspaceId],
  )

  // Sort apps alphabetically
  const sortedApps = useMemo(() => [...apps].sort((a, b) => a.name.localeCompare(b.name)), [apps])

  // Sort workspaces: private first, then rest alphabetically
  const sortedWorkspaces = useMemo(
    () => [
      ...workspaces.filter((ws) => ws.type === "private"),
      ...[...workspaces.filter((ws) => ws.type !== "private")].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ],
    [workspaces],
  )

  const isMobile = width < MOBILE_BREAKPOINT
  const isAdmin = userRole === "admin" || userRole === "super"

  // Load navbar expanded state from storage
  useEffect(() => {
    loadExpandedState()
  }, [])

  // Load agents and apps data
  useEffect(() => {
    let mounted = true

    const loadData = async () => {
      if (isLoaded) return

      try {
        // Load global agents
        const globalAgents = await client.agent.listAgents().then((r) => r.agents)

        // Load apps (filtered by active workspace)
        const appsWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
        let userApps: any[] = []
        if (appsWorkspaceId) {
          try {
            const { apps: wsApps } = await client.workspace.listWorkspaceApps(appsWorkspaceId)
            userApps = wsApps ?? []
          } catch {
            userApps = []
          }
        }
        if (mounted) {
          setApps(
            userApps.map((app) => ({
              ...app,
              mcaName: app.mcpName ?? app.mcaId,
              icon: app.icon,
              color: app.color,
            })),
          )
        }

        // Load workspaces
        const { workspaces: userWorkspaces } = await client.workspace.listWorkspaces()
        const mappedWorkspaces = userWorkspaces.map((ws: any) => ({
          workspaceId: ws.workspaceId,
          name: ws.name,
          role: ws.role,
          volumeId: ws.volumeId,
          appearance: ws.appearance,
          type: ws.type,
        }))
        if (mounted) {
          setWorkspaces(mappedWorkspaces)

          // Hydrate active workspace from storage (sessionStorage first, then localStorage fallback)
          await hydrateActiveWorkspace()

          // If still no active workspace, default to Private Workspace
          const currentActiveId = useWorkspaceStore.getState().activeWorkspaceId
          if (!currentActiveId) {
            const privateWs = mappedWorkspaces.find((ws: any) => ws.type === "private")
            if (privateWs) {
              setActiveWorkspace(privateWs.workspaceId)
            }
          }
        }

        // Load projects from active workspace board
        const activeWsId = useWorkspaceStore.getState().activeWorkspaceId
        if (activeWsId) {
          try {
            const { projects: boardProjects } = await client.board.listProjects(activeWsId)
            if (mounted) {
              setProjects(boardProjects.map((p: any) => ({ projectId: p.projectId, name: p.name })))
            }
          } catch (err) {
            console.warn("[Navbar] Failed to load projects:", err)
            if (mounted) setProjects([])
          }
        }

        // Load agents from each workspace (in parallel)
        const workspaceAgentsPromises = userWorkspaces.map((ws: any) =>
          client.agent
            .listAgents(ws.workspaceId)
            .then((r) => r.agents)
            .catch(() => []),
        )
        const workspaceAgentsResults = await Promise.all(workspaceAgentsPromises)

        // Combine global and workspace agents (deduplicate by agentId)
        if (mounted) {
          const seenIds = new Set<string>()
          const allAgents = [
            ...globalAgents.map((a) => ({
              agentId: a.agentId,
              name: a.fullName || a.name,
              role: a.role,
              avatarUrl: a.avatarUrl,
              coreId: a.coreId,
              workspaceId: a.workspaceId,
            })),
            ...workspaceAgentsResults.flat().map((a: any) => ({
              agentId: a.agentId,
              name: a.fullName || a.name,
              role: a.role,
              avatarUrl: a.avatarUrl,
              coreId: a.coreId,
              workspaceId: a.workspaceId,
            })),
          ].filter((a) => {
            if (seenIds.has(a.agentId)) return false
            seenIds.add(a.agentId)
            return true
          })
          setAgents(allAgents)
        }

        // Load recent conversations + bucket totals (agents were just hydrated above).
        if (mounted) {
          await refreshConversations()
        }

        if (mounted) {
          setLoaded(true)
        }
      } catch (err) {
        console.error("Failed to load navbar data:", err)
      }
    }

    const handleConnected = () => {
      setLoaded(false)
      loadData()
    }

    if (client.isConnected() && !isLoaded) {
      loadData()
    }

    client.on("connected", handleConnected)
    client.on("authenticated", handleConnected)

    return () => {
      mounted = false
      client.off("connected", handleConnected)
      client.off("authenticated", handleConnected)
    }
  }, [isLoaded, refreshConversations])

  // Reload navbar data when active workspace changes
  useEffect(() => {
    if (activeWorkspaceId !== undefined) {
      // Force a reload by resetting isLoaded
      setLoaded(false)
    }
  }, [activeWorkspaceId])

  // Realtime NavBar sync (TER-304) — agents/workspaces/apps update the store
  // directly; conversations/projects flow through these callbacks because they
  // are local component state with NavBar-specific logic (top-10, buckets).
  const handleConversationChange = useCallback(
    (action: "created" | "updated" | "deleted", payload: NavbarRealtimeConversation) => {
      conversationEventSeq.current++
      if (action === "deleted") {
        setRecentConversations((prev) => prev.filter((c) => c.channelId !== payload.channelId))
        // Reconcile the bucket totals ("N more" button) with the backend — the
        // optimistic removal above only touches the visible top-10 list.
        void refreshConversations()
        return
      }
      // Resolve missing fields from (1) the previous entry (preserve agentName/
      // avatar across partial `updated` payloads like rename) and (2) the
      // navbar agents cache as final fallback. Defense-in-depth: even if a
      // backend handler emits a partial payload, the conversation keeps its
      // identity instead of regressing to a generic "Chat" without avatar.
      const navAgents = useNavbarStore.getState().agents

      setRecentConversations((prev) => {
        const prevEntry = prev.find((c) => c.channelId === payload.channelId)
        // The event reaches every session of the user, whatever workspace it
        // shows, and also fires for headless runs and sub-conversations. A
        // channel the list does not show yet is added only if it belongs in
        // this workspace's list (CHAN-REQ-12); otherwise it would appear as a
        // nameless "Chat" with a generic avatar.
        if (
          !prevEntry &&
          !belongsInWorkspaceList(payload, useWorkspaceStore.getState().activeWorkspaceId)
        ) {
          return prev
        }
        const next = prev.filter((c) => c.channelId !== payload.channelId)

        const agentId = payload.agentId ?? prevEntry?.agentId
        const agent = agentId ? navAgents.find((a) => a.agentId === agentId) : undefined
        const merged = [
          {
            channelId: payload.channelId,
            title:
              payload.title && payload.title !== "Chat"
                ? payload.title
                : prevEntry?.title || agent?.name || payload.title || t("nav.chat"),
            agentId,
            agentName: payload.agentName ?? prevEntry?.agentName ?? agent?.name,
            agentAvatarUrl: payload.agentAvatarUrl ?? prevEntry?.agentAvatarUrl ?? agent?.avatarUrl,
            lastMessageAt: payload.lastMessageAt ?? prevEntry?.lastMessageAt,
          },
          ...next,
        ]
        return merged
          .sort((a, b) => {
            const da = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const db = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return db - da
          })
          .slice(0, 10)
      })

      // A newly created channel changes the active total; reconcile it (an
      // `updated` event only mutates an existing row, so totals don't move).
      if (action === "created") {
        void refreshConversations()
      }
    },
    [refreshConversations, t],
  )

  const handleProjectChange = useCallback(
    (action: "created" | "updated" | "deleted", payload: NavbarRealtimeProject) => {
      if (action === "deleted") {
        setProjects((prev) => prev.filter((p) => p.projectId !== payload.projectId))
        return
      }
      setProjects((prev) => {
        const exists = prev.some((p) => p.projectId === payload.projectId)
        if (action === "created" && exists) return prev
        if (action === "updated" && !exists) return prev
        if (action === "created") {
          return [...prev, { projectId: payload.projectId, name: payload.name ?? "" }]
        }
        return prev.map((p) =>
          p.projectId === payload.projectId ? { ...p, name: payload.name ?? p.name } : p,
        )
      })
    },
    [],
  )

  useNavbarRealtimeSync({
    onConversationChange: handleConversationChange,
    onProjectChange: handleProjectChange,
  })

  // Close mobile menu when switching to desktop
  useEffect(() => {
    if (!isMobile && isMobileMenuOpen) {
      setMobileMenuOpen(false)
    }
  }, [isMobile])

  const sidebarWidth = isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH

  // Handlers
  const handleOpenAgent = (agentId: string, e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow(
      "agent",
      { agentId, workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined },
      inNewTab,
    )
  }

  const handleOpenConversation = (channelId: string, e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("chat", { channelId }, inNewTab)
  }

  const handleOpenApps = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("apps", { workspaceId: activeWorkspaceId ?? undefined }, inNewTab)
  }

  const handleOpenCatalog = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("catalog", { workspaceId: activeWorkspaceId ?? undefined }, inNewTab)
  }

  const handleOpenSkills = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("skills", { workspaceId: activeWorkspaceId ?? undefined }, inNewTab)
  }

  const handleOpenAcademy = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("academy", { workspaceId: activeWorkspaceId ?? undefined }, inNewTab)
  }

  const handleOpenAutomate = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("automate", {}, inNewTab)
  }

  const handleOpenTodo = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("todo", { workspaceId: activeWorkspaceId ?? undefined }, inNewTab)
  }

  const handleNewConversation = () => {
    console.log("[Navbar] handleNewConversation called")
    setMobileMenuOpen(false)
    setShowNewConversationModal(true)
  }

  const handleSelectAgentForConversation = (
    agent: { agentId: string; name: string; fullName: string },
    e?: any,
  ) => {
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      inNewTab,
    )
  }

  const handleOpenAgentCores = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("agent-cores", {}, inNewTab)
  }

  const handleOpenMcas = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("mcas", {}, inNewTab)
  }

  const handleOpenUsers = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("users", {}, inNewTab)
  }

  // Monitoring suite is one entry now — Usage & Costs, Agent Activity, Model
  // Health and Session Trace are reached by drilling from the hub / its shared
  // MonitoringHeader, not from four separate Navbar items.
  const handleOpenMonitoring = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("monitoring", {}, inNewTab)
  }

  const handleOpenLatitudeSignals = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("latitude-signals", {}, inNewTab)
  }

  const handleOpenFeatureFlags = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("feature-flags", {}, inNewTab)
  }

  const handleOpenTerosProvider = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("teros-provider", {}, inNewTab)
  }

  const handleOpenBillingRequests = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("billing-requests", {}, inNewTab)
  }

  const handleOpenBillingTeams = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("billing-teams", {}, inNewTab)
  }

  const handleOpenProviders = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("providers", {}, inNewTab)
  }

  const handleOpenProfile = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("profile", { onLogout }, inNewTab)
  }

  const handleOpenWorkspacesList = (e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("workspaces", {}, inNewTab)
  }

  const handleOpenWorkspace = (workspaceId: string, e?: any) => {
    setMobileMenuOpen(false)
    setActiveWorkspace(workspaceId)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("workspace", { workspaceId }, inNewTab)
  }

  const handleOpenWorkspaceWindow = (workspaceId: string, e?: any) => {
    setMobileMenuOpen(false)
    const inNewTab = e && shouldOpenInNewTab(e)
    openWindow("workspace", { workspaceId }, inNewTab)
  }

  // ── Active window (for the "on" state of sidebar items) ───────────────────
  const activeContainerId = useTilingStore(selectActiveContainerId)
  const activeLayout = useTilingStore((s) => s.desktops[s.activeDesktopIndex]?.layout ?? null)
  const tilingWindows = useTilingStore((s) => s.windows)
  const activeWin = useMemo(() => {
    const id = findActiveWindowId(activeLayout, activeContainerId)
    return id ? (tilingWindows[id] ?? null) : null
  }, [activeLayout, activeContainerId, tilingWindows])
  const isOn = (type: string, match?: (props: Record<string, any>) => boolean) =>
    !!activeWin && activeWin.type === type && (match ? match(activeWin.props ?? {}) : true)

  const activeWs = workspaces.find((ws) => ws.workspaceId === activeWorkspaceId)
  const firstSuperAgent = superAgents[0]
  const extraSuperAgents = Math.max(0, superAgents.length - 1)
  const superFirstName = firstSuperAgent ? firstSuperAgent.name.split(" ")[0] : null
  const userInitials = userName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("")

  const startChatWith = (agent: { agentId: string; name: string }, e?: any) => {
    setMobileMenuOpen(false)
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      e ? shouldOpenInNewTab(e) : false,
    )
  }

  const closeCreateProject = () => {
    setCreatingProject(false)
    setNewProjectName("")
    setNewProjectDescription("")
  }

  const submitCreateProject = async () => {
    const name = newProjectName.trim()
    const description = newProjectDescription.trim() || undefined
    if (!name) return
    try {
      const { project } = await getTerosClient().board.createProject(
        activeWorkspaceId!,
        name,
        description,
      )
      const newProject = { projectId: project.projectId, name: project.name }
      // Idempotent: the WS event `project.created` may already have added it
      // via useNavbarRealtimeSync.
      setProjects((prev) =>
        prev.some((p) => p.projectId === newProject.projectId) ? prev : [...prev, newProject],
      )
      openWindow(
        "board",
        { projectId: newProject.projectId, projectName: newProject.name, view: "mission" },
        false,
      )
    } catch (err) {
      console.warn("[Navbar] Failed to create project:", err)
    } finally {
      closeCreateProject()
    }
  }

  // ── Workspace menu (`.menu`) ──────────────────────────────────────────────
  const renderWorkspaceMenu = (collapsed: boolean) =>
    showWorkspaceDropdown ? (
      <>
        <Pressable style={styles.menuBackdrop} onPress={() => setShowWorkspaceDropdown(false)} />
        <View
          {...fx("menu")}
          style={[styles.menu, collapsed && styles.menuCollapsed, { top: dropdownTop }]}
        >
          <ScrollView
            style={{ maxHeight: 400 }}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            {sortedWorkspaces.map((ws) => {
              const isActive =
                activeWorkspaceId !== null
                  ? ws.workspaceId === activeWorkspaceId
                  : ws.type === "private"
              return (
                <Pressable
                  key={ws.workspaceId}
                  style={({ hovered, pressed }: any) => [
                    styles.menuItem,
                    (hovered || pressed) && styles.menuItemHover,
                    isActive && styles.menuItemOn,
                  ]}
                  onPress={() => {
                    // URL-first switch: navigate and let WorkspaceShellInit's effect
                    // drive the store change (see git history for the race this avoids).
                    router.replace(`/workspace/${ws.workspaceId}`)
                    setShowWorkspaceDropdown(false)
                  }}
                >
                  {ws.type === "private" ? (
                    <WorkspaceIcon icon="lock" color="amber" size={12} containerSize={22} />
                  ) : (
                    <WorkspaceIcon
                      icon={ws.appearance?.icon}
                      color={ws.appearance?.color}
                      size={12}
                      containerSize={22}
                    />
                  )}
                  <Text
                    style={[styles.menuItemText, isActive && { color: c.accent }]}
                    numberOfLines={1}
                  >
                    {ws.name}
                  </Text>
                  <Text style={styles.menuItemMeta}>{ws.role?.toUpperCase?.() ?? ""}</Text>
                  {isActive ? <Ph name="check" size={13} color={c.accent} /> : null}
                </Pressable>
              )
            })}
          </ScrollView>
          <View style={styles.menuHr} />
          <Pressable
            style={({ hovered, pressed }: any) => [
              styles.menuItem,
              (hovered || pressed) && styles.menuItemHover,
            ]}
            onPress={() => {
              setShowWorkspaceDropdown(false)
              handleOpenWorkspacesList()
            }}
          >
            <Ph name="gear-six" size={14} color={c.text3} />
            <Text style={[styles.menuItemText, { color: c.text3 }]}>
              {t("nav.manageWorkspaces")}
            </Text>
          </Pressable>
        </View>
      </>
    ) : null

  // ── Create project modal ──────────────────────────────────────────────────
  const renderCreateProjectModal = () => (
    <Modal
      visible={creatingProject}
      transparent
      animationType="fade"
      onRequestClose={closeCreateProject}
    >
      <Pressable style={styles.scrim} onPress={closeCreateProject}>
        <Pressable {...fx("modal")} style={styles.modal} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHead}>
            <View style={{ flex: 1, gap: 4 }}>
              <T step="xs" tone="accent">
                {t("nav.projects")}
              </T>
              <T step="xl">{t("nav.newProject")}</T>
            </View>
            <IconBtn icon="x" plain sm onPress={closeCreateProject} />
          </View>
          <View style={styles.modalBody}>
            <View>
              <FieldLabel required>{t("nav.nameLabel")}</FieldLabel>
              <Field
                autoFocus
                placeholder={t("nav.projectNamePlaceholder")}
                value={newProjectName}
                onChangeText={setNewProjectName}
                onSubmitEditing={submitCreateProject}
              />
            </View>
            <View style={{ marginTop: 16 }}>
              <FieldLabel>{t("nav.descriptionLabel")}</FieldLabel>
              <Field
                area
                minHeight={88}
                placeholder={t("nav.projectDescriptionPlaceholder")}
                value={newProjectDescription}
                onChangeText={setNewProjectDescription}
              />
            </View>
          </View>
          <View style={styles.modalFoot}>
            <View style={{ flex: 1 }} />
            <Btn variant="ghost" onPress={closeCreateProject}>
              {t("common.cancel")}
            </Btn>
            <Btn
              variant="primary"
              icon="plus"
              disabled={!newProjectName.trim()}
              onPress={submitCreateProject}
            >
              {t("nav.createProject")}
            </Btn>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )

  // ── Collapsed rail (`.rail`) ──────────────────────────────────────────────
  const renderRail = () => (
    <View style={styles.rail}>
      <TouchableOpacity
        style={styles.railLogo}
        onPress={() => {
          setMobileMenuOpen(false)
          openWindow("home", { workspaceId: activeWorkspaceId ?? undefined }, false)
        }}
        accessibilityLabel={t("nav.home")}
      >
        <TerosLogo size={26} animated={false} />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.railNew}
        accessibilityLabel={t("nav.newChat")}
        onPress={(e) =>
          firstSuperAgent ? startChatWith(firstSuperAgent, e) : handleNewConversation()
        }
      >
        <Ph name="plus" size={18} color={c.inkPillText} />
      </TouchableOpacity>
      <PermissionIndicator collapsed />
      {renderWorkspaceMenu(true)}
      <ScrollView
        style={styles.railStories}
        contentContainerStyle={styles.railStoriesIn}
        showsVerticalScrollIndicator={false}
      >
        {[...superAgents, ...workspaceAgents].map((agent) => (
          <TouchableOpacity
            key={agent.agentId}
            style={[
              styles.railStory,
              isOn("agent", (p) => p.agentId === agent.agentId) && styles.railStoryOn,
            ]}
            onPress={(e) => handleOpenAgent(agent.agentId, e)}
            accessibilityLabel={agent.name}
          >
            <Avatar name={agent.name} imageUrl={agent.avatarUrl} size={34} isAgent />
          </TouchableOpacity>
        ))}
        <View style={styles.railNav}>
          <RailBtn icon="cube" on={isOn("apps")} onPress={handleOpenApps} label={t("nav.apps")} />
          <RailBtn
            icon="storefront"
            on={isOn("catalog")}
            onPress={handleOpenCatalog}
            label={t("nav.catalog")}
          />
          <RailBtn
            icon="books"
            on={isOn("skills")}
            onPress={handleOpenSkills}
            label={t("nav.skills")}
          />
          <RailBtn
            icon="chats-circle"
            on={isOn("conversations")}
            onPress={(e) => {
              setMobileMenuOpen(false)
              openWindow(
                "conversations",
                { workspaceId: activeWorkspaceId ?? undefined },
                shouldOpenInNewTab(e),
              )
            }}
            label={t("nav.conversations")}
          />
          <RailBtn
            icon="list-checks"
            on={isOn("todo")}
            onPress={handleOpenTodo}
            label={t("nav.todo")}
          />
          <RailBtn
            icon="user-circle"
            on={isOn("profile")}
            onPress={handleOpenProfile}
            label={t("nav.profile")}
          />
        </View>
      </ScrollView>
      <View style={styles.railFoot}>
        <VoicePresenceBlock collapsed />
        <DesktopIndicator collapsed />
        <ThemeToggleButton />
        {!isMobile && (
          <IconBtn
            icon="sidebar-simple"
            plain
            onPress={() => setExpanded(true)}
            title={t("nav.expand")}
          />
        )}
      </View>
    </View>
  )

  // ── Expanded sidebar (`.side`) ────────────────────────────────────────────
  const renderSidebarContent = (collapsed: boolean) => {
    if (collapsed) return renderRail()
    return (
      <>
        {/* Brand row */}
        <View style={styles.brand}>
          <TouchableOpacity
            style={styles.brandHome}
            onPress={() => {
              setMobileMenuOpen(false)
              openWindow("home", { workspaceId: activeWorkspaceId ?? undefined }, false)
            }}
            accessibilityLabel={t("nav.home")}
          >
            {/* `.brand-home .logo-full`: mark + wordmark as one vector, 18px */}
            <TerosWordmark height={18} color={c.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          {isMobile ? (
            <IconBtn icon="x" plain sm onPress={() => setMobileMenuOpen(false)} />
          ) : (
            <IconBtn
              icon="sidebar-simple"
              plain
              sm
              onPress={() => setExpanded(false)}
              title={t("nav.collapse")}
            />
          )}
        </View>

        {/* Agent switch + new chat */}
        <View style={styles.agentRow}>
          <TouchableOpacity
            style={styles.agentSwitch}
            activeOpacity={0.85}
            onPress={(e) =>
              firstSuperAgent
                ? handleOpenAgent(firstSuperAgent.agentId, e)
                : handleNewConversation()
            }
          >
            {firstSuperAgent ? (
              <Avatar
                name={firstSuperAgent.name}
                imageUrl={firstSuperAgent.avatarUrl}
                size={36}
                isAgent
              />
            ) : (
              <View style={styles.agentSwitchPlaceholder}>
                <Ph name="sparkle" size={16} color={c.accent} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.agentSwitchName} numberOfLines={1}>
                {superFirstName ?? t("nav.agents")}
              </Text>
            </View>
            {extraSuperAgents > 0 ? (
              <Text style={styles.agentSwitchExtra}>+{extraSuperAgents}</Text>
            ) : null}
            <Ph name="caret-up-down" size={14} color={c.text3} />
          </TouchableOpacity>
          <TouchableOpacity
            // TerosButton sm · tone "soft": Main/400 pill with dark ink on
            // light, Purple/300 with white ink on dark. 36px, flat.
            style={[
              styles.newChat,
              { backgroundColor: isDark ? semanticColors.purple300 : semanticColors.main400 },
            ]}
            accessibilityLabel={t("nav.newChat")}
            onPress={(e) =>
              firstSuperAgent ? startChatWith(firstSuperAgent, e) : handleNewConversation()
            }
          >
            <Halo color={isDark ? semanticColors.purple300 : semanticColors.main400} size="md" />
            <View style={{ zIndex: 1 }}>
              <Ph name="plus" size={16} color={isDark ? "#FFFFFF" : "#201C27"} />
            </View>
          </TouchableOpacity>
        </View>

        {/* Pending approvals banner */}
        <PermissionIndicator />

        {/* Workspace row */}
        <View ref={workspaceSelectorRef} style={styles.wsRow}>
          {/* Selector contrast (Pablo, 31-oct review — same pass as the desktop
              dots, 38085d727): bgStep is EXACTLY bgFrame in dark (#201C27) and
              the border was transparent, so the trigger was invisible as a
              control. text3 (#968FA7 in both themes) carries the edge; field
              gives the input its body (bone lift in dark, white pill in light). */}
          <SelectField
            style={{ flex: 1, backgroundColor: c.field, borderColor: c.text3 }}
            icon={
              activeWs?.type === "private" ? (
                <WorkspaceIcon icon="lock" color="amber" size={13} containerSize={20} />
              ) : (
                <WorkspaceIcon
                  icon={activeWs?.appearance?.icon}
                  color={activeWs?.appearance?.color}
                  size={13}
                  containerSize={20}
                />
              )
            }
            label={activeWs?.name ?? t("nav.workspace")}
            meta={activeWs?.role ? activeWs.role.toUpperCase() : undefined}
            onPress={() => setShowWorkspaceDropdown(!showWorkspaceDropdown)}
          />
          {activeWorkspaceId ? (
            <IconBtn
              icon="gear-six"
              plain
              onPress={(e) => handleOpenWorkspaceWindow(activeWorkspaceId, e)}
              title={t("nav.workspaceSettings")}
            />
          ) : null}
        </View>
        {renderWorkspaceMenu(false)}

        {/* Scrolling sections */}
        <View style={styles.sidebarContentWrapper}>
          {scrollState.canScrollUp && (
            <LinearGradient
              colors={[c.bgFrame, "transparent"]}
              style={styles.scrollGradientTop}
              pointerEvents="none"
            />
          )}
          <ScrollView
            ref={scrollViewRef}
            style={styles.sidebarContent}
            contentContainerStyle={styles.sidebarContentIn}
            showsVerticalScrollIndicator={false}
            onScroll={handleScroll}
            onContentSizeChange={handleContentSizeChange}
            scrollEventThrottle={16}
          >
            {/* Agents */}
            <View>
              <SecH label={t("nav.agents")}>
                <IconBtn
                  icon="plus"
                  plain
                  sm
                  onPress={(e) => {
                    setMobileMenuOpen(false)
                    openWindow(
                      "create-agent",
                      { workspaceId: activeWorkspaceId },
                      shouldOpenInNewTab(e),
                    )
                  }}
                  title={t("nav.createAgent", { defaultValue: "Crear agente" })}
                />
              </SecH>
              {workspaceAgents.map((agent) => {
                const firstName = agent.name.split(" ")[0]
                return (
                  <SideItem
                    key={agent.agentId}
                    on={isOn("agent", (p) => p.agentId === agent.agentId)}
                    onPress={(e) => handleOpenAgent(agent.agentId, e)}
                    leading={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <Avatar name={agent.name} imageUrl={agent.avatarUrl} size={28} isAgent />
                        {voiceActiveAgentId === agent.agentId && (
                          <PresenceDot
                            presence={voiceSession.presence}
                            mode={voiceSession.mode}
                            activity={voiceSession.activity}
                          />
                        )}
                      </View>
                    }
                    label={firstName}
                    sub={agent.role}
                    action={
                      <IconBtn
                        icon="chat-circle"
                        plain
                        sm
                        onPress={(e) => startChatWith(agent, e)}
                        title={t("nav.newChat")}
                      />
                    }
                    tight
                  />
                )
              })}
            </View>

            {/* Projects */}
            <View>
              <SecH label={t("nav.projects")}>
                <IconBtn
                  icon="plus"
                  plain
                  sm
                  onPress={() => {
                    setCreatingProject(true)
                    setNewProjectName("")
                  }}
                  title={t("nav.newProject")}
                />
              </SecH>
              {!creatingProject && projects.length === 0 ? (
                <EmptyHint>{t("nav.noProjects")}</EmptyHint>
              ) : null}
              {projects.map((project) => (
                <SideItem
                  key={project.projectId}
                  on={isOn("board", (p) => p.projectId === project.projectId)}
                  onPress={(e) => {
                    setMobileMenuOpen(false)
                    openWindow(
                      "board",
                      { projectId: project.projectId, projectName: project.name, view: "mission" },
                      shouldOpenInNewTab(e),
                    )
                  }}
                  icon="kanban"
                  label={project.name}
                />
              ))}
            </View>

            {/* Conversations */}
            <View>
              <SecH label={t("nav.conversations")}>
                <IconBtn
                  icon="magnifying-glass"
                  plain
                  sm
                  onPress={(e) => {
                    setMobileMenuOpen(false)
                    openWindow(
                      "conversations",
                      { workspaceId: activeWorkspaceId ?? undefined },
                      shouldOpenInNewTab(e),
                    )
                  }}
                  title={t("nav.search")}
                />
                <IconBtn
                  icon="caret-right"
                  plain
                  sm
                  onPress={(e) => {
                    setMobileMenuOpen(false)
                    openWindow(
                      "conversations",
                      { workspaceId: activeWorkspaceId ?? undefined },
                      shouldOpenInNewTab(e),
                    )
                  }}
                  title={t("nav.viewAll")}
                />
              </SecH>
              {recentConversations.map((conv) => (
                <SideItem
                  key={conv.channelId}
                  on={isOn("chat", (p) => p.channelId === conv.channelId)}
                  onPress={(e) => handleOpenConversation(conv.channelId, e)}
                  leading={
                    <ConversationAvatar
                      channelId={conv.channelId}
                      name={conv.agentName || conv.title || "C"}
                      imageUrl={conv.agentAvatarUrl}
                    />
                  }
                  label={conv.title || t("nav.newConversation")}
                  meta={relTime(conv.lastMessageAt)}
                  tight
                />
              ))}
              {(totalActiveConvs > 10 || totalInactiveConvs > 0) && (
                <SideItem
                  grp
                  icon="caret-right"
                  label={
                    totalActiveConvs > 10
                      ? t("nav.moreConversations", { count: totalActiveConvs - 10 })
                      : t("nav.inactive")
                  }
                  meta={totalActiveConvs > 10 ? undefined : String(totalInactiveConvs)}
                  onPress={() => {
                    setMobileMenuOpen(false)
                    openWindow("conversations", { workspaceId: activeWorkspaceId ?? undefined })
                  }}
                />
              )}
              {totalArchivedConvs > 0 && (
                <SideItem
                  grp
                  icon="caret-right"
                  label={t("nav.archived")}
                  meta={String(totalArchivedConvs)}
                  on={isOn("archived-conversations")}
                  onPress={() => {
                    setMobileMenuOpen(false)
                    openWindow("archived-conversations", {
                      workspaceId: activeWorkspaceId ?? undefined,
                    })
                  }}
                />
              )}
            </View>

            {/* Apps */}
            <View>
              <SecH label={t("nav.apps")} />
              <SideItem
                icon="cube"
                label={t("nav.apps")}
                on={isOn("apps")}
                onPress={handleOpenApps}
                meta={sortedApps.length ? String(sortedApps.length) : undefined}
              />
              <SideItem
                icon="storefront"
                label={t("nav.catalog")}
                on={isOn("catalog")}
                onPress={handleOpenCatalog}
              />
              <SideItem
                icon="books"
                label={t("nav.skills")}
                on={isOn("skills")}
                onPress={handleOpenSkills}
              />
              <SideItem
                icon="list-checks"
                label={t("nav.todo")}
                on={isOn("todo")}
                onPress={handleOpenTodo}
              />
              {academyEnabled && (
                <SideItem
                  icon="graduation-cap"
                  label={t("nav.academy")}
                  on={isOn("academy")}
                  onPress={handleOpenAcademy}
                />
              )}
              {automateEnabled && (
                <SideItem
                  testID="nav-automate"
                  icon="lightning"
                  label={t("nav.automate", "Automate")}
                  on={isOn("automate")}
                  onPress={handleOpenAutomate}
                />
              )}
            </View>

            {/* Account */}
            <View>
              <SecH label={t("nav.account")} />
              <SideItem
                testID="nav-profile"
                icon="user-circle"
                label={t("nav.profile")}
                on={isOn("profile")}
                onPress={handleOpenProfile}
              />
              <SideItem
                icon="cloud"
                label={t("nav.providers")}
                on={isOn("providers")}
                onPress={handleOpenProviders}
              />
              {/* WNEW-REQ-1: absent while whats-new.enabled is off */}
              {onWhatsNew && (
                <SideItem
                  testID="nav-whats-new"
                  icon="sparkle"
                  label={t("nav.whatsNew")}
                  onPress={onWhatsNew}
                />
              )}
            </View>

            {/* Admin */}
            {isAdmin && (
              <View>
                <SecH label={t("nav.admin")} />
                <SideItem
                  icon="cpu"
                  label={t("nav.agentCores")}
                  on={isOn("agent-cores")}
                  onPress={handleOpenAgentCores}
                />
                <SideItem
                  icon="package"
                  label={t("nav.mcas")}
                  on={isOn("mcas")}
                  onPress={handleOpenMcas}
                />
                <SideItem
                  testID="nav-users"
                  icon="users-three"
                  label={t("nav.users")}
                  on={isOn("users")}
                  onPress={handleOpenUsers}
                />
                <SideItem
                  icon="gauge"
                  label="Monitoring"
                  on={isOn("monitoring")}
                  onPress={handleOpenMonitoring}
                />
                <SideItem
                  icon="lightning"
                  label="Latitude Signals"
                  on={isOn("latitude-signals")}
                  onPress={handleOpenLatitudeSignals}
                />
                <SideItem
                  icon="flag"
                  label={t("nav.featureFlags")}
                  on={isOn("feature-flags")}
                  onPress={handleOpenFeatureFlags}
                />
                <SideItem
                  testID="nav-teros-provider"
                  icon="cpu"
                  label={t("nav.terosProvider")}
                  on={isOn("teros-provider")}
                  onPress={handleOpenTerosProvider}
                />
                <SideItem
                  testID="nav-billing-requests"
                  icon="credit-card"
                  label={t("nav.billingRequests")}
                  on={isOn("billing-requests")}
                  onPress={handleOpenBillingRequests}
                  trailing={
                    pendingBillingRequests > 0 ? (
                      <CountPill n={pendingBillingRequests > 99 ? "99+" : pendingBillingRequests} />
                    ) : undefined
                  }
                />
                <SideItem
                  testID="nav-billing-teams"
                  icon="buildings"
                  label={t("nav.billingTeams")}
                  on={isOn("billing-teams")}
                  onPress={handleOpenBillingTeams}
                />
              </View>
            )}
          </ScrollView>
          {scrollState.canScrollDown && (
            <LinearGradient
              colors={["transparent", c.bgFrame]}
              style={styles.scrollGradientBottom}
              pointerEvents="none"
            />
          )}
        </View>

        {/* Desktops (the layout segment of the prototype) */}
        <View style={styles.layoutSeg}>
          <DesktopIndicator />
        </View>

        {/* Alice's presence — between the desktops and the person (Pablo, PoC 2026-10-31) */}
        <VoicePresenceBlock />

        {/* User row */}
        <View style={styles.userRow}>
          <TouchableOpacity
            style={styles.userMain}
            onPress={(e) => handleOpenProfile(e)}
            activeOpacity={0.8}
          >
            <View style={styles.userAv}>
              <Text style={styles.userAvText}>{userInitials || "U"}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.userName} numberOfLines={1}>
                {userName}
              </Text>
              <Text style={styles.userMeta} numberOfLines={1}>
                {[activeWs?.role ?? userRole, activeWs?.name]
                  .filter(Boolean)
                  .join(" · ")
                  .toUpperCase()}
              </Text>
            </View>
          </TouchableOpacity>
          <ThemeToggleButton />
        </View>
      </>
    )
  }

  return (
    <View style={styles.container} {...fx("shell")}>
      {/* The frame melt (web): the sheet bulges into the sidebar's right edge.
          Only on the expanded desktop sidebar, like the prototype. */}
      {!isMobile && isExpanded && Platform.OS === "web" ? (
        <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: sidebarWidth }}>
          <FrameMelt side="side" frame={c.bgFrame} sheet={c.bgSheet} />
        </View>
      ) : null}
      {/* Desktop Sidebar */}
      {!isMobile && (
        <View
          style={[
            styles.sidebar,
            { width: sidebarWidth, paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
        >
          {renderSidebarContent(!isExpanded)}
        </View>
      )}

      {/* Main Content Area — the sheet */}
      <View style={styles.mainContent}>
        <View style={[styles.pageContent, !isMobile && { paddingTop: insets.top }]}>
          {children}
        </View>
      </View>

      {/* Mobile Sidebar Drawer */}
      {isMobile && (
        <Modal
          visible={isMobileMenuOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setMobileMenuOpen(false)}
        >
          <View style={styles.modalOverlay}>
            <TouchableOpacity
              style={styles.modalBackdrop}
              onPress={() => setMobileMenuOpen(false)}
              activeOpacity={1}
            />
            <View
              style={[
                styles.mobileSidebar,
                { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 },
              ]}
            >
              {renderSidebarContent(false)}
            </View>
          </View>
        </Modal>
      )}

      {renderCreateProjectModal()}

      {/* New Conversation Modal */}
      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgentForConversation}
      />
    </View>
  )
}

// ========================================
// SIDEBAR ITEM (`.item`)
// ========================================

interface SideItemProps {
  label: string
  sub?: string
  icon?: string
  leading?: React.ReactNode
  trailing?: React.ReactNode
  action?: React.ReactNode
  meta?: string
  on?: boolean
  /** Group row (Inactivas / Archivadas): smaller, quieter. */
  grp?: boolean
  /** Avatar rows hug the left edge (`.item.ag`). */
  tight?: boolean
  onPress?: (e?: any) => void
  testID?: string
}

function SideItem({
  label,
  sub,
  icon,
  leading,
  trailing,
  action,
  meta,
  on,
  grp,
  tight,
  onPress,
  testID,
}: SideItemProps) {
  const c = useColors()
  const styles = useNavbarStyles()
  const [hover, setHover] = useState(false)
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        styles.item,
        grp && styles.itemGrp,
        tight && styles.itemTight,
        (hover || pressed) && !on && styles.itemHover,
        on && styles.itemOn,
        pressed && { transform: [{ scale: 0.985 }] },
      ]}
    >
      {on ? <View {...fx("pip")} style={styles.itemPip} /> : null}
      {leading ??
        (icon ? (
          <Ph name={icon} size={grp ? 12 : 16} color={on ? c.accent : grp ? c.text3 : c.text2} />
        ) : null)}
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 4 }}>
        <Text
          style={[
            styles.itemText,
            grp && styles.itemGrpText,
            (hover || on) && { color: on ? c.accent : c.text },
            // With a role beside it the name never gives way: the role is what
            // truncates. (Alone, a long label still ellipsizes.)
            sub ? { flexShrink: 0, maxWidth: "100%" } : null,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {sub ? (
          <Text
            style={[styles.itemSub, { minWidth: 0 }, on && { color: c.accent, opacity: 0.8 }]}
            numberOfLines={1}
          >
            · {sub}
          </Text>
        ) : null}
      </View>
      {action && hover ? action : meta ? <Text style={styles.itemMeta}>{meta}</Text> : null}
      {trailing}
    </Pressable>
  )
}

function RailBtn({
  icon,
  label,
  on,
  onPress,
}: {
  icon: string
  label: string
  on?: boolean
  onPress?: (e?: any) => void
}) {
  const c = useColors()
  const styles = useNavbarStyles()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered, pressed }: any) => [
        styles.railBtn,
        (hovered || pressed) && styles.itemHover,
        on && styles.railBtnOn,
      ]}
    >
      <Ph name={icon} size={19} color={on ? c.accent : c.text3} />
    </Pressable>
  )
}

// ========================================
// HELPERS
// ========================================

function findActiveWindowId(
  node: LayoutNode | null,
  containerId: string | null | undefined,
): string | null {
  if (!node || !containerId) return null
  if (node.type === "container") return node.id === containerId ? node.activeWindowId : null
  return findActiveWindowId(node.first, containerId) || findActiveWindowId(node.second, containerId)
}

/** Compact relative time for the conversation rows (language-neutral). */
function relTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return undefined
  const m = Math.floor(ms / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d`
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

// ========================================
// STYLES
// ========================================

const buildStyles = (c: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    container: {
      flex: 1,
      flexDirection: "row",
      backgroundColor: c.bgFrame,
      // isolation: the side melt paints at z -1, i.e. above this background
      // and below every sidebar child, without leaking under the page.
      ...(Platform.OS === "web" && { display: "flex" as any, isolation: "isolate" as any }),
    },

    // ── Sidebar frame ──
    sidebar: {
      backgroundColor: "transparent",
      paddingHorizontal: 12,
      gap: 10,
      ...(Platform.OS === "web" && { overflow: "visible" as any }),
    },
    // Vertically centred on the 44px tab bar of the panes (arrows · tabs),
    // so the brand and the chrome read as one line: 6 + 32 / 2 = 22.
    brand: {
      flexDirection: "row",
      alignItems: "center",
      height: 32,
      marginTop: 6,
      paddingHorizontal: 2,
    },
    brandHome: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      height: 32,
      paddingLeft: 4,
      paddingRight: 8,
      borderRadius: 10,
    },

    // `.agent-switch` in the unida sidebar: a transparent row, the chip hugs
    // its content on the left and the "+" sits at the far right.
    agentRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    // `.as-chip`: a 46px wash pill — avatar · serif name · caret. No card,
    // no shadow; the hover only deepens the wash.
    agentSwitch: {
      flexShrink: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      height: 46,
      paddingLeft: 6,
      paddingRight: 14,
      borderRadius: 100,
      backgroundColor: c.wash2,
      ...(Platform.OS === "web" && ({ transition: "background 0.2s" } as any)),
    },
    agentSwitchPlaceholder: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.tile,
      alignItems: "center",
      justifyContent: "center",
    },
    agentSwitchName: {
      fontFamily: FONT_SERIF,
      fontSize: 16,
      lineHeight: 20,
      color: c.text,
      fontWeight: "400",
    },
    agentSwitchExtra: {
      fontFamily: FONT_MONO,
      fontSize: 10,
      color: c.text3,
    },
    newChat: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      ...(Platform.OS === "web" && ({ transition: "background 0.4s, transform 0.3s" } as any)),
    },

    wsRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      ...(Platform.OS === "web" && ({ zIndex: 2 } as any)),
    },

    // ── Workspace menu (`.menu`) ──
    menuBackdrop: {
      position: "fixed" as any,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 19998,
    },
    menu: {
      position: "absolute",
      top: 48,
      left: 12,
      width: EXPANDED_WIDTH - 24,
      padding: 6,
      borderRadius: 16,
      // Panel contrast (same 31-oct pass): bgStep is the page colour in dark,
      // so the floating menu's edge died against the page + border is a 4 %
      // hairline. borderStrong (7.5 % bone in dark / #E5DFEF in light) still
      // hints; the panel separates by elevRaised — text3 would be too heavy
      // for a floating panel. Light: #E5DFEF on white, unchanged.
      backgroundColor: c.bgStep,
      borderWidth: 1,
      borderColor: c.borderStrong,
      zIndex: 19999,
      elevation: 8,
      ...(Platform.OS === "web" && {
        position: "fixed" as any,
        boxShadow: c.elevRaised,
        backdropFilter: "blur(18px) saturate(1.4)" as any,
      }),
    },
    menuCollapsed: {
      ...(Platform.OS === "web" && { left: COLLAPSED_WIDTH + 8 }),
    },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 10,
    },
    menuItemHover: { backgroundColor: c.wash },
    menuItemOn: { backgroundColor: c.navActive },
    menuItemText: {
      flex: 1,
      minWidth: 0,
      fontFamily: FONT_SANS,
      fontSize: 13,
      color: c.text,
    },
    menuItemMeta: {
      fontFamily: FONT_MONO,
      fontSize: 10,
      letterSpacing: 0.5,
      color: c.text3,
    },
    menuHr: { height: 1, backgroundColor: c.border, marginVertical: 6, marginHorizontal: 4 },

    // ── Scroll area ──
    sidebarContentWrapper: {
      flex: 1,
      position: "relative",
      marginHorizontal: -6,
    },
    sidebarContent: { flex: 1, paddingHorizontal: 6 },
    sidebarContentIn: { gap: 14, paddingBottom: 8 },
    scrollGradientTop: { position: "absolute", top: 0, left: 0, right: 0, height: 24, zIndex: 10 },
    scrollGradientBottom: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      height: 24,
      zIndex: 10,
    },

    // ── Items (`.item`) ──
    item: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 30,
      paddingVertical: 4,
      paddingLeft: 12,
      paddingRight: 8,
      borderRadius: 10,
      position: "relative",
      ...(Platform.OS === "web" &&
        ({ cursor: "pointer", transition: "background 0.2s, color 0.2s" } as any)),
    },
    itemTight: { paddingLeft: 4 },
    itemHover: { backgroundColor: c.wash },
    itemOn: { backgroundColor: c.navActive },
    itemPip: {
      position: "absolute",
      left: -8.5,
      top: "50%",
      marginTop: -2.5,
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: semanticColors.purple300,
    },
    itemText: {
      fontFamily: FONT_SANS,
      fontSize: 12.5,
      lineHeight: 17,
      color: c.text2,
      flexShrink: 1,
    },
    itemSub: {
      fontFamily: FONT_SANS,
      fontSize: 12.5,
      lineHeight: 17,
      color: c.text3,
      flexShrink: 1,
    },
    itemMeta: {
      fontFamily: FONT_MONO,
      fontSize: 10,
      color: c.text3,
    },
    itemGrp: { minHeight: 28 },
    itemGrpText: { fontSize: 12, color: c.text3 },

    // ── Layout segment (desktops) ──
    // Pablo (31-oct): with the navbar EXPANDED the desktop dots must sit
    // CENTERED in the available area — flex-end glued them to the far right,
    // which looked wrong next to the left-aligned nav sections. (The
    // collapsed rail is centered already via railFoot's alignItems center.)
    layoutSeg: {
      alignItems: "center",
      alignSelf: "stretch",
      paddingVertical: 2,
    },

    // ── User row ──
    userRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 4,
      paddingBottom: 12,
    },
    userMain: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    userAv: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.tint.m.bg,
      alignItems: "center",
      justifyContent: "center",
    },
    userAvText: {
      fontFamily: FONT_SANS,
      fontSize: 11,
      letterSpacing: 0.5,
      color: c.tint.m.tx,
    },
    userName: {
      fontFamily: FONT_SANS,
      fontSize: 13,
      lineHeight: 17,
      color: c.text,
    },
    userMeta: {
      fontFamily: FONT_MONO,
      fontSize: 9,
      letterSpacing: 0.8,
      color: c.text3,
      marginTop: 2,
    },

    // ── Rail (collapsed) ──
    rail: {
      flex: 1,
      alignItems: "center",
      gap: 8,
      paddingTop: 12,
      paddingBottom: 8,
    },
    railLogo: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    railNew: {
      width: 40,
      height: 40,
      borderRadius: 14,
      backgroundColor: c.inkPill,
      alignItems: "center",
      justifyContent: "center",
    },
    railStories: { flex: 1, alignSelf: "stretch" },
    railStoriesIn: { alignItems: "center", gap: 8, paddingVertical: 6 },
    railStory: { padding: 3, borderRadius: 100 },
    railStoryOn: { backgroundColor: c.navActive },
    railNav: { gap: 2, marginTop: 6, alignItems: "center" },
    railBtn: {
      width: 44,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    railBtnOn: { backgroundColor: c.navActive },
    railFoot: { alignItems: "center", gap: 8, paddingTop: 8 },

    // ── Main content ──
    mainContent: { flex: 1, backgroundColor: "transparent", minWidth: 0 },
    pageContent: { flex: 1 },

    // ── Mobile drawer ──
    modalOverlay: { flex: 1, flexDirection: "row" },
    modalBackdrop: { flex: 1, backgroundColor: "rgba(32,28,39,0.35)" },
    mobileSidebar: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: EXPANDED_WIDTH,
      backgroundColor: c.bgFrame,
      paddingHorizontal: 12,
      gap: 10,
    },

    // ── Create project modal ──
    scrim: {
      flex: 1,
      backgroundColor: "rgba(32,28,39,0.35)",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    modal: {
      width: 480,
      maxWidth: "100%",
      borderRadius: 24,
      backgroundColor: c.bgStep,
      overflow: "hidden",
      ...(Platform.OS === "web" && ({ boxShadow: c.elevRaised } as any)),
    },
    modalHead: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 14,
      paddingTop: 24,
      paddingHorizontal: 28,
      paddingBottom: 16,
    },
    modalBody: { paddingHorizontal: 28, paddingBottom: 24 },
    modalFoot: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 16,
      paddingHorizontal: 24,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
  })

// Hook: memoized styles that adapt to theme
function useNavbarStyles() {
  const c = useColors()
  return useMemo(() => buildStyles(c), [c])
}

// ========================================
// THEME TOGGLE (`.toggle`)
// ========================================

function ThemeToggleButton() {
  const theme = useUiPreferencesStore((s) => s.theme)
  const toggleTheme = useUiPreferencesStore((s) => s.toggleTheme)
  const isDark = theme === "dark"
  return (
    <InkToggle
      icon={isDark ? "sun" : "moon"}
      onPress={toggleTheme}
      title={isDark ? "Light theme" : "Dark theme"}
    />
  )
}

/**
 * The agent's avatar in a sidebar conversation row: it shows the working
 * state (the thinking glow) while that agent is working in THAT channel.
 */
function ConversationAvatar({
  channelId,
  name,
  imageUrl,
}: {
  channelId: string
  name: string
  imageUrl?: string | null
}) {
  const working = useChatStore((state) => state.channels[channelId]?.isTyping ?? false)
  return (
    <Avatar name={name} imageUrl={imageUrl} size={28} isAgent status={working ? "busy" : "live"} />
  )
}
