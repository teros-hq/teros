/**
 * TilingSidebar - Collapsible conversation list
 *
 * Features:
 * - Collapsible with button
 * - Responsive (narrower on mobile)
 * - Dark background
 */

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Columns,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rows,
  Shield,
  Terminal,
  User,
  X,
} from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { ScrollView, useWindowDimensions } from 'react-native';
import { Avatar, Button, Circle, Sheet, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import { selectActiveContainerId, useTilingStore } from '../../store/tilingStore';
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
  externalActionRequested?: boolean;
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
  /** Ancho expandido (default 220) */
  expandedWidth?: number;
  /** Ancho colapsado (default 56) */
  collapsedWidth?: number;
  /** Si empieza colapsado */
  defaultCollapsed?: boolean;
}

export function TilingSidebar({
  expandedWidth = 220,
  collapsedWidth = 56,
  defaultCollapsed = false,
}: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const isMobile = screenWidth < 768;

  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed || isMobile);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const [newChatInNewTab, setNewChatInNewTab] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const client = getTerosClient();

  // Helper: check if conversation is inactive (no messages in last 3 hours)
  const isInactive = (conv: Conversation) => {
    if (conv.status === 'closed') return false;
    const lastActivity = conv.lastMessageAt;
    if (!lastActivity) return true;
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    return new Date(lastActivity).getTime() < threeHoursAgo;
  };
  const { openWindow, findWindow, focusWindow, splitActive } = useTilingStore();
  const activeContainerId = useTilingStore(selectActiveContainerId);
  const { shouldOpenInNewTab } = useClickModifiers();

  // Auto-collapse on mobile
  useEffect(() => {
    if (isMobile && !isCollapsed) {
      setIsCollapsed(true);
    }
  }, [isMobile]);

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

  // Listen for channel status updates (including externalActionRequested)
  useEffect(() => {
    if (!connected) return;

    const handleChannelStatus = (data: any) => {
      const { channelId, externalActionRequested } = data;
      
      if (externalActionRequested !== undefined) {
        setConversations((prev) =>
          prev.map((conv) =>
            conv.channelId === channelId
              ? { ...conv, externalActionRequested }
              : conv,
          ),
        );
      }
    };

    client.on('channel_status', handleChannelStatus);

    return () => {
      client.off('channel_status', handleChannelStatus);
    };
  }, [connected]);

  const loadConversations = async () => {
    setIsLoading(true);
    try {
      const { channels } = await client.channel.list();
      const agentList = await client.agent.listAgents().then((r) => r.agents);

      const convs: Conversation[] = channels.map((ch: any) => {
        const agent = agentList.find((a: any) => a.agentId === ch.agentId);
        return {
          channelId: ch.channelId,
          title: ch.metadata?.name || 'Chat',
          agentId: ch.agentId,
          agentName: agent?.name || agent?.fullName,
          agentAvatarUrl: agent?.avatarUrl,
          lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
          status: ch.status || 'active',
          unreadCount: ch.unreadCount || 0,
          externalActionRequested: ch.externalActionRequested || false,
        };
      });

      setConversations(convs);
    } catch (err) {
      console.error('[TilingSidebar] Error loading conversations:', err);
    } finally {
      setIsLoading(false);
    }
  };

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
      console.error('[TilingSidebar] Error loading agents:', err);
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
        inNewTab,
      );
    }

    // Auto-collapse on mobile after selecting
    if (isMobile) {
      setIsCollapsed(true);
    }
  };

  const handleNewConversation = (e?: any) => {
    setNewChatInNewTab(e ? shouldOpenInNewTab(e) : false);
    setShowAgentSelector(true);
  };

  const handleSelectAgent = (agent: Agent) => {
    setShowAgentSelector(false);
    openWindow(
      'chat',
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
      },
      newChatInNewTab,
    );

    if (isMobile) {
      setIsCollapsed(true);
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

  // Active = not closed AND had activity in last 3 hours
  const activeConvs = conversations.filter((c) => c.status !== 'closed' && !isInactive(c));
  // Inactive = not closed BUT no activity in 3+ hours
  const inactiveConvs = conversations.filter((c) => c.status !== 'closed' && isInactive(c));
  // Archived = closed
  const archivedConvs = conversations.filter((c) => c.status === 'closed');
  const totalUnread = conversations
    .filter((c) => c.status !== 'closed')
    .reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  // Count conversations with pending permissions
  const totalPendingApprovals = conversations.filter(
    (c) => c.status !== 'closed' && c.externalActionRequested,
  ).length;

  const currentWidth = isCollapsed ? collapsedWidth : expandedWidth;

  // ========================================
  // COLLAPSED VIEW
  // ========================================
  if (isCollapsed) {
    return (
      <YStack
        width={collapsedWidth}
        backgroundColor="#0a0a0a"
        borderRightWidth={1}
        borderRightColor="#1a1a1a"
        alignItems="center"
        paddingVertical={8}
        gap={6}
      >
        {/* Expand button */}
        <Button
          size="$4"
          circular
          backgroundColor="transparent"
          hoverStyle={{ backgroundColor: '#1a1a1a' }}
          onPress={() => setIsCollapsed(false)}
          icon={<PanelLeftOpen size={20} color="#666" />}
        />

        {/* New chat */}
        <Button
          size="$3"
          circular
          backgroundColor="#06B6D4"
          hoverStyle={{ backgroundColor: '#0891B2' }}
          onPress={(e) => handleNewConversation(e)}
          icon={<Plus size={16} color="white" />}
        />

        {/* Split buttons */}
        <Button
          size="$4"
          circular
          backgroundColor="transparent"
          hoverStyle={{ backgroundColor: '#1a1a1a' }}
          onPress={() => splitActive('horizontal')}
          disabled={!activeContainerId}
          opacity={activeContainerId ? 1 : 0.3}
          icon={<Columns size={20} color="#666" />}
        />
        <Button
          size="$4"
          circular
          backgroundColor="transparent"
          hoverStyle={{ backgroundColor: '#1a1a1a' }}
          onPress={() => splitActive('vertical')}
          disabled={!activeContainerId}
          opacity={activeContainerId ? 1 : 0.3}
          icon={<Rows size={20} color="#666" />}
        />

        {/* Console button */}
        <Button
          size="$4"
          circular
          backgroundColor="transparent"
          hoverStyle={{ backgroundColor: '#1a1a1a' }}
          onPress={() => openWindow('console', {})}
          icon={<Terminal size={20} color="#666" />}
        />

        {/* Pending approvals button */}
        {totalPendingApprovals > 0 && (
          <Button
            size="$4"
            circular
            backgroundColor="rgba(245, 158, 11, 0.15)"
            borderWidth={1}
            borderColor="rgba(245, 158, 11, 0.3)"
            hoverStyle={{
              backgroundColor: 'rgba(245, 158, 11, 0.25)',
              borderColor: '#F59E0B',
            }}
            onPress={() => openWindow('pending-approvals', {})}
            position="relative"
          >
            <Shield size={20} color="#F59E0B" />
            <Circle
              size={18}
              backgroundColor="#F59E0B"
              position="absolute"
              top={-4}
              right={-4}
            >
              <Text fontSize={10} fontWeight="700" color="white">
                {totalPendingApprovals > 9 ? '9+' : totalPendingApprovals}
              </Text>
            </Circle>
          </Button>
        )}

        {/* Unread indicator */}
        {totalUnread > 0 && (
          <Circle size={36} backgroundColor="#06B6D4" marginTop={8}>
            <Text fontSize={12} fontWeight="700" color="white">
              {totalUnread > 99 ? '99+' : totalUnread}
            </Text>
          </Circle>
        )}

        {/* Recent conversations (just avatars) */}
        <YStack flex={1} marginTop={8} gap={6}>
          {activeConvs.slice(0, 6).map((conv) => (
            <Button
              key={conv.channelId}
              size="$4"
              circular
              backgroundColor={conv.unreadCount ? '#1a1a1a' : 'transparent'}
              hoverStyle={{ backgroundColor: '#1a1a1a' }}
              onPress={(e) => handleSelectConversation(conv, e)}
              padding={0}
            >
              {conv.agentAvatarUrl ? (
                <Avatar circular size={36}>
                  <Avatar.Image src={conv.agentAvatarUrl} />
                </Avatar>
              ) : (
                <Circle size={36} backgroundColor="#1a1a1a">
                  <User size={18} color="#555" />
                </Circle>
              )}
            </Button>
          ))}
        </YStack>

        {/* Agent selector sheet */}
        <AgentSelectorSheet
          open={showAgentSelector}
          onOpenChange={setShowAgentSelector}
          agents={agents}
          onSelect={handleSelectAgent}
        />
      </YStack>
    );
  }

  // ========================================
  // EXPANDED VIEW
  // ========================================
  return (
    <YStack
      width={expandedWidth}
      backgroundColor="#0a0a0a"
      borderRightWidth={1}
      borderRightColor="#1a1a1a"
    >
      {/* Header */}
      <XStack
        height={44}
        paddingHorizontal={8}
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderBottomColor="#1a1a1a"
      >
        <XStack alignItems="center" gap={8}>
          <Button
            size="$2"
            circular
            backgroundColor="transparent"
            hoverStyle={{ backgroundColor: '#1a1a1a' }}
            onPress={() => setIsCollapsed(true)}
            icon={<PanelLeftClose size={16} color="#666" />}
          />
          <Text fontSize={12} fontWeight="600" color="#888">
            Chats
          </Text>
        </XStack>

        <XStack gap={2}>
          <Button
            size="$1"
            circular
            backgroundColor="transparent"
            hoverStyle={{ backgroundColor: '#1a1a1a' }}
            onPress={() => openWindow('console', {})}
            icon={<Terminal size={14} color="#666" />}
          />
          {totalPendingApprovals > 0 && (
            <Button
              size="$1"
              circular
              backgroundColor="rgba(245, 158, 11, 0.15)"
              borderWidth={1}
              borderColor="rgba(245, 158, 11, 0.3)"
              hoverStyle={{
                backgroundColor: 'rgba(245, 158, 11, 0.25)',
                borderColor: '#F59E0B',
              }}
              onPress={() => openWindow('pending-approvals', {})}
              position="relative"
            >
              <Shield size={14} color="#F59E0B" />
              <Circle
                size={14}
                backgroundColor="#F59E0B"
                position="absolute"
                top={-4}
                right={-4}
              >
                <Text fontSize={8} fontWeight="700" color="white">
                  {totalPendingApprovals > 9 ? '9+' : totalPendingApprovals}
                </Text>
              </Circle>
            </Button>
          )}
          <Button
            size="$1"
            circular
            backgroundColor="transparent"
            hoverStyle={{ backgroundColor: '#1a1a1a' }}
            onPress={() => splitActive('horizontal')}
            disabled={!activeContainerId}
            opacity={activeContainerId ? 1 : 0.3}
            icon={<Columns size={14} color="#666" />}
          />
          <Button
            size="$1"
            circular
            backgroundColor="transparent"
            hoverStyle={{ backgroundColor: '#1a1a1a' }}
            onPress={() => splitActive('vertical')}
            disabled={!activeContainerId}
            opacity={activeContainerId ? 1 : 0.3}
            icon={<Rows size={14} color="#666" />}
          />
          <Button
            size="$1"
            circular
            backgroundColor="#06B6D4"
            hoverStyle={{ backgroundColor: '#0891B2' }}
            onPress={(e) => handleNewConversation(e)}
            icon={<Plus size={14} color="white" />}
          />
        </XStack>
      </XStack>

      {/* List */}
      {isLoading ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <AppSpinner variant="brand" />
        </YStack>
      ) : (
        <ScrollView style={{ flex: 1 }}>
          <YStack padding={4} gap={1}>
            {/* Active conversations (recent activity) */}
            {activeConvs.map((conv) => (
              <XStack
                key={conv.channelId}
                padding={8}
                gap={8}
                alignItems="center"
                borderRadius={6}
                cursor="pointer"
                backgroundColor="transparent"
                hoverStyle={{ backgroundColor: '#151515' }}
                pressStyle={{ backgroundColor: '#1a1a1a' }}
                onPress={(e) => handleSelectConversation(conv, e)}
              >
                <Circle size={32} backgroundColor="#1a1a1a" overflow="hidden">
                  {conv.agentAvatarUrl ? (
                    <Avatar circular size={32}>
                      <Avatar.Image src={conv.agentAvatarUrl} />
                    </Avatar>
                  ) : (
                    <User size={16} color="#555" />
                  )}
                </Circle>

                <YStack flex={1}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <Text fontSize={12} fontWeight="500" color="#ccc" numberOfLines={1} flex={1}>
                      {conv.title}
                    </Text>
                    <Text fontSize={9} color="#555">
                      {formatDate(conv.lastMessageAt)}
                    </Text>
                  </XStack>
                  <Text fontSize={10} color="#666" numberOfLines={1}>
                    {conv.agentName || 'Agente'}
                  </Text>
                </YStack>

                {conv.unreadCount && conv.unreadCount > 0 && (
                  <Circle size={16} backgroundColor="#06B6D4">
                    <Text fontSize={9} fontWeight="700" color="white">
                      {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                    </Text>
                  </Circle>
                )}
              </XStack>
            ))}

            {/* Inactive (no activity in 3+ hours) */}
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

                {showInactive &&
                  inactiveConvs.map((conv) => (
                    <XStack
                      key={conv.channelId}
                      padding={8}
                      gap={8}
                      alignItems="center"
                      borderRadius={6}
                      cursor="pointer"
                      opacity={0.7}
                      hoverStyle={{ backgroundColor: '#151515', opacity: 1 }}
                      onPress={(e) => handleSelectConversation(conv, e)}
                    >
                      <Circle size={32} backgroundColor="#1a1a1a" overflow="hidden">
                        {conv.agentAvatarUrl ? (
                          <Avatar circular size={32}>
                            <Avatar.Image src={conv.agentAvatarUrl} />
                          </Avatar>
                        ) : (
                          <User size={16} color="#555" />
                        )}
                      </Circle>
                      <YStack flex={1}>
                        <XStack justifyContent="space-between" alignItems="center">
                          <Text fontSize={12} color="#999" numberOfLines={1} flex={1}>
                            {conv.title}
                          </Text>
                          <Text fontSize={9} color="#444">
                            {formatDate(conv.lastMessageAt)}
                          </Text>
                        </XStack>
                        <Text fontSize={10} color="#555" numberOfLines={1}>
                          {conv.agentName || 'Agente'}
                        </Text>
                      </YStack>
                      {conv.unreadCount && conv.unreadCount > 0 && (
                        <Circle size={16} backgroundColor="#71717A">
                          <Text fontSize={9} fontWeight="700" color="white">
                            {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                          </Text>
                        </Circle>
                      )}
                    </XStack>
                  ))}
              </YStack>
            )}

            {/* Archived */}
            {archivedConvs.length > 0 && (
              <YStack marginTop={8}>
                <XStack
                  padding={8}
                  alignItems="center"
                  gap={6}
                  cursor="pointer"
                  onPress={() => setShowArchived(!showArchived)}
                >
                  {showArchived ? (
                    <ChevronUp size={12} color="#555" />
                  ) : (
                    <ChevronDown size={12} color="#555" />
                  )}
                  <Archive size={12} color="#555" />
                  <Text fontSize={10} color="#555">
                    Archivadas ({archivedConvs.length})
                  </Text>
                </XStack>

                {showArchived &&
                  archivedConvs.map((conv) => (
                    <XStack
                      key={conv.channelId}
                      padding={8}
                      gap={8}
                      alignItems="center"
                      borderRadius={6}
                      cursor="pointer"
                      opacity={0.6}
                      hoverStyle={{ backgroundColor: '#151515', opacity: 1 }}
                      onPress={(e) => handleSelectConversation(conv, e)}
                    >
                      <Circle size={32} backgroundColor="#1a1a1a" overflow="hidden">
                        {conv.agentAvatarUrl ? (
                          <Avatar circular size={32}>
                            <Avatar.Image src={conv.agentAvatarUrl} />
                          </Avatar>
                        ) : (
                          <User size={16} color="#555" />
                        )}
                      </Circle>
                      <YStack flex={1}>
                        <Text fontSize={12} color="#888" numberOfLines={1}>
                          {conv.title}
                        </Text>
                      </YStack>
                    </XStack>
                  ))}
              </YStack>
            )}
          </YStack>
        </ScrollView>
      )}

      {/* Agent Selector */}
      <AgentSelectorSheet
        open={showAgentSelector}
        onOpenChange={setShowAgentSelector}
        agents={agents}
        onSelect={handleSelectAgent}
      />
    </YStack>
  );
}

// ========================================
// AGENT SELECTOR SHEET
// ========================================

function AgentSelectorSheet({
  open,
  onOpenChange,
  agents,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  onSelect: (agent: Agent) => void;
}) {
  return (
    <Sheet
      modal
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={[60]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <Sheet.Overlay
        animation="lazy"
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor="rgba(0, 0, 0, 0.7)"
      />
      <Sheet.Frame
        backgroundColor="#111"
        borderTopLeftRadius={12}
        borderTopRightRadius={12}
        padding={16}
      >
        <Sheet.Handle backgroundColor="#333" />

        <XStack justifyContent="space-between" alignItems="center" marginBottom={16}>
          <Text fontSize={16} fontWeight="600" color="#e4e4e7">
            Nuevo chat
          </Text>
          <Button
            circular
            size="$2"
            backgroundColor="transparent"
            icon={<X size={16} color="#666" />}
            onPress={() => onOpenChange(false)}
          />
        </XStack>

        <ScrollView style={{ maxHeight: 400 }}>
          <YStack gap={8}>
            {agents.map((agent) => (
              <XStack
                key={agent.agentId}
                padding={12}
                gap={12}
                alignItems="center"
                backgroundColor="#1a1a1a"
                borderRadius={8}
                cursor="pointer"
                hoverStyle={{ backgroundColor: '#222' }}
                pressStyle={{ backgroundColor: '#252525' }}
                onPress={() => onSelect(agent)}
              >
                <Avatar circular size={44}>
                  {agent.avatarUrl ? (
                    <Avatar.Image src={agent.avatarUrl} />
                  ) : (
                    <Avatar.Fallback backgroundColor="#333">
                      <User size={22} color="#666" />
                    </Avatar.Fallback>
                  )}
                </Avatar>
                <YStack flex={1}>
                  <Text fontSize={14} fontWeight="600" color="#e4e4e7">
                    {agent.fullName}
                  </Text>
                  <Text fontSize={11} color="#06B6D4">
                    {agent.role}
                  </Text>
                  <Text fontSize={11} color="#666" numberOfLines={2}>
                    {agent.intro}
                  </Text>
                </YStack>
              </XStack>
            ))}
          </YStack>
        </ScrollView>
      </Sheet.Frame>
    </Sheet>
  );
}
