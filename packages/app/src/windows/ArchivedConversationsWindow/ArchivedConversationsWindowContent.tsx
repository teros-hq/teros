/**
 * ArchivedConversationsWindowContent - Dedicated window for archived conversations
 *
 * Features:
 * - Search within archived conversations
 * - Restore conversations
 * - Open archived conversation (read-only or restore on first message)
 *
 * Look: the OS prototype's conversations page in its "Archivadas" state —
 * eyebrow + serif headline, a search Field and an LGroup of rows (muted
 * Avatar ring, title, "Agente · preview", date) with a restore IconBtn.
 */

import React, { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { getDateLocale } from "../../i18n"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import type { ArchivedConversationsWindowProps } from "./definition"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Btn,
  EmptyState,
  Field,
  IconBtn,
  LGroup,
  LRow,
  Page,
  PageHead,
  SectionLabel,
  T,
} from "../../components/ui/ds"

interface ArchivedConversation {
  channelId: string
  title: string
  agentId?: string
  agentName?: string
  agentAvatarUrl?: string
  lastMessageAt?: string | null
  lastMessageContent?: string
}

export function ArchivedConversationsWindowContent({
  windowId,
  workspaceId,
  searchQuery: initialSearchQuery = "",
}: ArchivedConversationsWindowProps & { windowId: string }) {
  const { t } = useTranslation()
  const [conversations, setConversations] = useState<ArchivedConversation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [connected, setConnected] = useState(false)
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery)

  const client = getTerosClient()
  const { openWindow, findWindow, focusWindow } = useTilingStore()
  // Always use the active workspace from the store — no prop, no fallback.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const c = useColors()

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
    loadData()
  }, [connected])

  const mapChannelToArchived = (ch: any, agentList: any[]): ArchivedConversation => {
    const agent = agentList.find((a: any) => a.agentId === ch.agentId)
    return {
      channelId: ch.channelId,
      title: ch.metadata?.name || t("chat.fallbackTitle"),
      agentId: ch.agentId,
      agentName: ch.agentName || agent?.name || agent?.fullName,
      agentAvatarUrl: ch.agentAvatarUrl || agent?.avatarUrl,
      lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
      lastMessageContent: ch.lastMessage?.content || "",
    }
  }

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, { agents: agentList }] =
        await Promise.all([
          client.channel.list(activeWorkspaceId ?? undefined, "closed"),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ])

      const archived: ArchivedConversation[] = channels.map((ch: any) =>
        mapChannelToArchived(ch, agentList),
      )

      setConversations(archived)
      setNextCursor(cursor ?? null)
      setHasMore(more ?? false)
    } catch (err) {
      console.error("[ArchivedConversationsWindow] Error loading data:", err)
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
          client.channel.list(activeWorkspaceId ?? undefined, "closed", 30, nextCursor),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ])

      const newArchived: ArchivedConversation[] = channels.map((ch: any) =>
        mapChannelToArchived(ch, agentList),
      )

      setConversations((prev) => {
        const existingIds = new Set(prev.map((c) => c.channelId))
        const unique = newArchived.filter((c) => !existingIds.has(c.channelId))
        return [...prev, ...unique]
      })
      setNextCursor(cursor ?? null)
      setHasMore(more ?? false)
    } catch (err) {
      console.error("[ArchivedConversationsWindow] Error loading more:", err)
    } finally {
      setIsLoadingMore(false)
    }
  }, [isLoadingMore, hasMore, nextCursor])

  const handleSelectConversation = (conv: ArchivedConversation) => {
    const existingWindow = findWindow("chat", (props) => props.channelId === conv.channelId)

    if (existingWindow) {
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

  const handleRestoreConversation = async (channelId: string) => {
    try {
      await client.channel.reopen(channelId)
      setConversations((prev) => prev.filter((c) => c.channelId !== channelId))
    } catch (err) {
      console.error("Error restoring conversation:", err)
    }
  }

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return ""
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffDays < 1) return t("archivedConversations.today")
    if (diffDays < 2) return t("archivedConversations.yesterday")
    if (diffDays < 7) return t("archivedConversations.daysAgo", { count: diffDays })
    if (diffDays < 30)
      return t("archivedConversations.weeksAgo", { count: Math.floor(diffDays / 7) })
    return date.toLocaleDateString(getDateLocale(), { day: "numeric", month: "short" })
  }

  // Filter by search
  const filteredConvs =
    searchQuery.length >= 2
      ? conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            c.agentName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            c.lastMessageContent?.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : conversations

  const restoreLabel = t("archivedConversations.restore", { defaultValue: "Restaurar" })

  return (
    <Page>
      <PageHead
        eyebrow={t("windows.archivedConversations")}
        title={t("archivedConversations.headline", { defaultValue: "Lo que ya cerrasteis." })}
        accent={t("archivedConversations.headlineAccent", { defaultValue: "cerrasteis." })}
        lead={t("archivedConversations.lead", {
          defaultValue:
            "Las conversaciones archivadas no desaparecen: ábrelas para leerlas o restáuralas para seguir hablando.",
        })}
      />

      {/* Search bar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <Field
          icon="magnifying-glass"
          placeholder={t("archivedConversations.searchPlaceholder")}
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
      </View>

      {/* List */}
      {isLoading ? (
        <View style={{ alignItems: "center", paddingVertical: 48 }}>
          <AppSpinner variant="brand" />
        </View>
      ) : filteredConvs.length === 0 ? (
        <LGroup>
          <EmptyState
            icon="archive"
            title={
              searchQuery.length >= 2
                ? t("archivedConversations.noResults", { query: searchQuery })
                : t("archivedConversations.empty")
            }
          />
        </LGroup>
      ) : (
        <View style={{ gap: 16 }}>
          {/* Count */}
          <SectionLabel
            label={t("archivedConversations.count", { count: filteredConvs.length })}
            dot={false}
            style={{ marginTop: 0 }}
          />

          {/* When searching we show filtered results (client-side); show load-more only when not searching */}
          <View testID="archived-conversations-list">
            <LGroup>
              {filteredConvs.map((conv) => (
                <LRow
                  key={conv.channelId}
                  onPress={() => handleSelectConversation(conv)}
                  padV={12}
                  padH={12}
                  gap={14}
                  testID={`archived-conversation-${conv.channelId}`}
                >
                  {/* Avatar */}
                  <Avatar
                    name={conv.agentName || t("chat.fallbackAgentName")}
                    imageUrl={conv.agentAvatarUrl}
                    size={36}
                    isAgent
                    status="idle"
                  />

                  {/* Content */}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T step="base" tone="text2" ellipsis>
                      {conv.title}
                    </T>
                    <T step="sm" tone="text3" ellipsis style={{ marginTop: 2 }}>
                      <T step="sm" tone="text2">
                        {conv.agentName || t("chat.fallbackAgentName")}
                      </T>
                      {conv.lastMessageContent ? ` · ${conv.lastMessageContent}` : ""}
                    </T>
                  </View>

                  <T step="codenote" tone="text3">
                    {formatDate(conv.lastMessageAt)}
                  </T>

                  {/* Restore button */}
                  <IconBtn
                    icon="arrow-counter-clockwise"
                    plain
                    sm
                    title={restoreLabel}
                    accessibilityLabel={restoreLabel}
                    onPress={(e: any) => {
                      e?.stopPropagation?.()
                      handleRestoreConversation(conv.channelId)
                    }}
                    testID={`restore-${conv.channelId}`}
                  />
                </LRow>
              ))}
            </LGroup>
          </View>

          {/* Load more button — only when not filtering by search */}
          {searchQuery.length < 2 && hasMore && (
            <View style={{ flexDirection: "row", justifyContent: "center" }}>
              <Btn
                variant="sec"
                loading={isLoadingMore}
                onPress={loadMore}
                testID="archived-load-more"
              >
                {t("archivedConversations.loadMore")}
              </Btn>
            </View>
          )}
        </View>
      )}
      <View style={{ height: 1, backgroundColor: c.bgSheet }} />
    </Page>
  )
}
