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
 * - Theme-aware (light/dark) via useColors() + semantic tokens
 */

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Lock,
  MessageCircle,
  MoreVertical,
  Plus,
  Search,
  User,
  X,
} from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, Circle, Dialog, Input, Paragraph, Popover, Text, View, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { getDateLocale } from '../../i18n';
import { NewConversationModal } from '../../components/NewConversationModal';
import { TerosLoading } from '../../components/TerosLoading';
import { useChatStore } from '../../store/chatStore';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import type { ConversationsWindowProps } from './definition';
import { AppSpinner } from '../../components/ui';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors } from '../../components/mca/primitives/colors';

// Semantic accents — theme-agnostic (same hex in light and dark)
const INDIGO = semanticColors.indigo;
const INDIGO_HOVER = semanticColors.indigoLight;
const INDIGO_BG = semanticColors.indigoGlow;
const RED = semanticColors.red;
const GREEN = semanticColors.green;
const AMBER = semanticColors.amber;

interface Conversation {
  channelId: string;
  title: string;
  agentId?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  lastMessageAt?: string | null;
  lastMessageContent?: string;
  status?: 'active' | 'closed';
  unreadCount?: number;
  /** An external action has been requested (to a human or another agent) */
  externalActionRequested?: boolean;
  /** Private conversation (hidden from searches, deleted on archive) */
  isPrivate?: boolean;
  /** Transport type: 'web' | 'voice' */
  transport?: string;
  /** If set, this is a sub-conversation delegated from the given parent channel */
  originChannelId?: string;
}

interface SearchMatch {
  messageId: string;
  snippet: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
}

interface SearchResultChannel {
  channelId: string;
  channelName: string;
  agentId: string;
  agentName: string;
  matches: SearchMatch[];
}

export function ConversationsWindowContent({
  windowId,
  workspaceId,
  filter = 'active',
}: ConversationsWindowProps & { windowId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [pendingArchiveChannelId, setPendingArchiveChannelId] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultChannel[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [totalMatches, setTotalMatches] = useState(0);

  const client = getTerosClient();
  const { openWindow, findWindow, focusWindow } = useTilingStore();
  // Always use the active workspace from the store — no prop, no fallback.
  // This is a platform-wide rule: conversations are always scoped to the active workspace.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // Connection status
  useEffect(() => {
    const handleConnected = () => setConnected(true);
    const handleDisconnected = () => setConnected(false);

    client.on('connected', handleConnected);
    client.on('disconnected', handleDisconnected);
    setConnected(client.isConnected());

    return () => {
      client.off('connected', handleConnected);
      client.off('disconnected', handleDisconnected);
    };
  }, []);

  // Load data when connected
  useEffect(() => {
    if (!connected) return;
    loadConversations();
  }, [connected]);

  // Debounced search
  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([]);
      setTotalMatches(0);
      setSearchPending(false);
      return;
    }

    setSearchPending(true);

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const result = await (client as any).searchConversations(searchQuery);
        setSearchResults(result.results);
        setTotalMatches(result.totalMatches);
      } catch (err) {
        console.error('[ConversationsWindow] Search error:', err);
        setSearchResults([]);
        setTotalMatches(0);
      } finally {
        setIsSearching(false);
        setSearchPending(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery, connected]);

  // Listen for channel list updates in real-time
  useEffect(() => {
    if (!connected) return;

    const handleChannelListStatus = (data: any) => {
      const { channelId, action, channel } = data;

      if (action === 'created') {
        // Skip sub-conversations and headless channels
        if (channel?.originChannelId || channel?.headless) return;

        const newConv: Conversation = {
          channelId,
          title: channel?.title || t('conversation.newChat'),
          agentId: channel?.agentId,
          agentName: channel?.agentName,
          agentAvatarUrl: channel?.agentAvatarUrl,
          lastMessageAt: channel?.createdAt || new Date().toISOString(),
          status: channel?.status || 'active',
          unreadCount: 0,
          originChannelId: channel?.originChannelId,
        };

        setConversations((prev) => {
          if (prev.some((c2) => c2.channelId === channelId)) return prev;
          return [newConv, ...prev];
        });
      } else if (action === 'deleted') {
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.channelId === channelId) {
              return { ...conv, status: 'closed' };
            }
            return conv;
          }),
        );
      } else if (action === 'updated') {
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
              };
            }
            return conv;
          }),
        );
      }
    };

    client.on('channel_list_status', handleChannelListStatus);

    return () => {
      client.off('channel_list_status', handleChannelListStatus);
    };
  }, [connected]);

  const mapChannelToConversation = (ch: any, agentList: any[]): Conversation => {
    const agent = agentList.find((a: any) => a.agentId === ch.agentId);
    return {
      channelId: ch.channelId,
      title: ch.metadata?.name || t('nav.chat'),
      agentId: ch.agentId,
      agentName: ch.agentName || agent?.name || agent?.fullName,
      agentAvatarUrl: ch.agentAvatarUrl || agent?.avatarUrl,
      lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
      lastMessageContent: ch.lastMessage?.content || '',
      status: ch.status || 'active',
      unreadCount: ch.unreadCount || 0,
      isPrivate: ch.isPrivate || false,
      transport: ch.metadata?.transport || 'web',
      originChannelId: ch.originChannelId,
    };
  };

  const loadConversations = async () => {
    setIsLoading(true);
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, { agents: agentList }] =
        await Promise.all([
          client.channel.list(activeWorkspaceId ?? undefined),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ]);

      const convs: Conversation[] = channels
        .filter((ch: any) => !ch.headless && !ch.originChannelId)
        .map((ch: any) => mapChannelToConversation(ch, agentList));

      setConversations(convs);
      setNextCursor(cursor ?? null);
      setHasMore(more ?? false);
    } catch (err) {
      console.error('[ConversationsWindow] Error loading conversations:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore || !nextCursor) return;
    setIsLoadingMore(true);
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, { agents: agentList }] =
        await Promise.all([
          client.channel.list(activeWorkspaceId ?? undefined, undefined, 30, nextCursor),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ]);

      const newConvs: Conversation[] = channels
        .filter((ch: any) => !ch.headless && !ch.originChannelId)
        .map((ch: any) => mapChannelToConversation(ch, agentList));

      setConversations((prev) => {
        const existingIds = new Set(prev.map((c2) => c2.channelId));
        const unique = newConvs.filter((c2) => !existingIds.has(c2.channelId));
        return [...prev, ...unique];
      });
      setNextCursor(cursor ?? null);
      setHasMore(more ?? false);
    } catch (err) {
      console.error('[ConversationsWindow] Error loading more conversations:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore, nextCursor, activeWorkspaceId]);

  const handleSelectConversation = async (conv: Conversation) => {
    if (conv.unreadCount && conv.unreadCount > 0) {
      try {
        await client.channel.markRead(conv.channelId);
        setConversations((prev) =>
          prev.map((c2) => (c2.channelId === conv.channelId ? { ...c2, unreadCount: 0 } : c2)),
        );
      } catch (err) {
        console.error('Error marking channel as read:', err);
      }
    }

    const existingWindow = findWindow('chat', (props) => props.channelId === conv.channelId);
    if (existingWindow) {
      focusWindow(existingWindow.id);
    } else {
      openWindow('chat', {
        channelId: conv.channelId,
        agentId: conv.agentId,
        agentName: conv.agentName,
        workspaceId: activeWorkspaceId,
      }, false, windowId);
    }
  };

  const handleNewConversation = () => {
    setShowNewConversationModal(true);
  };

  const handleSelectAgent = (agent: { agentId: string; name: string; fullName: string }) => {
    setShowNewConversationModal(false);
    openWindow('chat', {
      agentId: agent.agentId,
      agentName: agent.name || agent.fullName,
      workspaceId: activeWorkspaceId,
    }, false, windowId);
  };

  const handleArchiveConversation = (channelId: string) => {
    setPendingArchiveChannelId(channelId);
    setShowArchiveConfirm(true);
  };

  const confirmArchiveConversation = async () => {
    if (!pendingArchiveChannelId) return;
    try {
      await client.channel.close(pendingArchiveChannelId);
      setConversations((prev) =>
        prev.map((c2) => (c2.channelId === pendingArchiveChannelId ? { ...c2, status: 'closed' as const } : c2)),
      );
    } catch (err) {
      console.error('Error archiving conversation:', err);
    } finally {
      setShowArchiveConfirm(false);
      setPendingArchiveChannelId(null);
    }
  };

  const handleRestoreConversation = async (channelId: string) => {
    try {
      await client.channel.reopen(channelId);
      setConversations((prev) =>
        prev.map((c2) => (c2.channelId === channelId ? { ...c2, status: 'active' as const } : c2)),
      );
    } catch (err) {
      console.error('Error restoring conversation:', err);
    }
  };

  const handleMarkAsRead = async (channelId: string) => {
    try {
      await client.channel.markRead(channelId);
      setConversations((prev) =>
        prev.map((c2) => (c2.channelId === channelId ? { ...c2, unreadCount: 0 } : c2)),
      );
    } catch (err) {
      console.error('Error marking as read:', err);
    }
  };

  const handleSearchResultClick = (channelId: string, messageId: string, agentName?: string) => {
    setSearchQuery('');
    setSearchResults([]);

    const existingWindow = findWindow('chat', (props) => props.channelId === channelId);

    if (existingWindow) {
      focusWindow(existingWindow.id);
    } else {
      openWindow('chat', {
        channelId,
        agentName,
        workspaceId: activeWorkspaceId,
      }, false, windowId);
    }
  };

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('conversation.now');
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short' });
  };

  // All non-archived conversations in a single flat list (no inactive section)
  const activeConvs = conversations.filter((conv) => conv.status !== 'closed');
  const archivedConvs = conversations.filter((conv) => conv.status === 'closed');

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header with actions */}
      <XStack
        height={40}
        paddingHorizontal={8}
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <Text fontSize={11} fontWeight="600" color={c.text2}>
          {t('conversation.chats')}
        </Text>

        <View
          accessibilityLabel={t('conversations.newConversationTooltip')}
          {...(Platform.OS === 'web' ? { title: t('conversations.newConversationTooltip') } as any : {})}
        >
          <Button
            size="$1"
            width={22}
            height={22}
            padding={0}
            borderRadius={4}
            backgroundColor={INDIGO}
            hoverStyle={{ backgroundColor: INDIGO_HOVER }}
            onPress={handleNewConversation}
            icon={<Plus size={14} color="white" />}
          />
        </View>
      </XStack>

      {/* Search bar */}
      <XStack
        paddingHorizontal={8}
        paddingVertical={6}
        borderBottomWidth={1}
        borderBottomColor={c.border}
        alignItems="center"
        gap={6}
      >
        <Search size={14} color={c.text3} />
        <Input
          flex={1}
          size="$2"
          placeholder={t('conversations.searchPlaceholder')}
          placeholderTextColor={c.text3}
          backgroundColor="transparent"
          borderWidth={0}
          borderColor="transparent"
          outlineWidth={0}
          outlineColor="transparent"
          color={c.text}
          fontSize={12}
          paddingHorizontal={0}
          paddingVertical={0}
          value={searchQuery}
          onChangeText={setSearchQuery}
          focusStyle={{ borderWidth: 0, borderColor: 'transparent', outlineWidth: 0 }}
          hoverStyle={{ borderWidth: 0, borderColor: 'transparent' }}
        />
        {searchQuery.length > 0 && (
          <XStack
            width={20}
            height={20}
            justifyContent="center"
            alignItems="center"
            borderRadius={10}
            cursor="pointer"
            hoverStyle={{ backgroundColor: c.bgCardHover }}
            onPress={() => setSearchQuery('')}
          >
            <X size={12} color={c.text3} />
          </XStack>
        )}
      </XStack>

      {/* List */}
      {isLoading ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <AppSpinner variant="brand" />
        </YStack>
      ) : searchQuery.length >= 2 ? (
        /* Search Results */
        <ScrollView style={{ flex: 1 }}>
          <YStack padding={4} gap={1}>
            {isSearching || searchPending ? (
              <YStack padding={16} alignItems="center" gap={8}>
                <AppSpinner size="sm" variant="brand" />
                <Text fontSize={11} color={c.text3}>
                  {t('conversations.searching')}
                </Text>
              </YStack>
            ) : searchResults.length === 0 ? (
              <YStack padding={16} alignItems="center">
                <Text fontSize={12} color={c.text3}>
                  {t('conversations.noResultsFor', { query: searchQuery })}
                </Text>
              </YStack>
            ) : (
              <>
                {/* Results count */}
                <XStack padding={8}>
                  <Text fontSize={10} color={c.text3}>
                    {t('conversations.searchResultsSummary', { matches: totalMatches, channels: searchResults.length })}
                  </Text>
                </XStack>

                {/* Results grouped by channel */}
                {searchResults.map((channel) => (
                  <YStack key={channel.channelId} marginBottom={8}>
                    {/* Channel header */}
                    <XStack
                      padding={8}
                      gap={8}
                      alignItems="center"
                      backgroundColor={c.bgCard}
                      borderRadius={4}
                    >
                      <Circle size={24} backgroundColor={c.bgInner}>
                        <User size={12} color={c.text3} />
                      </Circle>
                      <YStack flex={1}>
                        <Text fontSize={11} fontWeight="600" color={INDIGO}>
                          {channel.agentName}
                        </Text>
                        <Text fontSize={10} color={c.text3}>
                          {channel.channelName}
                        </Text>
                      </YStack>
                      <Text fontSize={9} color={c.text3}>
                        {t('conversations.matchCount', { count: channel.matches.length })}
                      </Text>
                    </XStack>

                    {/* Matches in this channel */}
                    {channel.matches.map((match) => (
                      <XStack
                        key={match.messageId}
                        padding={8}
                        paddingLeft={40}
                        gap={8}
                        alignItems="flex-start"
                        cursor="pointer"
                        hoverStyle={{ backgroundColor: c.bgCardHover }}
                        pressStyle={{ backgroundColor: c.bgCard }}
                        onPress={() =>
                          handleSearchResultClick(
                            channel.channelId,
                            match.messageId,
                            channel.agentName,
                          )
                        }
                      >
                        <YStack flex={1} gap={2}>
                          <XStack gap={6} alignItems="center">
                            <Text
                              fontSize={9}
                              color={match.role === 'user' ? c.text2 : INDIGO}
                              fontWeight="500"
                            >
                              {match.role === 'user' ? t('conversations.you') : channel.agentName}
                            </Text>
                            <Text fontSize={9} color={c.text3}>
                              {formatDate(match.timestamp)}
                            </Text>
                          </XStack>
                          <Text fontSize={11} color={c.text2} numberOfLines={2}>
                            <HighlightedText text={match.snippet} query={searchQuery} highlightColor={INDIGO} />
                          </Text>
                        </YStack>
                      </XStack>
                    ))}
                  </YStack>
                ))}
              </>
            )}
          </YStack>
        </ScrollView>
      ) : activeConvs.length === 0 ? (
        /* Empty state */
        <YStack flex={1} justifyContent="center" alignItems="center" gap="$3" padding={24}>
          <MessageCircle size={48} color={c.text3} />
          <Text fontSize={13} color={c.text3} textAlign="center">
            {t('conversations.empty')}
          </Text>
          <Button
            size="$2"
            backgroundColor={INDIGO_BG}
            color={INDIGO}
            onPress={handleNewConversation}
            icon={<Plus size={14} color={INDIGO} />}
          >
            {t('conversation.newChat')}
          </Button>
        </YStack>
      ) : (
        /* Normal conversation list — all active conversations in a single flat list */
        <ScrollView style={{ flex: 1 }}>
          <YStack padding={4} gap={1}>
            {activeConvs.map((conv) => (
              <ConversationItem
                key={conv.channelId}
                conv={conv}
                formatDate={formatDate}
                onSelect={handleSelectConversation}
                onArchive={handleArchiveConversation}
                onMarkAsRead={handleMarkAsRead}
              />
            ))}

            {/* Archived section - link to dedicated window */}
            {archivedConvs.length > 0 && (
              <XStack
                marginTop={12}
                padding={10}
                gap={8}
                alignItems="center"
                borderRadius={6}
                borderWidth={1}
                borderColor={c.border}
                backgroundColor={c.bgInner}
                cursor="pointer"
                hoverStyle={{ backgroundColor: c.bgCardHover, borderColor: c.borderStrong }}
                onPress={() => openWindow('archived-conversations', {}, false, windowId)}
              >
                <Archive size={14} color={c.text3} />
                <Text fontSize={11} color={c.text2} flex={1}>
                  {t('conversation.archived')}
                </Text>
                <Text fontSize={11} color={c.text3}>
                  {archivedConvs.length}
                </Text>
                <ChevronDown size={12} color={c.text3} style={{ transform: [{ rotate: '-90deg' }] }} />
              </XStack>
            )}

            {/* Load more button */}
            {hasMore && (
              <XStack
                marginTop={8}
                padding={10}
                justifyContent="center"
                alignItems="center"
                gap={6}
                borderRadius={6}
                cursor={isLoadingMore ? 'default' : 'pointer'}
                opacity={isLoadingMore ? 0.5 : 1}
                hoverStyle={isLoadingMore ? {} : { backgroundColor: c.bgCardHover }}
                onPress={loadMore}
              >
                {isLoadingMore ? (
                  <AppSpinner size="sm" variant="brand" />
                ) : (
                  <Text fontSize={11} color={INDIGO}>
                    {t('conversations.loadMoreConversations')}
                  </Text>
                )}
              </XStack>
            )}
          </YStack>
        </ScrollView>
      )}

      {/* New Conversation Modal */}
      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgent}
      />

      {/* Archive Confirmation Dialog */}
      <Dialog modal open={showArchiveConfirm} onOpenChange={(o) => {
        if (!o) {
          setShowArchiveConfirm(false);
          setPendingArchiveChannelId(null);
        }
      }}>
        <Dialog.Portal>
          <Dialog.Overlay
            key="overlay"
            animation="card"
            opacity={0.5}
            enterStyle={{ opacity: 0 }}
            exitStyle={{ opacity: 0 }}
          />
          <Dialog.Content
            key="content"
            bordered
            elevate
            animation="card"
            enterStyle={{ opacity: 0, scale: 0.96 }}
            exitStyle={{ opacity: 0, scale: 0.96 }}
            transformOrigin="top"
            width={420}
            padding="$5"
            gap="$4"
          >
            <Dialog.Title fontWeight="600" fontSize="$6">
              {t('conversations.archiveConfirmTitle')}
            </Dialog.Title>
            <Paragraph fontSize="$3" lineHeight="$2" color="$gray10">
              {t('conversations.archiveConfirmBody')}
            </Paragraph>
            <XStack gap="$3" justifyContent="flex-end">
              <Dialog.Close asChild>
                <Button size="$3" onPress={() => {
                  setShowArchiveConfirm(false);
                  setPendingArchiveChannelId(null);
                }}>
                  {t('conversations.archiveCancel')}
                </Button>
              </Dialog.Close>
              <Button
                size="$3"
                theme="orange"
                onPress={confirmArchiveConversation}
              >
                {t('conversations.archiveConfirm')}
              </Button>
            </XStack>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </YStack>
  );
}

// ========================================
// CONVERSATION ITEM
// ========================================

function ConversationItem({
  conv,
  formatDate,
  onSelect,
  onArchive,
  onRestore,
  onMarkAsRead,
  archived = false,
}: {
  conv: Conversation;
  formatDate: (date: string | null | undefined) => string;
  onSelect: (conv: Conversation) => void;
  onArchive?: (channelId: string) => void;
  onRestore?: (channelId: string) => void;
  onMarkAsRead?: (channelId: string) => void;
  archived?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const channel = useChatStore((state) => state.channels[conv.channelId]);
  const isTyping = channel?.isTyping ?? false;

  const hasUnread = (conv.unreadCount ?? 0) > 0;
  const externalActionRequested =
    conv.externalActionRequested ?? channel?.externalActionRequested ?? false;
  const isPrivate = conv.isPrivate ?? channel?.isPrivate ?? false;

  return (
    <XStack
      padding={8}
      gap={8}
      alignItems="center"
      borderRadius={6}
      cursor="pointer"
      backgroundColor="transparent"
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      pressStyle={{ backgroundColor: c.bgCard }}
      onPress={() => onSelect(conv)}
    >
      {/* Avatar */}
      <Circle size={32} backgroundColor={c.bgInner} overflow="hidden">
        {conv.agentAvatarUrl ? (
          <Avatar circular size={32}>
            <Avatar.Image src={conv.agentAvatarUrl} />
          </Avatar>
        ) : (
          <User size={16} color={c.text3} />
        )}
      </Circle>

      {/* Content */}
      <YStack flex={1} gap={2}>
        {/* Conversation title — first, it's what identifies the conversation */}
        <Text fontSize={12} fontWeight="400" color={archived ? c.text3 : c.text} numberOfLines={1}>
          {conv.title}
        </Text>

        {/* Agent name + preview on one line: name is fixed-width, preview truncates */}
        <XStack alignItems="center" gap={4}>
          <Text
            fontSize={10}
            fontWeight="500"
            color={archived ? c.text3 : INDIGO}
            numberOfLines={1}
            flexShrink={0}
          >
            {conv.agentName || t('conversation.agent')}
          </Text>
          {conv.lastMessageContent && !archived && (
            <Text fontSize={10} color={c.text3} numberOfLines={1} ellipsizeMode="tail" flex={1} flexShrink={1}>
              {' · '}{conv.lastMessageContent}
            </Text>
          )}
        </XStack>

        {/* Time */}
        {!archived && (
          <Text fontSize={9} color={c.text3}>
            {formatDate(conv.lastMessageAt)}
          </Text>
        )}
      </YStack>

      {/* Status indicators */}
      <XStack gap={6} alignItems="center">
        {isPrivate && <Lock size={12} color={c.text3} />}
        {isTyping && <TerosLoading size={14} color={INDIGO} />}
        {!isTyping && externalActionRequested && <Circle size={8} backgroundColor={RED} />}
        {!isTyping && !externalActionRequested && hasUnread && (
          <Circle
            size={8}
            backgroundColor={INDIGO}
            cursor="pointer"
            hoverStyle={{ scale: 1.2 }}
            onPress={(e: any) => {
              e.stopPropagation();
              onMarkAsRead?.(conv.channelId);
            }}
          />
        )}
      </XStack>

      {/* Restore button for archived */}
      {archived && onRestore && (
        <XStack
          width={24}
          height={24}
          justifyContent="center"
          alignItems="center"
          borderRadius={4}
          cursor="pointer"
          hoverStyle={{ backgroundColor: `rgba(${34}, ${197}, ${94}, 0.15)` }}
          onPress={(e: any) => {
            e.stopPropagation();
            onRestore(conv.channelId);
          }}
        >
          <ArchiveRestore size={14} color={GREEN} />
        </XStack>
      )}

      {/* Menu for active conversations */}
      {!archived && onArchive && (
        <Popover placement="bottom-end">
          <Popover.Trigger asChild>
            <XStack
              width={24}
              height={24}
              justifyContent="center"
              alignItems="center"
              borderRadius={4}
              cursor="pointer"
              opacity={0.5}
              hoverStyle={{ backgroundColor: c.bgCard, opacity: 1 }}
              onPress={(e: any) => e.stopPropagation()}
            >
              <MoreVertical size={14} color={c.text3} />
            </XStack>
          </Popover.Trigger>

          <Popover.Content
            backgroundColor={c.bgCard}
            borderWidth={1}
            borderColor={c.borderStrong}
            borderRadius={8}
            padding={4}
            elevate
            animation="quick"
            enterStyle={{ opacity: 0, y: -4 }}
            exitStyle={{ opacity: 0, y: -4 }}
          >
            <XStack
              paddingHorizontal={10}
              paddingVertical={8}
              gap={8}
              alignItems="center"
              borderRadius={4}
              cursor="pointer"
              hoverStyle={{ backgroundColor: `rgba(${245}, ${158}, ${11}, 0.15)` }}
              onPress={(e: any) => {
                e.stopPropagation();
                onArchive(conv.channelId);
              }}
            >
              <Archive size={14} color={AMBER} />
              <Text fontSize={12} color={c.text}>
                {t('conversations.archive')}
              </Text>
            </XStack>
          </Popover.Content>
        </Popover>
      )}
    </XStack>
  );
}

// ========================================
// HIGHLIGHTED TEXT (for search results)
// ========================================

function HighlightedText({ text, query, highlightColor }: { text: string; query: string; highlightColor: string }) {
  if (!query || query.length < 2) {
    return <>{text}</>;
  }

  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <Text key={i} color={highlightColor} fontWeight="600">
            {part}
          </Text>
        ) : (
          <Text key={i}>{part}</Text>
        ),
      )}
    </>
  );
}
