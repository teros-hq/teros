/**
 * ArchivedConversationsWindowContent - Dedicated window for archived conversations
 *
 * Features:
 * - Search within archived conversations
 * - Restore conversations
 * - Open archived conversation (read-only or restore on first message)
 */

import { ArchiveRestore, Search, User, X } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { Avatar, Circle, Input, Text, XStack, YStack } from 'tamagui';
import { getDateLocale } from '../../i18n';
import { getTerosClient } from '../../services/terosClientSingleton';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import type { ArchivedConversationsWindowProps } from './definition';
import { AppSpinner } from '../../components/ui';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors } from '../../components/mca/primitives/colors';

interface ArchivedConversation {
  channelId: string;
  title: string;
  agentId?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  lastMessageAt?: string | null;
  lastMessageContent?: string;
}

export function ArchivedConversationsWindowContent({
  windowId,
  workspaceId,
  searchQuery: initialSearchQuery = '',
}: ArchivedConversationsWindowProps & { windowId: string }) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<ArchivedConversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);

  const client = getTerosClient();
  const { openWindow, findWindow, focusWindow } = useTilingStore();
  // Always use the active workspace from the store — no prop, no fallback.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const c = useColors();

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
    loadData();
  }, [connected]);

  const mapChannelToArchived = (ch: any, agentList: any[]): ArchivedConversation => {
    const agent = agentList.find((a: any) => a.agentId === ch.agentId);
    return {
      channelId: ch.channelId,
      title: ch.metadata?.name || t('chat.fallbackTitle'),
      agentId: ch.agentId,
      agentName: ch.agentName || agent?.name || agent?.fullName,
      agentAvatarUrl: ch.agentAvatarUrl || agent?.avatarUrl,
      lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
      lastMessageContent: ch.lastMessage?.content || '',
    };
  };

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, { agents: agentList }] =
        await Promise.all([
          client.channel.list(activeWorkspaceId ?? undefined, 'closed'),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ]);

      const archived: ArchivedConversation[] = channels.map((ch: any) =>
        mapChannelToArchived(ch, agentList),
      );

      setConversations(archived);
      setNextCursor(cursor ?? null);
      setHasMore(more ?? false);
    } catch (err) {
      console.error('[ArchivedConversationsWindow] Error loading data:', err);
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
          client.channel.list(activeWorkspaceId ?? undefined, 'closed', 30, nextCursor),
          client.agent.listAgents(activeWorkspaceId ?? undefined),
        ]);

      const newArchived: ArchivedConversation[] = channels.map((ch: any) =>
        mapChannelToArchived(ch, agentList),
      );

      setConversations((prev) => {
        const existingIds = new Set(prev.map((c) => c.channelId));
        const unique = newArchived.filter((c) => !existingIds.has(c.channelId));
        return [...prev, ...unique];
      });
      setNextCursor(cursor ?? null);
      setHasMore(more ?? false);
    } catch (err) {
      console.error('[ArchivedConversationsWindow] Error loading more:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore, nextCursor]);

  const handleSelectConversation = (conv: ArchivedConversation) => {
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

  const handleRestoreConversation = async (channelId: string) => {
    try {
      await client.channel.reopen(channelId);
      setConversations((prev) => prev.filter((c) => c.channelId !== channelId));
    } catch (err) {
      console.error('Error restoring conversation:', err);
    }
  };

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays < 1) return t('archivedConversations.today');
    if (diffDays < 2) return t('archivedConversations.yesterday');
    if (diffDays < 7) return t('archivedConversations.daysAgo', { count: diffDays });
    if (diffDays < 30) return t('archivedConversations.weeksAgo', { count: Math.floor(diffDays / 7) });
    return date.toLocaleDateString(getDateLocale(), { day: 'numeric', month: 'short' });
  };

  // Filter by search
  const filteredConvs =
    searchQuery.length >= 2
      ? conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            c.agentName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            c.lastMessageContent?.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : conversations;

  return (
    <YStack flex={1}>
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
          placeholder={t('archivedConversations.searchPlaceholder')}
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
      ) : filteredConvs.length === 0 ? (
        <YStack flex={1} justifyContent="center" alignItems="center" padding={16}>
          <Text fontSize={12} color={c.text3} textAlign="center">
            {searchQuery.length >= 2
              ? t('archivedConversations.noResults', { query: searchQuery })
              : t('archivedConversations.empty')}
          </Text>
        </YStack>
      ) : (
        <ScrollView style={{ flex: 1 }}>
          <YStack padding={4} gap={1}>
            {/* Count */}
            <XStack padding={8}>
              <Text fontSize={10} color={c.text3}>
                {t('archivedConversations.count', { count: filteredConvs.length })}
              </Text>
            </XStack>

            {/* When searching we show filtered results (client-side); show load-more only when not searching */}
            {filteredConvs.map((conv) => (
              <XStack
                key={conv.channelId}
                padding={8}
                gap={8}
                alignItems="center"
                borderRadius={6}
                cursor="pointer"
                backgroundColor="transparent"
                opacity={0.8}
                hoverStyle={{ backgroundColor: c.bgCardHover, opacity: 1 }}
                pressStyle={{ backgroundColor: c.bgCardHover }}
                onPress={() => handleSelectConversation(conv)}
              >
                {/* Avatar */}
                <Circle size={32} backgroundColor={c.bgCard} overflow="hidden">
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
                  <Text fontSize={11} fontWeight="600" color={c.text2} numberOfLines={1}>
                    {conv.agentName || t('chat.fallbackAgentName')}
                  </Text>
                  <Text fontSize={12} fontWeight="500" color={c.text} numberOfLines={1}>
                    {conv.title}
                  </Text>
                  <Text fontSize={9} color={c.text3}>
                    {formatDate(conv.lastMessageAt)}
                  </Text>
                </YStack>

                {/* Restore button */}
                <XStack
                  width={28}
                  height={28}
                  justifyContent="center"
                  alignItems="center"
                  borderRadius={4}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: 'rgba(16, 185, 129, 0.15)' }}
                  onPress={(e: any) => {
                    e.stopPropagation();
                    handleRestoreConversation(conv.channelId);
                  }}
                >
                  <ArchiveRestore size={16} color={semanticColors.green} />
                </XStack>
              </XStack>
            ))}

            {/* Load more button — only when not filtering by search */}
            {searchQuery.length < 2 && hasMore && (
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
                  <Text fontSize={11} color={semanticColors.indigo}>
                    {t('archivedConversations.loadMore')}
                  </Text>
                )}
              </XStack>
            )}
          </YStack>
        </ScrollView>
      )}
    </YStack>
  );
}
