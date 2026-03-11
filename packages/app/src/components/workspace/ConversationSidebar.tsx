/**
 * ConversationSidebar - Conversation list for the workspace
 *
 * Simplified version of the conversation list to use as a sidebar
 * in the window system.
 */

import { ChevronDown, ChevronUp, MessageCircle, Plus, User, X } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { Avatar, Button, Circle, Sheet, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import { STORAGE_KEYS, storage } from '../../services/storage';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { AppSpinner } from '../../components/ui';

interface Conversation {
  channelId: string;
  title: string;
  agentId?: string;
  agentName?: string;
  agentAvatarUrl?: string;
  lastMessageAt?: string | null;
  status?: 'active' | 'closed';
  unreadCount?: number;
}

interface Agent {
  agentId: string;
  name: string;
  fullName: string;
  role: string;
  intro: string;
  avatarUrl: string;
}

interface Props {
  /** Ancho del sidebar */
  width?: number;
}

export function ConversationSidebar({ width = 280 }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const client = getTerosClient();
  const { openWindow, findWindow, focusWindow } = useWorkspaceStore();
  const { shouldOpenInNewTab } = useClickModifiers();

  // Load data
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

  useEffect(() => {
    if (!connected) return;

    loadConversations();
    loadAgents();
  }, [connected]);

  const mapChannel = (ch: any, agentList: any[]): Conversation => {
    const agent = agentList.find((a: any) => a.agentId === ch.agentId);
    return {
      channelId: ch.channelId,
      title: ch.metadata?.name || 'Chat',
      agentId: ch.agentId,
      agentName: ch.agentName || agent?.name || agent?.fullName,
      agentAvatarUrl: ch.agentAvatarUrl || agent?.avatarUrl,
      lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
      status: ch.status || 'active',
      unreadCount: ch.unreadCount || 0,
    };
  };

  const loadConversations = async () => {
    setIsLoading(true);
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, agentList] = await Promise.all([
        client.channel.list(),
        client.agent.listAgents().then((r: any) => r.agents),
      ]);

      const convs: Conversation[] = channels.map((ch: any) => mapChannel(ch, agentList));
      setConversations(convs);
      setNextCursor(cursor ?? null);
      setHasMore(more ?? false);
    } catch (err) {
      console.error('[ConversationSidebar] Error loading conversations:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore || !nextCursor) return;
    setIsLoadingMore(true);
    try {
      const [{ channels, nextCursor: cursor, hasMore: more }, agentList] = await Promise.all([
        client.channel.list(undefined, undefined, 30, nextCursor),
        client.agent.listAgents().then((r: any) => r.agents),
      ]);

      const newConvs: Conversation[] = channels.map((ch: any) => mapChannel(ch, agentList));
      setConversations((prev) => {
        const existingIds = new Set(prev.map((c) => c.channelId));
        const unique = newConvs.filter((c) => !existingIds.has(c.channelId));
        return [...prev, ...unique];
      });
      setNextCursor(cursor ?? null);
      setHasMore(more ?? false);
    } catch (err) {
      console.error('[ConversationSidebar] Error loading more conversations:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, hasMore, nextCursor]);

  const loadAgents = async () => {
    try {
      const agentList = await client.agent.listAgents().then((r) => r.agents);
      setAgents(
        agentList.map((a: any) => ({
          agentId: a.agentId,
          name: a.name,
          fullName: a.fullName,
          role: a.role,
          intro: a.intro,
          avatarUrl: a.avatarUrl,
        })),
      );
    } catch (err) {
      console.error('[ConversationSidebar] Error loading agents:', err);
    }
  };

  const handleSelectConversation = (conv: Conversation, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    const existingWindow = findWindow('chat', (props) => props.channelId === conv.channelId);

    if (existingWindow && !inNewTab) {
      focusWindow(existingWindow.id);
    } else {
      openWindow(
        'chat',
        {
          channelId: conv.channelId,
          agentId: conv.agentId,
          agentName: conv.agentName,
        },
        { mode: 'docked' },
      );
    }
  };

  const handleNewConversation = () => {
    setShowAgentSelector(true);
  };

  const handleSelectAgent = (agent: Agent) => {
    setShowAgentSelector(false);

    // Open new window de chat con este agente
    openWindow(
      'chat',
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
      },
      { mode: 'docked' },
    );
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

  const activeConvs = conversations.filter((c) => c.status !== 'closed');
  const archivedConvs = conversations.filter((c) => c.status === 'closed');

  return (
    <YStack width={width} backgroundColor="$gray1" borderRightWidth={1} borderRightColor="$gray4">
      {/* Header */}
      <XStack
        height={48}
        paddingHorizontal="$3"
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderBottomColor="$gray4"
      >
        <Text fontSize={14} fontWeight="600" color="$gray12">
          Conversaciones
        </Text>
        <Button
          size="$2"
          circular
          backgroundColor="$cyan10"
          hoverStyle={{ backgroundColor: '$cyan9' }}
          onPress={handleNewConversation}
          icon={<Plus size={16} color="white" />}
        />
      </XStack>

      {/* Conversation List */}
      {isLoading ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <AppSpinner variant="brand" />
        </YStack>
      ) : (
        <ScrollView style={{ flex: 1 }}>
          <YStack padding="$2" gap="$1">
            {activeConvs.map((conv) => (
              <XStack
                key={conv.channelId}
                padding="$2"
                gap="$2"
                alignItems="center"
                borderRadius="$2"
                cursor="pointer"
                hoverStyle={{ backgroundColor: '$gray3' }}
                pressStyle={{ backgroundColor: '$gray4' }}
                onPress={(e) => handleSelectConversation(conv, e)}
              >
                {/* Avatar */}
                <Circle size={36} backgroundColor="$gray3" overflow="hidden">
                  {conv.agentAvatarUrl ? (
                    <Avatar circular size={36}>
                      <Avatar.Image src={conv.agentAvatarUrl} />
                    </Avatar>
                  ) : (
                    <User size={18} color="$gray9" />
                  )}
                </Circle>

                {/* Info */}
                <YStack flex={1}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <Text fontSize={13} fontWeight="500" color="$gray12" numberOfLines={1} flex={1}>
                      {conv.title}
                    </Text>
                    <Text fontSize={10} color="$gray9">
                      {formatDate(conv.lastMessageAt)}
                    </Text>
                  </XStack>
                  <Text fontSize={11} color="$gray9" numberOfLines={1}>
                    {conv.agentName || 'Agente'}
                  </Text>
                </YStack>

                {/* Unread badge */}
                {conv.unreadCount && conv.unreadCount > 0 && (
                  <Circle size={18} backgroundColor="$cyan10">
                    <Text fontSize={10} fontWeight="700" color="white">
                      {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                    </Text>
                  </Circle>
                )}
              </XStack>
            ))}

            {/* Archived section */}
            {archivedConvs.length > 0 && (
              <YStack marginTop="$2">
                <XStack
                  padding="$2"
                  alignItems="center"
                  gap="$2"
                  cursor="pointer"
                  onPress={() => setShowArchived(!showArchived)}
                >
                  {showArchived ? (
                    <ChevronUp size={14} color="$gray9" />
                  ) : (
                    <ChevronDown size={14} color="$gray9" />
                  )}
                  <Text fontSize={12} color="$gray9">
                    Archivadas ({archivedConvs.length})
                  </Text>
                </XStack>

                {showArchived &&
                  archivedConvs.map((conv) => (
                    <XStack
                      key={conv.channelId}
                      padding="$2"
                      gap="$2"
                      alignItems="center"
                      borderRadius="$2"
                      cursor="pointer"
                      opacity={0.7}
                      hoverStyle={{ backgroundColor: '$gray3', opacity: 1 }}
                      onPress={(e) => handleSelectConversation(conv, e)}
                    >
                      <Circle size={36} backgroundColor="$gray3" overflow="hidden">
                        {conv.agentAvatarUrl ? (
                          <Avatar circular size={36}>
                            <Avatar.Image src={conv.agentAvatarUrl} />
                          </Avatar>
                        ) : (
                          <User size={18} color="$gray9" />
                        )}
                      </Circle>
                      <YStack flex={1}>
                        <Text fontSize={13} color="$gray11" numberOfLines={1}>
                          {conv.title}
                        </Text>
                        <Text fontSize={11} color="$gray9" numberOfLines={1}>
                          {conv.agentName || 'Agente'}
                        </Text>
                      </YStack>
                    </XStack>
                  ))}
              </YStack>
            )}

            {/* Load more button */}
            {hasMore && (
              <XStack
                marginTop={4}
                padding={8}
                justifyContent="center"
                alignItems="center"
                borderRadius={4}
                cursor={isLoadingMore ? 'default' : 'pointer'}
                opacity={isLoadingMore ? 0.5 : 1}
                hoverStyle={isLoadingMore ? {} : { backgroundColor: '$gray3' }}
                onPress={loadMore}
              >
                {isLoadingMore ? (
                  <AppSpinner size="sm" variant="brand" />
                ) : (
                  <Text fontSize={11} color="$cyan10">
                    Cargar más...
                  </Text>
                )}
              </XStack>
            )}
          </YStack>
        </ScrollView>
      )}

      {/* Agent Selector Sheet */}
      <Sheet
        modal
        open={showAgentSelector}
        onOpenChange={setShowAgentSelector}
        snapPoints={[60]}
        dismissOnSnapToBottom
        zIndex={100000}
      >
        <Sheet.Overlay
          animation="lazy"
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
          backgroundColor="rgba(0, 0, 0, 0.5)"
        />
        <Sheet.Frame
          backgroundColor="$gray2"
          borderTopLeftRadius="$4"
          borderTopRightRadius="$4"
          padding="$4"
        >
          <Sheet.Handle backgroundColor="$gray6" />

          <XStack justifyContent="space-between" alignItems="center" marginBottom="$4">
            <Text fontSize={18} fontWeight="600" color="$gray12">
              Nuevo chat
            </Text>
            <Button
              circular
              size="$2"
              backgroundColor="transparent"
              icon={<X size={18} color="$gray9" />}
              onPress={() => setShowAgentSelector(false)}
            />
          </XStack>

          <ScrollView style={{ maxHeight: 400 }}>
            <YStack gap="$2">
              {agents.map((agent) => (
                <XStack
                  key={agent.agentId}
                  padding="$3"
                  gap="$3"
                  alignItems="center"
                  backgroundColor="$gray3"
                  borderRadius="$3"
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: '$gray4' }}
                  pressStyle={{ backgroundColor: '$gray5' }}
                  onPress={() => handleSelectAgent(agent)}
                >
                  <Avatar circular size={48}>
                    {agent.avatarUrl ? (
                      <Avatar.Image src={agent.avatarUrl} />
                    ) : (
                      <Avatar.Fallback backgroundColor="$gray5">
                        <User size={24} color="$gray9" />
                      </Avatar.Fallback>
                    )}
                  </Avatar>
                  <YStack flex={1}>
                    <Text fontSize={15} fontWeight="600" color="$gray12">
                      {agent.fullName}
                    </Text>
                    <Text fontSize={12} color="$cyan10">
                      {agent.role}
                    </Text>
                    <Text fontSize={12} color="$gray9" numberOfLines={2}>
                      {agent.intro}
                    </Text>
                  </YStack>
                </XStack>
              ))}
            </YStack>
          </ScrollView>
        </Sheet.Frame>
      </Sheet>
    </YStack>
  );
}
