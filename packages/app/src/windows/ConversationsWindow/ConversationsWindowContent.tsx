/**
 * ConversationsWindowContent - Lista de conversaciones como ventana del workspace
 *
 * Features:
 * - Lista de conversaciones activas, inactivas y archivadas
 * - Create new conversation with agent selector
 * - Archive/restore conversations
 * - Mark as read
 * - Real-time updates for unread messages
 */

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Lock,
  MoreVertical,
  Plus,
  Search,
  User,
  X,
} from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { Avatar, Button, Circle, Input, Popover, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { NewConversationModal } from '../../components/NewConversationModal';
import { TerosLoading } from '../../components/TerosLoading';
import { useChatStore } from '../../store/chatStore';
import { useTilingStore } from '../../store/tilingStore';
import type { ConversationsWindowProps } from './definition';
import { AppSpinner } from '../../components/ui';

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

// Limits for collapsed view
const MAX_VISIBLE_ACTIVE = 8;
const MAX_VISIBLE_INACTIVE = 3;

export function ConversationsWindowContent({
  windowId,
  filter = 'active',
}: ConversationsWindowProps & { windowId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);
  const [showAllActive, setShowAllActive] = useState(false);
  const [showAllInactive, setShowAllInactive] = useState(false);

  // Legacy state for backwards compatibility (filter prop)
  const [showArchived, setShowArchived] = useState(filter === 'archived' || filter === 'all');
  const [showInactive, setShowInactive] = useState(filter === 'inactive' || filter === 'all');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultChannel[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchPending, setSearchPending] = useState(false); // True while waiting for debounce or request
  const [totalMatches, setTotalMatches] = useState(0);

  const client = getTerosClient();
  const { openWindow, findWindow, focusWindow } = useTilingStore();

  // Helper: check if conversation is inactive (no messages in last 3 hours)
  const isInactive = (conv: Conversation) => {
    if (conv.status === 'closed') return false;
    const lastActivity = conv.lastMessageAt;
    if (!lastActivity) return true;
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    return new Date(lastActivity).getTime() < threeHoursAgo;
  };

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

    // Mark as pending immediately when query changes
    setSearchPending(true);

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const result = await client.searchConversations(searchQuery);
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
      console.log('[ConversationsWindow] channel_list_status:', action, channelId);

      if (action === 'created') {
        const newConv: Conversation = {
          channelId,
          title: channel?.title || 'Nuevo chat',
          agentId: channel?.agentId,
          agentName: channel?.agentName,
          agentAvatarUrl: channel?.agentAvatarUrl,
          lastMessageAt: channel?.createdAt || new Date().toISOString(),
          status: channel?.status || 'active',
          unreadCount: 0,
        };

        setConversations((prev) => {
          // Check if already exists (avoid duplicates)
          if (prev.some((c) => c.channelId === channelId)) {
            return prev;
          }
          return [newConv, ...prev];
        });
      } else if (action === 'deleted') {
        // Move to archived or remove from active list
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.channelId === channelId) {
              return { ...conv, status: 'closed' };
            }
            return conv;
          }),
        );
      } else if (action === 'updated') {
        // Update existing conversation
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
      title: ch.metadata?.name || 'Chat',
      agentId: ch.agentId,
      agentName: ch.agentName || agent?.name || agent?.fullName,
      agentAvatarUrl: ch.agentAvatarUrl || agent?.avatarUrl,
      lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
      lastMessageContent: ch.lastMessage?.content || '',
      status: ch.status || 'active',
      unreadCount: ch.unreadCount || 0,
      isPrivate: ch.isPrivate || false,
      transport: ch.metadata?.transport || 'web',
    };
  };

  const loadConversations = async () => {
    setIsLoading(true);
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, { agents: agentList }] =
        await Promise.all([client.channel.list(), client.agent.listAgents()]);

      const convs: Conversation[] = channels
        .filter((ch: any) => !ch.headless)
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
        await Promise.all([client.channel.list(undefined, undefined, 30, nextCursor), client.agent.listAgents()]);

      const newConvs: Conversation[] = channels
        .filter((ch: any) => !ch.headless)
        .map((ch: any) => mapChannelToConversation(ch, agentList));

      setConversations((prev) => {
        const existingIds = new Set(prev.map((c) => c.channelId));
        const unique = newConvs.filter((c) => !existingIds.has(c.channelId));
        return [...prev, ...unique];
      });
      setNextCursor(cursor ?? null);
      setHasMore(more ?? false);
    } catch (err) {
      console.error('[ConversationsWindow] Error loading more conversations:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore, nextCursor]);

  const handleSelectConversation = async (conv: Conversation) => {
    // Mark as read if there are unread messages
    if (conv.unreadCount && conv.unreadCount > 0) {
      try {
        await client.channel.markRead(conv.channelId);
        setConversations((prev) =>
          prev.map((c) => (c.channelId === conv.channelId ? { ...c, unreadCount: 0 } : c)),
        );
      } catch (err) {
        console.error('Error marking channel as read:', err);
      }
    }

    const isVoice = conv.transport === 'voice';

    if (isVoice) {
      // Voice channels open as chat windows but with transport flag so they show VoiceTranscriptView
      const existingWindow = findWindow('chat', (props) => props.channelId === conv.channelId);
      if (existingWindow) {
        focusWindow(existingWindow.id);
      } else {
        openWindow('chat', {
          channelId: conv.channelId,
          agentId: conv.agentId,
          agentName: conv.agentName,
          transport: 'voice',
        }, false, windowId);
      }
    } else {
      const existingWindow = findWindow('chat', (props) => props.channelId === conv.channelId);
      if (existingWindow) {
        focusWindow(existingWindow.id);
      } else {
        openWindow('chat', {
          channelId: conv.channelId,
          agentId: conv.agentId,
          agentName: conv.agentName,
        }, false, windowId);
      }
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
    }, false, windowId);
  };

  const handleArchiveConversation = async (channelId: string) => {
    try {
      await client.channel.close(channelId);
      setConversations((prev) =>
        prev.map((c) => (c.channelId === channelId ? { ...c, status: 'closed' as const } : c)),
      );
    } catch (err) {
      console.error('Error archiving conversation:', err);
    }
  };

  const handleRestoreConversation = async (channelId: string) => {
    try {
      await client.channel.reopen(channelId);
      setConversations((prev) =>
        prev.map((c) => (c.channelId === channelId ? { ...c, status: 'active' as const } : c)),
      );
    } catch (err) {
      console.error('Error restoring conversation:', err);
    }
  };

  const handleMarkAsRead = async (channelId: string) => {
    try {
      await client.channel.markRead(channelId);
      setConversations((prev) =>
        prev.map((c) => (c.channelId === channelId ? { ...c, unreadCount: 0 } : c)),
      );
    } catch (err) {
      console.error('Error marking as read:', err);
    }
  };

  const handleSearchResultClick = (channelId: string, messageId: string, agentName?: string) => {
    // Clear search
    setSearchQuery('');
    setSearchResults([]);

    const existingWindow = findWindow('chat', (props) => props.channelId === channelId);

    if (existingWindow) {
      focusWindow(existingWindow.id);
      // TODO: scroll to messageId
    } else {
      openWindow('chat', {
        channelId,
        agentName,
        // TODO: pass messageId to scroll to
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

    if (diffMins < 1) return 'Ahora';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  };

  // Filter conversations
  const activeConvs = conversations.filter((c) => c.status !== 'closed' && !isInactive(c));
  const inactiveConvs = conversations.filter((c) => c.status !== 'closed' && isInactive(c));
  const archivedConvs = conversations.filter((c) => c.status === 'closed');

  return (
    <YStack flex={1}>
      {/* Header with actions */}
      <XStack
        height={40}
        paddingHorizontal={8}
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderBottomColor="#1a1a1a"
      >
        <Text fontSize={11} fontWeight="600" color="#888">
          Chats
        </Text>

        <Button
          size="$1"
          width={22}
          height={22}
          padding={0}
          borderRadius={4}
          backgroundColor="#0891B2"
          hoverStyle={{ backgroundColor: '#06B6D4' }}
          onPress={handleNewConversation}
          icon={<Plus size={14} color="white" />}
        />
      </XStack>

      {/* Search bar */}
      <XStack
        paddingHorizontal={8}
        paddingVertical={6}
        borderBottomWidth={1}
        borderBottomColor="#1a1a1a"
        alignItems="center"
        gap={6}
      >
        <Search size={14} color="#555" />
        <Input
          flex={1}
          size="$2"
          placeholder="Buscar en conversaciones..."
          placeholderTextColor="#444"
          backgroundColor="transparent"
          borderWidth={0}
          borderColor="transparent"
          outlineWidth={0}
          outlineColor="transparent"
          color="#ccc"
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
            hoverStyle={{ backgroundColor: '#222' }}
            onPress={() => setSearchQuery('')}
          >
            <X size={12} color="#666" />
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
                <Text fontSize={11} color="#555">
                  Buscando...
                </Text>
              </YStack>
            ) : searchResults.length === 0 ? (
              <YStack padding={16} alignItems="center">
                <Text fontSize={12} color="#555">
                  No se encontraron resultados para "{searchQuery}"
                </Text>
              </YStack>
            ) : (
              <>
                {/* Results count */}
                <XStack padding={8}>
                  <Text fontSize={10} color="#555">
                    {totalMatches} resultado{totalMatches !== 1 ? 's' : ''} en{' '}
                    {searchResults.length} conversation{searchResults.length !== 1 ? 's' : ''}
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
                      backgroundColor="#111"
                      borderRadius={4}
                    >
                      <Circle size={24} backgroundColor="#1a1a1a">
                        <User size={12} color="#555" />
                      </Circle>
                      <YStack flex={1}>
                        <Text fontSize={11} fontWeight="600" color="#06B6D4">
                          {channel.agentName}
                        </Text>
                        <Text fontSize={10} color="#666">
                          {channel.channelName}
                        </Text>
                      </YStack>
                      <Text fontSize={9} color="#444">
                        {channel.matches.length} match{channel.matches.length !== 1 ? 'es' : ''}
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
                        hoverStyle={{ backgroundColor: '#151515' }}
                        pressStyle={{ backgroundColor: '#1a1a1a' }}
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
                              color={match.role === 'user' ? '#888' : '#06B6D4'}
                              fontWeight="500"
                            >
                              {match.role === 'user' ? 'You' : channel.agentName}
                            </Text>
                            <Text fontSize={9} color="#444">
                              {formatDate(match.timestamp)}
                            </Text>
                          </XStack>
                          <Text fontSize={11} color="#999" numberOfLines={2}>
                            <HighlightedText text={match.snippet} query={searchQuery} />
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
      ) : (
        /* Normal conversation list */
        <ScrollView style={{ flex: 1 }}>
          <YStack padding={4} gap={1}>
            {/* Active conversations */}
            {(showAllActive ? activeConvs : activeConvs.slice(0, MAX_VISIBLE_ACTIVE)).map(
              (conv) => (
                <ConversationItem
                  key={conv.channelId}
                  conv={conv}
                  formatDate={formatDate}
                  onSelect={handleSelectConversation}
                  onArchive={handleArchiveConversation}
                  onMarkAsRead={handleMarkAsRead}
                />
              ),
            )}

            {/* Show more active button */}
            {!showAllActive && activeConvs.length > MAX_VISIBLE_ACTIVE && (
              <XStack
                padding={8}
                paddingLeft={48}
                cursor="pointer"
                hoverStyle={{ backgroundColor: '#151515' }}
                onPress={() => setShowAllActive(true)}
              >
                <Text fontSize={11} color="#06B6D4">
                  +{activeConvs.length - MAX_VISIBLE_ACTIVE} more active...
                </Text>
              </XStack>
            )}

            {/* Inactive section */}
            {inactiveConvs.length > 0 && (
              <YStack marginTop={8}>
                <XStack
                  padding={8}
                  alignItems="center"
                  gap={6}
                  cursor="pointer"
                  onPress={() => setShowInactive(!showInactive)}
                >
                  {showInactive ? (
                    <ChevronUp size={12} color="#555" />
                  ) : (
                    <ChevronDown size={12} color="#555" />
                  )}
                  <Text fontSize={10} color="#555">
                    Inactivas ({inactiveConvs.length})
                  </Text>
                </XStack>

                {showInactive && (
                  <>
                    {(showAllInactive
                      ? inactiveConvs
                      : inactiveConvs.slice(0, MAX_VISIBLE_INACTIVE)
                    ).map((conv) => (
                      <ConversationItem
                        key={conv.channelId}
                        conv={conv}
                        formatDate={formatDate}
                        onSelect={handleSelectConversation}
                        onArchive={handleArchiveConversation}
                        onMarkAsRead={handleMarkAsRead}
                        dimmed
                      />
                    ))}

                    {/* Show more button */}
                    {!showAllInactive && inactiveConvs.length > MAX_VISIBLE_INACTIVE && (
                      <XStack
                        padding={8}
                        paddingLeft={48}
                        cursor="pointer"
                        hoverStyle={{ backgroundColor: '#151515' }}
                        onPress={() => setShowAllInactive(true)}
                      >
                        <Text fontSize={11} color="#06B6D4">
                          +{inactiveConvs.length - MAX_VISIBLE_INACTIVE} more...
                        </Text>
                      </XStack>
                    )}
                  </>
                )}
              </YStack>
            )}

            {/* Archived section - link to dedicated window */}
            {archivedConvs.length > 0 && (
              <XStack
                marginTop={12}
                padding={10}
                gap={8}
                alignItems="center"
                borderRadius={6}
                borderWidth={1}
                borderColor="#1a1a1a"
                backgroundColor="#0a0a0a"
                cursor="pointer"
                hoverStyle={{ backgroundColor: '#111', borderColor: '#222' }}
                onPress={() => openWindow('archived-conversations', {}, false, windowId)}
              >
                <Archive size={14} color="#555" />
                <Text fontSize={11} color="#888" flex={1}>
                  Archivadas
                </Text>
                <Text fontSize={11} color="#555">
                  {archivedConvs.length}
                </Text>
                <ChevronDown size={12} color="#444" style={{ transform: [{ rotate: '-90deg' }] }} />
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
                hoverStyle={isLoadingMore ? {} : { backgroundColor: '#151515' }}
                onPress={loadMore}
              >
                {isLoadingMore ? (
                  <AppSpinner size="sm" variant="brand" />
                ) : (
                  <Text fontSize={11} color="#06B6D4">
                    Cargar más conversaciones...
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
  dimmed = false,
  archived = false,
}: {
  conv: Conversation;
  formatDate: (date: string | null | undefined) => string;
  onSelect: (conv: Conversation) => void;
  onArchive?: (channelId: string) => void;
  onRestore?: (channelId: string) => void;
  onMarkAsRead?: (channelId: string) => void;
  dimmed?: boolean;
  archived?: boolean;
}) {
  // Get isTyping from chatStore (updated via global listener)
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
      opacity={dimmed ? 0.7 : 1}
      hoverStyle={{ backgroundColor: '#151515', opacity: 1 }}
      pressStyle={{ backgroundColor: '#1a1a1a' }}
      onPress={() => onSelect(conv)}
    >
      {/* Avatar */}
      <Circle size={32} backgroundColor="#1a1a1a" overflow="hidden">
        {conv.agentAvatarUrl ? (
          <Avatar circular size={32}>
            <Avatar.Image src={conv.agentAvatarUrl} />
          </Avatar>
        ) : (
          <User size={16} color="#555" />
        )}
      </Circle>

      {/* Content */}
      <YStack flex={1} gap={2}>
        {/* Agent name */}
        <Text
          fontSize={11}
          fontWeight="600"
          color={archived ? '#666' : '#06B6D4'}
          numberOfLines={1}
        >
          {conv.agentName || 'Agente'}
        </Text>

        {/* Conversation title */}
        <Text fontSize={12} fontWeight="500" color={archived ? '#888' : '#ccc'} numberOfLines={1}>
          {conv.title}
        </Text>

        {/* Time */}
        {!archived && (
          <Text fontSize={9} color="#555">
            {formatDate(conv.lastMessageAt)}
          </Text>
        )}
      </YStack>

      {/* Status indicators */}
      <XStack gap={6} alignItems="center">
        {/* Lock: private conversation */}
        {isPrivate && <Lock size={12} color="#666" />}

        {/* Spinner: agent is working */}
        {isTyping && <TerosLoading size={14} color="#06B6D4" />}

        {/* Red dot: external action requested (awaiting human or other agent) */}
        {!isTyping && externalActionRequested && <Circle size={8} backgroundColor="#ef4444" />}

        {/* Blue dot: has unread content */}
        {!isTyping && !externalActionRequested && hasUnread && (
          <Circle
            size={8}
            backgroundColor="#06B6D4"
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
          hoverStyle={{ backgroundColor: 'rgba(16, 185, 129, 0.15)' }}
          onPress={(e: any) => {
            e.stopPropagation();
            onRestore(conv.channelId);
          }}
        >
          <ArchiveRestore size={14} color="#10B981" />
        </XStack>
      )}

      {/* Menu for active/inactive conversations */}
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
              hoverStyle={{ backgroundColor: '#1a1a1a', opacity: 1 }}
              onPress={(e: any) => e.stopPropagation()}
            >
              <MoreVertical size={14} color="#666" />
            </XStack>
          </Popover.Trigger>

          <Popover.Content
            backgroundColor="#151515"
            borderWidth={1}
            borderColor="#2a2a2a"
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
              hoverStyle={{ backgroundColor: 'rgba(255, 152, 0, 0.15)' }}
              onPress={(e: any) => {
                e.stopPropagation();
                onArchive(conv.channelId);
              }}
            >
              <Archive size={14} color="#FF9800" />
              <Text fontSize={12} color="#ccc">
                Archivar
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

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query || query.length < 2) {
    return <>{text}</>;
  }

  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <Text key={i} color="#06B6D4" fontWeight="600">
            {part}
          </Text>
        ) : (
          <Text key={i}>{part}</Text>
        ),
      )}
    </>
  );
}
