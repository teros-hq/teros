/**
 * ConversationsWindowContent - Lista de conversaciones como ventana del workspace
 *
 * Features:
 * - Lista de conversaciones activas del workspace actual
 * - Create new conversation with agent selector
 * - Archive/restore conversations
 * - Mark as read
 * - Real-time updates for unread messages
 * - Sub-conversations are hidden from the list (they live inside their parent)
 * - Theme-aware (light/dark) via useColors() + the OS design primitives
 *
 * Look: the OS prototype's "Todo lo que habéis hablado." page — eyebrow +
 * serif headline + lead, a violet "Nuevo chat" pill, search Field + PTabs
 * (Activas / Inactivas / Archivadas / Todas) + agent SelectField, and an
 * LGroup of rows (Avatar 36 · title · "Agente · preview" · time · pills).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Platform, Pressable, View } from "react-native"
import { useTranslation } from "react-i18next"
import { Dialog, Popover } from "tamagui"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useChannelsAgentHours } from "../../hooks/useChannelAgentHours"
import { formatAgentDuration } from "@teros/shared"
import { getDateLocale } from "../../i18n"
import { NewConversationModal } from "../../components/NewConversationModal"
import { TerosLoading } from "../../components/TerosLoading"
import { useChatStore } from "../../store/chatStore"
import { useAuthStore } from "../../store/authStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { ConversationsWindowProps } from "./definition"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import { MoveToWorkspaceModal } from "../../components/MoveToWorkspaceModal"
import { useColors } from "../../components/mca/primitives/useColors"
import { PrePublishWarningDialog } from "../../components/chat/PrePublishWarningDialog"
import { useScopeToggle } from "../../hooks/chat/useScopeToggle"
import {
  Badge,
  Btn,
  CountPill,
  EmptyState,
  Field,
  IconBtn,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  PTabs,
  SectionLabel,
  SelectField,
  T,
} from "../../components/ui/ds"

/** "Activas" = activity in the last 3 hours (the prototype's rule). */
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000

type TabKey = "active" | "inactive" | "archived" | "all"

/** WS2: exported for the agent-hours render test (surface 2). */
export interface Conversation {
  channelId: string
  title: string
  agentId?: string
  agentName?: string
  agentAvatarUrl?: string
  lastMessageAt?: string | null
  lastMessageContent?: string
  status?: "active" | "closed"
  unreadCount?: number
  /** An external action has been requested (to a human or another agent) */
  externalActionRequested?: boolean
  /** Transport type: 'web' | 'voice' */
  transport?: string
  /** If set, this is a sub-conversation delegated from the given parent channel */
  originChannelId?: string
  /** Channel scope — 'personal' or 'shared'. Missing = 'personal' (default). */
  scope?: "personal" | "shared"
  /** The userId of the channel creator (used for sidebar sectioning and toggle permission). */
  creatorId?: string
}

interface SearchMatch {
  messageId: string
  snippet: string
  timestamp: string
  role: "user" | "assistant" | "system"
}

interface SearchResultChannel {
  channelId: string
  channelName: string
  agentId: string
  agentName: string
  matches: SearchMatch[]
}

export function ConversationsWindowContent({
  windowId,
  workspaceId,
  filter = "active",
}: ConversationsWindowProps & { windowId: string }) {
  const { t } = useTranslation()
  const c = useColors()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [connected, setConnected] = useState(false)
  const [showNewConversationModal, setShowNewConversationModal] = useState(false)
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [pendingArchiveChannelId, setPendingArchiveChannelId] = useState<string | null>(null)

  // Move to workspace state
  const [showMoveModal, setShowMoveModal] = useState(false)
  const [pendingMoveChannelId, setPendingMoveChannelId] = useState<string | null>(null)

  // Presentation state: tab + agent filter (prototype's PTabs + SelectField)
  const [tab, setTab] = useState<TabKey>(filter)
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const autoTabRef = useRef(false)

  // Scope toggle (MUW-10 / MUW-15) — shared hook with ChatView.
  const {
    isScanning: isScanningPublish,
    showWarning: showPrePublishWarning,
    personalApps: prePublishPersonalApps,
    toggleScope: handleToggleScope,
    confirmPublishAnyway,
    cancelPublishWarning,
  } = useScopeToggle({
    onScopeChanged: (changedChannelId, newScope) => {
      setConversations((prev) =>
        prev.map((c2) => (c2.channelId === changedChannelId ? { ...c2, scope: newScope } : c2)),
      )
    },
  })

  // Search state
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchResultChannel[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchPending, setSearchPending] = useState(false)
  const [totalMatches, setTotalMatches] = useState(0)

  const client = getTerosClient()
  const { openWindow, findWindow, focusWindow, switchToDesktop, activeDesktopIndex } = useTilingStore()
  // Always use the active workspace from the store — no prop, no fallback.
  // This is a platform-wide rule: conversations are always scoped to the active workspace.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  // Connection status
  useEffect(() => {
    const handleConnected = () => setConnected(true)
    const handleDisconnected = () => setConnected(false)

    client.on("connected", handleConnected)
    client.on("disconnected", handleDisconnected)
    setConnected(client.isConnected())

    return () => {
      client.off("connected", handleConnected)
      client.off("disconnected", handleDisconnected)
    }
  }, [])

  // Load data when connected
  useEffect(() => {
    if (!connected) return
    loadConversations()
  }, [connected])

  // Debounced search
  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([])
      setTotalMatches(0)
      setSearchPending(false)
      return
    }

    setSearchPending(true)

    const timer = setTimeout(async () => {
      setIsSearching(true)
      try {
        const result = await client.channel.search(searchQuery)
        setSearchResults(result.results)
        setTotalMatches(result.totalMatches)
      } catch (err) {
        console.error("[ConversationsWindow] Search error:", err)
        setSearchResults([])
        setTotalMatches(0)
      } finally {
        setIsSearching(false)
        setSearchPending(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery, connected])

  // Listen for channel list updates in real-time
  useEffect(() => {
    if (!connected) return

    const handleChannelListStatus = (data: any) => {
      const { channelId, action, channel } = data

      if (action === "created") {
        // Skip sub-conversations and headless channels
        if (channel?.originChannelId || channel?.headless) return

        const newConv: Conversation = {
          channelId,
          title: channel?.title || t("conversation.newChat"),
          agentId: channel?.agentId,
          agentName: channel?.agentName,
          agentAvatarUrl: channel?.agentAvatarUrl,
          lastMessageAt: channel?.createdAt || new Date().toISOString(),
          status: channel?.status || "active",
          unreadCount: 0,
          originChannelId: channel?.originChannelId,
          scope: channel?.scope ?? "personal",
          creatorId: channel?.userId,
        }

        setConversations((prev) => {
          if (prev.some((c2) => c2.channelId === channelId)) return prev
          return [newConv, ...prev]
        })
      } else if (action === "deleted") {
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.channelId === channelId) {
              return { ...conv, status: "closed" }
            }
            return conv
          }),
        )
      } else if (action === "updated") {
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.channelId === channelId) {
              return {
                ...conv,
                ...(channel?.title && { title: channel.title }),
                ...(channel?.lastMessageAt && { lastMessageAt: channel.lastMessageAt }),
                ...(channel?.lastMessageContent && {
                  lastMessageContent: channel.lastMessageContent,
                }),
                ...(channel?.hasUnread !== undefined && {
                  unreadCount: channel.hasUnread ? (conv.unreadCount || 0) + 1 : 0,
                }),
                ...(channel?.externalActionRequested !== undefined && {
                  externalActionRequested: channel.externalActionRequested,
                }),
                ...(channel?.scope !== undefined && {
                  scope: channel.scope ?? "personal",
                }),
              }
            }
            return conv
          }),
        )
      } else if (action === "moved") {
        // The channel was moved to a different workspace — remove it from the
        // current list (it no longer belongs to the active workspace).
        setConversations((prev) => prev.filter((conv) => conv.channelId !== channelId))
      }
    }

    client.on("channel_list_status", handleChannelListStatus)

    return () => {
      client.off("channel_list_status", handleChannelListStatus)
    }
  }, [connected])

  const mapChannelToConversation = (ch: any, agentList: any[]): Conversation => {
    const agent = agentList.find((a: any) => a.agentId === ch.agentId)
    return {
      channelId: ch.channelId,
      title: ch.metadata?.name || t("nav.chat"),
      agentId: ch.agentId,
      agentName: ch.agentName || agent?.name || agent?.fullName,
      agentAvatarUrl: ch.agentAvatarUrl || agent?.avatarUrl,
      lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
      lastMessageContent: ch.lastMessage?.content || "",
      status: ch.status || "active",
      unreadCount: ch.unreadCount || 0,
      scope: ch.scope ?? "personal",
      transport: ch.metadata?.transport || "web",
      originChannelId: ch.originChannelId,
      creatorId: ch.userId,
    }
  }

  const loadConversations = async () => {
    setIsLoading(true)
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, { agents: agentList }] =
        await Promise.all([
          client.channel.list(activeWorkspaceId ?? undefined),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ])

      const convs: Conversation[] = channels
        .filter((ch: any) => !ch.headless && !ch.originChannelId)
        .map((ch: any) => mapChannelToConversation(ch, agentList))

      setConversations(convs)
      setNextCursor(cursor ?? null)
      setHasMore(more ?? false)
    } catch (err) {
      console.error("[ConversationsWindow] Error loading conversations:", err)
    } finally {
      setIsLoading(false)
    }
  }

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore || !nextCursor) return
    setIsLoadingMore(true)
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, { agents: agentList }] =
        await Promise.all([
          client.channel.list(activeWorkspaceId ?? undefined, undefined, 30, nextCursor),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ])

      const newConvs: Conversation[] = channels
        .filter((ch: any) => !ch.headless && !ch.originChannelId)
        .map((ch: any) => mapChannelToConversation(ch, agentList))

      setConversations((prev) => {
        const existingIds = new Set(prev.map((c2) => c2.channelId))
        const unique = newConvs.filter((c2) => !existingIds.has(c2.channelId))
        return [...prev, ...unique]
      })
      setNextCursor(cursor ?? null)
      setHasMore(more ?? false)
    } catch (err) {
      console.error("[ConversationsWindow] Error loading more conversations:", err)
    } finally {
      setIsLoadingMore(false)
    }
  }, [isLoadingMore, hasMore, nextCursor, activeWorkspaceId])

  const handleSelectConversation = async (conv: Conversation) => {
    if (conv.unreadCount && conv.unreadCount > 0) {
      try {
        await client.channel.markRead(conv.channelId)
        setConversations((prev) =>
          prev.map((c2) => (c2.channelId === conv.channelId ? { ...c2, unreadCount: 0 } : c2)),
        )
      } catch (err) {
        console.error("Error marking channel as read:", err)
      }
    }

    const existingWindow = findWindow("chat", (props) => props.channelId === conv.channelId)
    if (existingWindow) {
      // If the chat window lives on another desktop, jump to it first.
      if (existingWindow.desktopIndex !== undefined && existingWindow.desktopIndex !== activeDesktopIndex) {
        switchToDesktop(existingWindow.desktopIndex)
      }
      focusWindow(existingWindow.id)
    } else {
      openWindow(
        "chat",
        {
          channelId: conv.channelId,
          agentId: conv.agentId,
          agentName: conv.agentName,
          workspaceId: activeWorkspaceId,
        },
        false,
        windowId,
      )
    }
  }

  const handleNewConversation = () => {
    setShowNewConversationModal(true)
  }

  const handleSelectAgent = (agent: { agentId: string; name: string; fullName: string }) => {
    setShowNewConversationModal(false)
    openWindow(
      "chat",
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId,
      },
      false,
      windowId,
    )
  }

  const handleArchiveConversation = (channelId: string) => {
    setPendingArchiveChannelId(channelId)
    setShowArchiveConfirm(true)
  }

  const confirmArchiveConversation = async () => {
    if (!pendingArchiveChannelId) return
    try {
      await client.channel.close(pendingArchiveChannelId)
      setConversations((prev) =>
        prev.map((c2) =>
          c2.channelId === pendingArchiveChannelId ? { ...c2, status: "closed" as const } : c2,
        ),
      )
    } catch (err) {
      console.error("Error archiving conversation:", err)
    } finally {
      setShowArchiveConfirm(false)
      setPendingArchiveChannelId(null)
    }
  }

  const handleRestoreConversation = async (channelId: string) => {
    try {
      await client.channel.reopen(channelId)
      setConversations((prev) =>
        prev.map((c2) => (c2.channelId === channelId ? { ...c2, status: "active" as const } : c2)),
      )
    } catch (err) {
      console.error("Error restoring conversation:", err)
    }
  }

  const handleMoveToWorkspace = (channelId: string) => {
    setPendingMoveChannelId(channelId)
    setShowMoveModal(true)
  }

  const handleMarkAsRead = async (channelId: string) => {
    try {
      await client.channel.markRead(channelId)
      setConversations((prev) =>
        prev.map((c2) => (c2.channelId === channelId ? { ...c2, unreadCount: 0 } : c2)),
      )
    } catch (err) {
      console.error("Error marking as read:", err)
    }
  }

  const handleSearchResultClick = (channelId: string, messageId: string, agentName?: string) => {
    setSearchQuery("")
    setSearchResults([])

    const existingWindow = findWindow("chat", (props) => props.channelId === channelId)

    if (existingWindow) {
      focusWindow(existingWindow.id)
    } else {
      openWindow(
        "chat",
        {
          channelId,
          agentName,
          workspaceId: activeWorkspaceId,
        },
        false,
        windowId,
      )
    }
  }

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return ""
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return t("conversation.now")
    if (diffMins < 60) return `${diffMins}m`
    if (diffHours < 24) return `${diffHours}h`
    if (diffDays < 7) return `${diffDays}d`
    return date.toLocaleDateString(getDateLocale(), { day: "numeric", month: "short" })
  }

  // Current user ID — used to determine which conversations are "mine" vs "shared"
  const currentUserId = useAuthStore((state: any) => state.user?.userId)

  // All non-archived conversations in a single flat list (no inactive section)
  const activeConvs = conversations.filter((conv) => conv.status !== "closed")
  const archivedConvs = conversations.filter((conv) => conv.status === "closed")

  // Prototype tabs: Activas (activity in the last 3 h, unread or waiting on you) · Inactivas · Archivadas · Todas
  const isRecent = (conv: Conversation) => {
    if ((conv.unreadCount ?? 0) > 0 || conv.externalActionRequested) return true
    if (!conv.lastMessageAt) return false
    return Date.now() - new Date(conv.lastMessageAt).getTime() <= ACTIVE_WINDOW_MS
  }
  const recentConvs = activeConvs.filter(isRecent)
  const staleConvs = activeConvs.filter((conv) => !isRecent(conv))

  // WS2: agent-hours per conversation for the current billing period. ONE
  // batch call for the whole list (never N per-row calls); the shared module
  // cache dedupes with the chat header chip and the task surfaces.
  const { byChannel: agentHoursByChannel } = useChannelsAgentHours(
    useMemo(() => conversations.map((conv) => conv.channelId), [conversations]),
  )

  // First load: if the default "Activas" tab would be empty while there are
  // conversations, land on "Todas" so nothing is hidden on open.
  useEffect(() => {
    if (isLoading || autoTabRef.current) return
    autoTabRef.current = true
    if (
      tab === "active" &&
      recentConvs.length === 0 &&
      activeConvs.length + archivedConvs.length > 0
    ) {
      setTab("all")
    }
  }, [isLoading])

  const agents = useMemo(() => {
    const map = new Map<string, { agentId: string; name: string; avatarUrl?: string }>()
    for (const conv of conversations) {
      if (conv.agentId && !map.has(conv.agentId)) {
        map.set(conv.agentId, {
          agentId: conv.agentId,
          name: conv.agentName || t("conversation.agent"),
          avatarUrl: conv.agentAvatarUrl,
        })
      }
    }
    return Array.from(map.values())
  }, [conversations])
  const selectedAgent = agentFilter ? agents.find((a) => a.agentId === agentFilter) : undefined

  const tabConvs: Conversation[] =
    tab === "active"
      ? recentConvs
      : tab === "inactive"
        ? staleConvs
        : tab === "archived"
          ? archivedConvs
          : conversations
  const visibleConvs = agentFilter
    ? tabConvs.filter((conv) => conv.agentId === agentFilter)
    : tabConvs

  // Split into "My Conversations" and "Shared" sections (REQ-9, AC-2).
  // The split is purely visual — the backend returns a single paginated list.
  // "My Conversations" = personal + my shared (creatorId === currentUserId or scope !== 'shared')
  // "Shared" = shared conversations created by other members
  const myConversations = visibleConvs.filter(
    (conv) => conv.creatorId === currentUserId || conv.scope !== "shared",
  )
  const sharedConversations = visibleConvs.filter(
    (conv) => conv.scope === "shared" && conv.creatorId !== currentUserId,
  )

  const tabItems = [
    {
      key: "active" as TabKey,
      label: t("conversations.tabActive", { defaultValue: "Activas" }),
      count: recentConvs.length,
    },
    {
      key: "inactive" as TabKey,
      label: t("conversations.tabInactive", { defaultValue: "Inactivas" }),
      count: staleConvs.length,
    },
    {
      key: "archived" as TabKey,
      label: t("conversations.tabArchived", { defaultValue: "Archivadas" }),
      count: archivedConvs.length,
    },
    {
      key: "all" as TabKey,
      label: t("conversations.tabAll", { defaultValue: "Todas" }),
      count: conversations.length,
    },
  ]

  const renderItem = (conv: Conversation) => (
    <ConversationItem
      key={conv.channelId}
      conv={conv}
      formatDate={formatDate}
      onSelect={handleSelectConversation}
      onArchive={conv.status === "closed" ? undefined : handleArchiveConversation}
      onRestore={conv.status === "closed" ? handleRestoreConversation : undefined}
      onMoveToWorkspace={handleMoveToWorkspace}
      onMarkAsRead={handleMarkAsRead}
      onToggleScope={handleToggleScope}
      isCreator={conv.creatorId === currentUserId}
      archived={conv.status === "closed"}
      agentHours={
        agentHoursByChannel[conv.channelId]
          ? formatAgentDuration(agentHoursByChannel[conv.channelId].workMs)
          : null
      }
    />
  )

  const lead = t("conversations.lead", {
    defaultValue:
      "{{convs}} conversaciones con {{agents}} agentes. La búsqueda mira dentro de los mensajes, no solo en los títulos.",
    convs: conversations.length,
    agents: agents.length,
  })

  return (
    <Page>
      <PageHead
        eyebrow={t("windows.conversations")}
        title={t("conversations.headline", { defaultValue: "Todo lo que habéis hablado." })}
        accent={t("conversations.headlineAccent", { defaultValue: "hablado." })}
        lead={lead}
        actions={
          <View
            accessibilityLabel={t("conversations.newConversationTooltip")}
            {...(Platform.OS === "web"
              ? ({ title: t("conversations.newConversationTooltip") } as any)
              : {})}
          >
            <Btn
              variant="primary"
              size="lg"
              icon="note-pencil"
              onPress={handleNewConversation}
              testID="conversations-new-chat"
            >
              {t("conversation.newChat")}
            </Btn>
          </View>
        }
      />

      {/* Toolbar: search · tabs · agent filter */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <Field
          icon="magnifying-glass"
          placeholder={t("conversations.searchPlaceholder")}
          value={searchQuery}
          onChangeText={setSearchQuery}
          containerStyle={{ width: 300, maxWidth: "100%", flexShrink: 1 }}
          right={
            searchQuery.length > 0 ? (
              <IconBtn
                icon="x"
                plain
                sm
                onPress={() => setSearchQuery("")}
                accessibilityLabel={t("common.close")}
              />
            ) : undefined
          }
        />
        <PTabs items={tabItems} value={tab} onChange={setTab} />
        <View style={{ flex: 1 }} />
        {agents.length > 0 ? (
          <Popover open={agentMenuOpen} onOpenChange={setAgentMenuOpen} placement="bottom-end">
            <Popover.Trigger asChild>
              <View>
                <SelectField
                  icon={
                    selectedAgent ? (
                      <Avatar
                        name={selectedAgent.name}
                        imageUrl={selectedAgent.avatarUrl}
                        size={18}
                        isAgent
                      />
                    ) : (
                      "users-three"
                    )
                  }
                  label={
                    selectedAgent
                      ? selectedAgent.name
                      : t("conversations.allAgents", { defaultValue: "Todos los agentes" })
                  }
                  onPress={() => setAgentMenuOpen((o) => !o)}
                  style={{
                    minWidth: 170,
                    borderRadius: 100,
                    backgroundColor: c.wash,
                    borderColor: "transparent",
                  }}
                />
              </View>
            </Popover.Trigger>
            <Popover.Content
              backgroundColor={c.bgStep}
              borderWidth={0}
              borderRadius={14}
              padding={6}
              animation="quick"
              enterStyle={{ opacity: 0, y: -4 }}
              exitStyle={{ opacity: 0, y: -4 }}
              style={Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : undefined}
            >
              <MenuItem
                icon="users-three"
                label={t("conversations.allAgents", { defaultValue: "Todos los agentes" })}
                on={!agentFilter}
                onPress={() => {
                  setAgentFilter(null)
                  setAgentMenuOpen(false)
                }}
              />
              {agents.map((a) => (
                <MenuItem
                  key={a.agentId}
                  leading={<Avatar name={a.name} imageUrl={a.avatarUrl} size={20} isAgent />}
                  label={a.name}
                  on={agentFilter === a.agentId}
                  onPress={() => {
                    setAgentFilter(a.agentId)
                    setAgentMenuOpen(false)
                  }}
                />
              ))}
            </Popover.Content>
          </Popover>
        ) : null}
      </View>

      <T step="12" tone="text3" style={{ marginBottom: 16 }}>
        {t("conversations.hint", {
          defaultValue:
            "Activas = con actividad en las últimas 3 h. Usa el menú de cada fila para archivarla o moverla de workspace.",
        })}
      </T>

      {/* List */}
      {isLoading ? (
        <View style={{ alignItems: "center", paddingVertical: 48 }}>
          <AppSpinner variant="brand" />
        </View>
      ) : searchQuery.length >= 2 ? (
        /* Search Results */
        <View>
          {isSearching || searchPending ? (
            <View style={{ alignItems: "center", paddingVertical: 32, gap: 8 }}>
              <AppSpinner size="sm" variant="brand" />
              <T step="sm" tone="text3">
                {t("conversations.searching")}
              </T>
            </View>
          ) : searchResults.length === 0 ? (
            <EmptyState
              icon="magnifying-glass"
              title={t("conversations.noResultsFor", { query: searchQuery })}
            />
          ) : (
            <>
              {/* Results count */}
              <SectionLabel
                label={t("conversations.searchResultsSummary", {
                  matches: totalMatches,
                  channels: searchResults.length,
                })}
                dot={false}
              />

              {/* Results grouped by channel */}
              <View style={{ gap: 12 }}>
                {searchResults.map((channel) => (
                  <LGroup key={channel.channelId}>
                    {/* Channel header */}
                    <LRow padV={10}>
                      <Avatar
                        name={channel.agentName || t("conversation.agent")}
                        size={28}
                        isAgent
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T step="sm" ellipsis>
                          <T step="sm" tone="accent">
                            {channel.agentName}
                          </T>
                          <T step="sm" tone="text3">
                            {" · "}
                          </T>
                          {channel.channelName}
                        </T>
                      </View>
                      <T step="codenote" tone="text3">
                        {t("conversations.matchCount", { count: channel.matches.length })}
                      </T>
                    </LRow>

                    {/* Matches in this channel */}
                    {channel.matches.map((match) => (
                      <LRow
                        key={match.messageId}
                        onPress={() =>
                          handleSearchResultClick(
                            channel.channelId,
                            match.messageId,
                            channel.agentName,
                          )
                        }
                        padV={10}
                        style={{ alignItems: "flex-start" }}
                      >
                        <View style={{ width: 28 }} />
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <T step="codenote" color={match.role === "user" ? c.text2 : c.accent}>
                              {match.role === "user" ? t("conversations.you") : channel.agentName}
                            </T>
                            <T step="codenote" tone="text3">
                              {formatDate(match.timestamp)}
                            </T>
                          </View>
                          <T step="sm" tone="text2" numberOfLines={2}>
                            <HighlightedText text={match.snippet} query={searchQuery} />
                          </T>
                        </View>
                      </LRow>
                    ))}
                  </LGroup>
                ))}
              </View>
            </>
          )}
        </View>
      ) : visibleConvs.length === 0 ? (
        /* Empty state */
        <LGroup>
          <EmptyState
            icon={tab === "archived" ? "archive" : "chats-circle"}
            title={
              conversations.length === 0
                ? t("conversations.empty")
                : t("conversations.emptyTab", { defaultValue: "Nada por aquí con este filtro." })
            }
            text={
              conversations.length === 0
                ? undefined
                : t("conversations.emptyTabHint", {
                    defaultValue: "Prueba otra pestaña o quita el filtro de agente.",
                  })
            }
            action={
              conversations.length === 0 ? (
                <Btn variant="primary" icon="note-pencil" onPress={handleNewConversation}>
                  {t("conversation.newChat")}
                </Btn>
              ) : tab === "archived" ? (
                <Btn
                  variant="sec"
                  icon="archive"
                  onPress={() => openWindow("archived-conversations", {}, false, windowId)}
                >
                  {t("nav.viewArchived")}
                </Btn>
              ) : (
                <Btn
                  variant="sec"
                  onPress={() => {
                    setTab("all")
                    setAgentFilter(null)
                  }}
                >
                  {t("conversations.tabAll", { defaultValue: "Todas" })}
                </Btn>
              )
            }
          />
        </LGroup>
      ) : (
        /* Normal conversation list — split into "My Conversations" and "Shared" sections */
        <View style={{ gap: 16 }}>
          {sharedConversations.length > 0 && myConversations.length > 0 ? (
            <SectionLabel
              label={t("conversations.myConversations")}
              count={myConversations.length}
            />
          ) : null}
          {myConversations.length > 0 && (
            <View testID="conversations-mine">
              <LGroup>{myConversations.map(renderItem)}</LGroup>
            </View>
          )}

          {/* "Shared" section */}
          {sharedConversations.length > 0 && (
            <>
              <SectionLabel label={t("conversations.shared")} count={sharedConversations.length} />
              <View testID="conversations-shared">
                <LGroup>{sharedConversations.map(renderItem)}</LGroup>
              </View>
            </>
          )}

          {/* Archived — link to dedicated window */}
          {tab !== "archived" && archivedConvs.length > 0 && (
            <LRow
              hov
              onPress={() => openWindow("archived-conversations", {}, false, windowId)}
              testID="conversations-archived-link"
            >
              <Ph name="archive" size={16} color={c.text3} />
              <T step="sm" tone="text2" style={{ flex: 1 }}>
                {t("conversation.archived")}
              </T>
              <T step="codenote" tone="text3">
                {String(archivedConvs.length)}
              </T>
              <Ph name="caret-right" size={13} color={c.text3} />
            </LRow>
          )}
          {tab === "archived" && (
            <View style={{ flexDirection: "row", justifyContent: "center" }}>
              <Btn
                variant="ghost"
                icon="archive"
                onPress={() => openWindow("archived-conversations", {}, false, windowId)}
              >
                {t("nav.viewArchived")}
              </Btn>
            </View>
          )}

          {/* Load more button */}
          {hasMore && (
            <View style={{ flexDirection: "row", justifyContent: "center" }}>
              <Btn
                variant="sec"
                loading={isLoadingMore}
                onPress={loadMore}
                testID="conversations-load-more"
              >
                {t("conversations.loadMoreConversations")}
              </Btn>
            </View>
          )}
        </View>
      )}

      {/* New Conversation Modal */}
      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgent}
      />

      {/* Archive Confirmation Dialog */}
      <Dialog
        modal
        open={showArchiveConfirm}
        onOpenChange={(o) => {
          if (!o) {
            setShowArchiveConfirm(false)
            setPendingArchiveChannelId(null)
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            key="overlay"
            animation="card"
            backgroundColor={c.bgFrame}
            opacity={0.6}
            enterStyle={{ opacity: 0 }}
            exitStyle={{ opacity: 0 }}
          />
          <Dialog.Content
            key="content"
            animation="card"
            enterStyle={{ opacity: 0, scale: 0.96 }}
            exitStyle={{ opacity: 0, scale: 0.96 }}
            transformOrigin="top"
            width={440}
            maxWidth="92%"
            padding={24}
            gap={16}
            borderWidth={0}
            borderRadius={24}
            backgroundColor={c.bgStep}
            style={Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : undefined}
          >
            <Dialog.Title asChild>
              <View>
                <T step="xl">{t("conversations.archiveConfirmTitle")}</T>
              </View>
            </Dialog.Title>
            <T step="sm" tone="text2">
              {t("conversations.archiveConfirmBody")}
            </T>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>
              <Dialog.Close asChild>
                <Btn
                  variant="ghost"
                  onPress={() => {
                    setShowArchiveConfirm(false)
                    setPendingArchiveChannelId(null)
                  }}
                >
                  {t("conversations.archiveCancel")}
                </Btn>
              </Dialog.Close>
              <Btn
                variant="primary"
                icon="archive"
                onPress={confirmArchiveConversation}
                testID="conversations-archive-confirm"
              >
                {t("conversations.archiveConfirm")}
              </Btn>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* Pre-publish Warning Dialog (MUW-10 / MUW-15) — shared component */}
      <PrePublishWarningDialog
        open={showPrePublishWarning}
        personalApps={prePublishPersonalApps}
        onConfirm={confirmPublishAnyway}
        onCancel={cancelPublishWarning}
      />

      {/* Move to Workspace Dialog */}
      <MoveToWorkspaceModal
        channelId={pendingMoveChannelId}
        visible={showMoveModal}
        onClose={() => {
          setShowMoveModal(false)
          setPendingMoveChannelId(null)
        }}
        onMoved={() => {
          // Remove the conversation from the list (it now belongs to a different workspace)
          if (pendingMoveChannelId) {
            setConversations((prev) => prev.filter((c2) => c2.channelId !== pendingMoveChannelId))
          }
          setPendingMoveChannelId(null)
        }}
      />
    </Page>
  )
}

// ========================================
// MENU ITEM (popover rows)
// ========================================

function MenuItem({
  icon,
  leading,
  label,
  on,
  danger,
  onPress,
  testID,
}: {
  icon?: string
  leading?: React.ReactNode
  label: string
  on?: boolean
  danger?: boolean
  onPress: (e?: any) => void
  testID?: string
}) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  const fg = danger ? c.tint.r.tx : on ? c.accent : c.text
  return (
    <Pressable
      accessibilityRole="menuitem"
      testID={testID}
      onPress={(e: any) => {
        e?.stopPropagation?.()
        onPress(e)
      }}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minWidth: 200,
          height: 34,
          paddingHorizontal: 10,
          borderRadius: 9,
          backgroundColor: on ? c.navActive : hover ? c.wash : "transparent",
        },
        Platform.OS === "web"
          ? ({ cursor: "pointer", transition: "background 0.2s" } as any)
          : null,
      ]}
    >
      {leading ??
        (icon ? (
          <Ph name={icon} size={15} color={danger ? c.tint.r.tx : on ? c.accent : c.text2} />
        ) : null)}
      <T step="sm" color={fg} ellipsis style={{ flex: 1 }}>
        {label}
      </T>
      {on ? <Ph name="check" size={13} color={c.accent} /> : null}
    </Pressable>
  )
}

// ========================================
// CONVERSATION ITEM
// ========================================

/** WS2: exported for the agent-hours render test (surface 2). */
export function ConversationItem({
  conv,
  formatDate,
  onSelect,
  onArchive,
  onMoveToWorkspace,
  onRestore,
  onMarkAsRead,
  onToggleScope,
  isCreator = false,
  archived = false,
  agentHours = null,
}: {
  conv: Conversation
  formatDate: (date: string | null | undefined) => string
  onSelect: (conv: Conversation) => void
  onArchive?: (channelId: string) => void
  onMoveToWorkspace?: (channelId: string) => void
  onRestore?: (channelId: string) => void
  onMarkAsRead?: (channelId: string) => void
  onToggleScope?: (channelId: string, currentScope: "personal" | "shared") => void
  isCreator?: boolean
  archived?: boolean
  /** WS2: formatted agent-hours of this conversation in the billing period. */
  agentHours?: string | null
}) {
  const { t } = useTranslation()
  const c = useColors()
  const channel = useChatStore((state) => state.channels[conv.channelId])
  const isTyping = channel?.isTyping ?? false
  const [menuOpen, setMenuOpen] = useState(false)
  const [hover, setHover] = useState(false)

  const hasUnread = (conv.unreadCount ?? 0) > 0
  const externalActionRequested =
    conv.externalActionRequested ?? channel?.externalActionRequested ?? false
  const isPersonal = (conv.scope ?? (channel as any)?.scope ?? "personal") === "personal"
  const showMenu = !archived && !!onArchive

  return (
    <LRow
      onPress={() => onSelect(conv)}
      padV={12}
      padH={12}
      gap={14}
      testID={`conversation-${conv.channelId}`}
      {...(Platform.OS === "web"
        ? ({ onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) } as any)
        : {})}
    >
      {/* Avatar */}
      <Avatar
        name={conv.agentName || t("conversation.agent")}
        imageUrl={conv.agentAvatarUrl}
        size={36}
        isAgent
        status={archived ? "idle" : isTyping ? "busy" : "live"}
      />

      {/* Content */}
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Conversation title — first, it's what identifies the conversation */}
        <T step="base" tone={archived ? "text2" : "text"} ellipsis>
          {conv.title}
        </T>

        {/* Agent name + preview on one line */}
        <T step="sm" tone="text3" ellipsis style={{ marginTop: 2 }} testID={`conversation-agent-hours-${conv.channelId}`}>
          <T step="sm" tone={archived ? "text3" : "accent"}>
            {conv.agentName || t("conversation.agent")}
          </T>
          {agentHours ? ` · ${agentHours}` : ""}
          {conv.lastMessageContent && !archived ? ` · ${conv.lastMessageContent}` : ""}
        </T>
      </View>

      {/* Right column: time + pills */}
      <View style={{ alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {isPersonal && <Ph name="lock" size={12} color={c.text3} />}
          {!isPersonal && conv.scope === "shared" && (
            <Ph name="eye" size={12} color={c.text3} />
          )}
          {!archived ? (
            <T step="codenote" tone="text3">
              {formatDate(conv.lastMessageAt)}
            </T>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {isTyping && <TerosLoading size={14} color={c.accent} />}
          {!isTyping && externalActionRequested && (
            <Badge tone="a" pill icon="shield">
              {t("conversations.waitingOnYou", { defaultValue: "Te espera" })}
            </Badge>
          )}
          {!isTyping && hasUnread && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("conversations.markAsRead", {
                defaultValue: "Marcar como leída",
              })}
              onPress={(e: any) => {
                e?.stopPropagation?.()
                onMarkAsRead?.(conv.channelId)
              }}
              style={Platform.OS === "web" ? ({ cursor: "pointer" } as any) : undefined}
            >
              <CountPill n={conv.unreadCount ?? 0} tone="mint" />
            </Pressable>
          )}
        </View>
      </View>

      {/* Restore button for archived */}
      {archived && onRestore && (
        <IconBtn
          icon="arrow-counter-clockwise"
          plain
          sm
          title={t("archivedConversations.restore", { defaultValue: "Restaurar" })}
          accessibilityLabel={t("archivedConversations.restore", { defaultValue: "Restaurar" })}
          onPress={(e: any) => {
            e?.stopPropagation?.()
            onRestore(conv.channelId)
          }}
          testID={`restore-${conv.channelId}`}
        />
      )}

      {/* Menu for active conversations */}
      {showMenu && (
        <Popover open={menuOpen} onOpenChange={setMenuOpen} placement="bottom-end">
          <Popover.Trigger asChild>
            <View style={{ opacity: Platform.OS === "web" && !hover && !menuOpen ? 0.35 : 1 }}>
              <IconBtn
                icon="dots-three-vertical"
                plain
                sm
                on={menuOpen}
                accessibilityLabel={t("common.open")}
                onPress={(e: any) => {
                  e?.stopPropagation?.()
                  setMenuOpen((o) => !o)
                }}
                testID={`conversation-menu-${conv.channelId}`}
              />
            </View>
          </Popover.Trigger>

          <Popover.Content
            backgroundColor={c.bgStep}
            borderWidth={0}
            borderRadius={14}
            padding={6}
            animation="quick"
            enterStyle={{ opacity: 0, y: -4 }}
            exitStyle={{ opacity: 0, y: -4 }}
            style={Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : undefined}
          >
            {onMoveToWorkspace && (
              <MenuItem
                icon="arrows-left-right"
                label={t("conversations.moveToWorkspace")}
                onPress={() => {
                  setMenuOpen(false)
                  onMoveToWorkspace(conv.channelId)
                }}
                testID={`conversation-move-${conv.channelId}`}
              />
            )}
            {/* Visibility toggle — only shown to the channel creator (REQ-2).
                The backend enforces canToggleVisibility; non-creators get ACCESS_DENIED. */}
            {isCreator && onToggleScope && (
              <MenuItem
                icon={conv.scope === "shared" ? "eye-slash" : "eye"}
                label={
                  conv.scope === "shared"
                    ? t("conversations.makePersonal")
                    : t("conversations.makeShared")
                }
                onPress={() => {
                  setMenuOpen(false)
                  onToggleScope(conv.channelId, conv.scope === "shared" ? "shared" : "personal")
                }}
                testID={`conversation-scope-${conv.channelId}`}
              />
            )}
            <MenuItem
              icon="archive"
              label={t("conversations.archive")}
              onPress={() => {
                setMenuOpen(false)
                onArchive(conv.channelId)
              }}
              testID={`conversation-archive-${conv.channelId}`}
            />
          </Popover.Content>
        </Popover>
      )}
    </LRow>
  )
}

// ========================================
// HIGHLIGHTED TEXT (for search results)
// ========================================

function HighlightedText({ text, query }: { text: string; query: string }) {
  const c = useColors()
  if (!query || query.length < 2) {
    return <>{text}</>
  }

  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"))

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <T
            key={i}
            step="sm"
            color={c.tint.i.tx}
            style={{ backgroundColor: c.tint.i.bg, borderRadius: 3 }}
          >
            {part}
          </T>
        ) : (
          <T key={i} step="sm" tone="inherit">
            {part}
          </T>
        ),
      )}
    </>
  )
}
