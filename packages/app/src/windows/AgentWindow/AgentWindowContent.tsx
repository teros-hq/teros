/**
 * Agent Window Content
 *
 * Configure an agent: view conversations, edit info, manage context, apps, and model.
 */

import {
  Archive,
  Bot,
  Camera,
  Edit3,
  Folder,
  MessageSquare,
  Mic,
  Package,
  Plus,
  Save,
  Search,
  Settings,
  Shield,
  Terminal,
  Trash2,
  User,
  X,
} from '@tamagui/lucide-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  Button,
  Circle,
  H2,
  Input,
  ScrollView,
  Separator,
  Sheet,
  Text,
  TextArea,
  XStack,
  YStack,
} from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useNavbarStore } from '../../store/navbarStore';
import { useTilingStore } from '../../store/tilingStore';
import type { AgentWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

// Map icon names to Lucide components
const iconMap: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  terminal: Terminal,
  folder: Folder,
  package: Package,
};

interface Agent {
  agentId: string;
  name: string;
  fullName: string;
  role: string;
  intro: string;
  context?: string;
  avatarUrl: string;
  maxSteps?: number;
  availableProviders?: string[];
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
}

interface UserProvider {
  providerId: string;
  providerType: string;
  displayName: string;
  models: Array<{
    modelId: string;
    modelString: string;
  }>;
  status: 'active' | 'error' | 'disabled';
}

interface App {
  appId: string;
  name: string;
  mcaId: string;
  description: string;
  category: string;
  status: string;
  icon?: string;
  color?: string;
}

interface AppWithAccess extends App {
  hasAccess: boolean;
}

interface Conversation {
  channelId: string;
  title: string;
  lastMessageAt?: string | null;
  lastMessageContent?: string;
  status?: 'active' | 'closed';
  unreadCount?: number;
  externalActionRequested?: boolean;
}

interface AgentWindowContentProps extends AgentWindowProps {
  windowId: string;
}

type TabId = 'conversations' | 'general' | 'context' | 'apps' | 'model';

export function AgentWindowContent({ windowId, agentId, workspaceId }: AgentWindowContentProps) {
  const router = useRouter();
  const client = getTerosClient();
  const { closeWindow, openWindow, findWindow, focusWindow } = useTilingStore();
  const { removeAgent } = useNavbarStore();

  const [activeTab, setActiveTab] = useState<TabId>('conversations');
  const [agent, setAgent] = useState<Agent | null>(null);
  const [apps, setApps] = useState<AppWithAccess[]>([]);
  const [providers, setProviders] = useState<UserProvider[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [totalActiveCount, setTotalActiveCount] = useState(0);
  const [totalInactiveCount, setTotalInactiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingApp, setRemovingApp] = useState<string | null>(null);
  const [showAddApp, setShowAddApp] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    name: '',
    fullName: '',
    role: '',
    intro: '',
    context: '',
    maxSteps: undefined as number | undefined,
  });
  const [saving, setSaving] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle avatar upload
  const handleAvatarUpload = async (file: File) => {
    if (!agent) return;

    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const backendUrl = client.getBackendBaseUrl();
      const response = await fetch(`${backendUrl}/api/upload/avatar/${agent.agentId}`, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (result.success && result.url) {
        setAgent((prev) => (prev ? { ...prev, avatarUrl: result.url } : null));
      } else {
        alert(result.error || 'Failed to upload avatar');
      }
    } catch (err) {
      console.error('Upload error:', err);
      alert('Failed to upload avatar');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert('File too large. Maximum size is 5MB');
        return;
      }
      handleAvatarUpload(file);
    }
    event.target.value = '';
  };

  const startEditing = () => {
    if (agent) {
      setEditForm({
        name: agent.name || '',
        fullName: agent.fullName || '',
        role: agent.role || '',
        intro: agent.intro || '',
        context: agent.context || '',
        maxSteps: agent.maxSteps || undefined,
      });
      setIsEditing(true);
    }
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditForm({ name: '', fullName: '', role: '', intro: '', context: '', maxSteps: undefined });
  };

  const saveAgent = async () => {
    if (!agent) return;

    setSaving(true);
    try {
      const updated = await client.updateAgent({
        agentId: agent.agentId,
        name: editForm.name,
        fullName: editForm.fullName,
        role: editForm.role,
        intro: editForm.intro,
        context: editForm.context,
        maxSteps: editForm.maxSteps,
      });

      setAgent({
        ...agent,
        name: updated.name,
        fullName: updated.fullName,
        role: updated.role,
        intro: updated.intro,
        context: updated.context,
        maxSteps: updated.maxSteps,
      });
      setIsEditing(false);
    } catch (err: any) {
      alert(`Failed to update agent: ${err?.message || 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteAgent = async () => {
    if (!agent) return;

    setDeleting(true);
    try {
      await client.deleteAgent(agent.agentId);
      // Remove from navbar
      removeAgent(agent.agentId);
      // Close this window and open launcher
      closeWindow(windowId);
      openWindow('launcher', {}, true, windowId);
    } catch (err: any) {
      alert(`Failed to delete agent: ${err?.message || 'Unknown error'}`);
      setDeleting(false);
    }
  };

  // Helper: check if conversation is inactive (no messages in last 3 hours)
  const isInactive = (conv: Conversation) => {
    if (conv.status === 'closed') return false;
    const lastActivity = conv.lastMessageAt;
    if (!lastActivity) return true;
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    return new Date(lastActivity).getTime() < threeHoursAgo;
  };

  const loadConversations = async () => {
    if (!agent) return;
    
    setLoadingConversations(true);
    try {
      const { channels } = await client.channel.list(workspaceId);
      
      // Filter conversations for this agent
      const agentConvs: Conversation[] = channels
        .filter((ch: any) => ch.agentId === agent.agentId)
        .map((ch: any) => ({
          channelId: ch.channelId,
          title: ch.metadata?.name || 'Chat',
          lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
          lastMessageContent: ch.lastMessage?.content || '',
          status: ch.status || 'active',
          unreadCount: ch.unreadCount || 0,
          externalActionRequested: ch.externalActionRequested || false,
        }));

      // Separate active and inactive
      const active = agentConvs.filter((c) => c.status === 'active' && !isInactive(c));
      const inactive = agentConvs.filter((c) => c.status === 'active' && isInactive(c));
      
      // Sort by most recent first
      active.sort((a, b) => {
        const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return bTime - aTime;
      });

      // Only keep top 10 active conversations
      const topActive = active.slice(0, 10);
      
      // Store conversations and counts
      setConversations(topActive);
      setTotalActiveCount(active.length);
      setTotalInactiveCount(inactive.length);
    } catch (err) {
      console.error('[AgentWindow] Error loading conversations:', err);
    } finally {
      setLoadingConversations(false);
    }
  };

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

    const existingWindow = findWindow('chat', (props) => props.channelId === conv.channelId);

    if (existingWindow) {
      focusWindow(existingWindow.id);
    } else {
      openWindow('chat', {
        channelId: conv.channelId,
        agentId: agent?.agentId,
        agentName: agent?.name,
      }, false, windowId);
    }
  };

  const handleNewConversation = () => {
    if (!agent) return;
    
    openWindow('chat', {
      agentId: agent.agentId,
      agentName: agent.name || agent.fullName,
    }, false, windowId);
  };

  const handleVoiceConversation = () => {
    if (!agent) return;
    
    openWindow('voice', {
      agentId: agent.agentId,
      agentName: agent.name || agent.fullName,
    }, false, windowId);
  };

  useEffect(() => {
    const loadAgent = async () => {
      if (!agentId) {
        setError('No agent ID provided');
        setLoading(false);
        return;
      }

      try {
        // Use workspaceId to find agents in the correct scope
        const agents = await client.agent.listAgents(workspaceId).then((r) => r.agents);
        const found = agents.find((a) => a.agentId === agentId);

        if (found) {
          setAgent(found);

          try {
            const [appsList, agentApps, providersList] = await Promise.all([
              workspaceId ? client.listWorkspaceApps(workspaceId) : client.app.listApps().then((r) => r.apps),
              client.getAgentApps(found.agentId),
              client.provider.list(),
            ]);

            const accessSet = new Set(agentApps.map((a: any) => a.appId));
            const appsWithAccess: AppWithAccess[] = appsList.map((app: App) => ({
              ...app,
              hasAccess: accessSet.has(app.appId),
            }));

            setApps(appsWithAccess);
            setProviders(providersList.providers.filter((p: UserProvider) => p.status === 'active'));
          } catch (e) {
            console.error('Failed to load apps:', e);
          }
        } else {
          setError(`Agent not found: ${agentId}`);
        }
      } catch (err) {
        console.error('Failed to load agent:', err);
        setError(err instanceof Error ? err.message : 'Failed to load agent');
      } finally {
        setLoading(false);
      }
    };

    if (client.isConnected()) {
      loadAgent();
    } else {
      const onConnected = () => {
        loadAgent();
        client.off('connected', onConnected);
      };
      client.on('connected', onConnected);
      return () => {
        client.off('connected', onConnected);
      };
    }
  }, [agentId, workspaceId, client]);

  // Load conversations when switching to conversations tab
  useEffect(() => {
    if (activeTab === 'conversations' && agent && conversations.length === 0) {
      loadConversations();
    }
  }, [activeTab, agent]);

  if (loading) {
    return (
      <FullscreenLoader label="Loading agent..." />
    );
  }

  if (error) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" padding={16}>
        <Text color="#ef4444" textAlign="center">
          {error}
        </Text>
      </YStack>
    );
  }

  const renderAppCard = (app: AppWithAccess) => (
    <XStack
      key={app.appId}
      backgroundColor="#111"
      borderRadius={8}
      padding={12}
      borderWidth={1}
      borderColor="#1a1a1a"
      alignItems="center"
      gap={12}
      hoverStyle={{
        backgroundColor: '#151515',
        borderColor: '#222',
      }}
    >
      <YStack
        width={32}
        height={32}
        borderRadius={6}
        backgroundColor={app.color || '#222'}
        justifyContent="center"
        alignItems="center"
        overflow="hidden"
      >
        {(() => {
          if (app.icon && app.icon.startsWith('http')) {
            return (
              <img
                src={app.icon}
                alt={app.name}
                style={{ width: 20, height: 20, objectFit: 'contain' }}
              />
            );
          }
          if (app.icon && app.icon.length <= 2) {
            return <Text fontSize={16}>{app.icon}</Text>;
          }
          const IconComponent = app.icon ? iconMap[app.icon] : null;
          if (IconComponent) {
            return <IconComponent size={16} color="white" />;
          }
          return (
            <Text color="white" fontSize={14} fontWeight="600">
              {app.name.charAt(0).toUpperCase()}
            </Text>
          );
        })()}
      </YStack>
      <YStack flex={1} minWidth={0}>
        <Text fontSize={12} fontWeight="500" color="#ccc" numberOfLines={1}>
          {app.name}
        </Text>
        <Text fontSize={11} color="#888" numberOfLines={1}>
          {app.description}
        </Text>
      </YStack>
      <Button
        size="$2"
        circular
        backgroundColor="transparent"
        disabled={removingApp === app.appId}
        opacity={removingApp === app.appId ? 0.5 : 1}
        icon={<X size={16} color="#ef4444" />}
        onPress={async () => {
          if (!agent) return;
          setRemovingApp(app.appId);
          try {
            await client.app.revokeAccess(agent.agentId, app.appId);
            setApps((prev) =>
              prev.map((a) => (a.appId === app.appId ? { ...a, hasAccess: false } : a)),
            );
          } catch (err) {
            console.error('Failed to remove app access:', err);
          } finally {
            setRemovingApp(null);
          }
        }}
        hoverStyle={{
          backgroundColor: '$red2',
        }}
      />
    </XStack>
  );

  const renderConversationItem = (conv: Conversation) => {
    const hasUnread = conv.unreadCount && conv.unreadCount > 0;
    const externalActionRequested = conv.externalActionRequested || false;

    return (
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
        onPress={() => handleSelectConversation(conv)}
      >
        <YStack flex={1} gap={2}>
          <Text fontSize={12} fontWeight="500" color="#ccc" numberOfLines={1}>
            {conv.title}
          </Text>
          {conv.lastMessageContent && (
            <Text fontSize={11} color="#666" numberOfLines={1}>
              {conv.lastMessageContent}
            </Text>
          )}
          {conv.lastMessageAt && (
            <Text fontSize={9} color="#555">
              {new Date(conv.lastMessageAt).toLocaleDateString()}
            </Text>
          )}
        </YStack>
        
        {/* Status indicators */}
        <XStack gap={6} alignItems="center">
          {/* Red dot: external action requested (awaiting human or other agent) */}
          {externalActionRequested && (
            <Circle size={8} backgroundColor="#ef4444" />
          )}
          
          {/* Blue dot: has unread content */}
          {!externalActionRequested && hasUnread && (
            <Circle size={8} backgroundColor="#06B6D4" />
          )}
        </XStack>
      </XStack>
    );
  };

  const tabs: Array<{ id: TabId; label: string; icon: any }> = [
    { id: 'conversations', label: 'Conversations', icon: MessageSquare },
    { id: 'general', label: 'General', icon: User },
    { id: 'context', label: 'Context', icon: Settings },
    { id: 'apps', label: 'Apps', icon: Package },
    { id: 'model', label: 'Model', icon: Bot },
  ];

  return (
    <YStack flex={1} backgroundColor="#0a0a0a">
      {agent && (
        <>
          {/* Header */}
          <YStack
            backgroundColor="#111"
            borderBottomWidth={1}
            borderBottomColor="#1a1a1a"
            padding={16}
            gap={12}
          >
            <XStack alignItems="center" gap={12}>
              {Platform.OS === 'web' && (
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                />
              )}
              <YStack
                width={48}
                height={48}
                borderRadius={24}
                overflow="hidden"
                backgroundColor={agent.avatarUrl ? '#1a1a1a' : '#1a1a1a'}
                justifyContent="center"
                alignItems="center"
                cursor="pointer"
                position="relative"
                opacity={uploadingAvatar ? 0.6 : 1}
                hoverStyle={{ opacity: 0.8 }}
                onPress={() => {
                  if (Platform.OS === 'web' && fileInputRef.current) {
                    fileInputRef.current.click();
                  }
                }}
              >
                {agent.avatarUrl ? (
                  <img
                    src={agent.avatarUrl}
                    alt={agent.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Bot size={24} color="#06B6D4" />
                )}
                <YStack
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  backgroundColor="rgba(0,0,0,0.5)"
                  justifyContent="center"
                  alignItems="center"
                  opacity={0}
                  hoverStyle={{ opacity: 1 }}
                >
                  {uploadingAvatar ? (
                    <AppSpinner size="sm" variant="onDark" />
                  ) : (
                    <Camera size={16} color="white" />
                  )}
                </YStack>
              </YStack>

              <YStack flex={1}>
                <Text fontSize={16} fontWeight="700" color="#fff">
                  {agent.fullName || agent.name}
                </Text>
                <Text fontSize={12} color="#888" fontWeight="500">
                  {agent.role}
                </Text>
              </YStack>

              <XStack gap={8}>
                <Button
                  size="$3"
                  backgroundColor="#0891B2"
                  color="white"
                  paddingHorizontal={16}
                  paddingVertical={8}
                  borderRadius={6}
                  icon={<MessageSquare size={16} />}
                  onPress={handleNewConversation}
                  hoverStyle={{ backgroundColor: '#06B6D4' }}
                  pressStyle={{ backgroundColor: '#0e7490' }}
                >
                  <Text color="white" fontSize={13} fontWeight="600">
                    Chat
                  </Text>
                </Button>

                <Button
                  size="$3"
                  backgroundColor="#8B5CF6"
                  color="white"
                  paddingHorizontal={16}
                  paddingVertical={8}
                  borderRadius={6}
                  icon={<Mic size={16} />}
                  onPress={handleVoiceConversation}
                  hoverStyle={{ backgroundColor: '#9F7AEA' }}
                  pressStyle={{ backgroundColor: '#7C3AED' }}
                >
                  <Text color="white" fontSize={13} fontWeight="600">
                    Voice
                  </Text>
                </Button>
              </XStack>
            </XStack>

            {/* Info Banner */}
            <YStack
              backgroundColor="rgba(8, 145, 178, 0.1)"
              borderRadius={6}
              padding={10}
              borderWidth={1}
              borderColor="rgba(8, 145, 178, 0.3)"
            >
              <Text fontSize={12} color="#06B6D4">
                Configure this agent's settings, manage conversations, and assign tools.
              </Text>
            </YStack>
          </YStack>

          {/* Tabs */}
          <YStack
            backgroundColor="#0a0a0a"
            borderBottomWidth={1}
            borderBottomColor="#1a1a1a"
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <XStack paddingHorizontal={16}>
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <XStack
                      key={tab.id}
                      paddingVertical={12}
                      paddingHorizontal={16}
                      gap={8}
                      alignItems="center"
                      cursor="pointer"
                      borderBottomWidth={2}
                      borderBottomColor={isActive ? '#0891B2' : 'transparent'}
                      opacity={isActive ? 1 : 0.6}
                      hoverStyle={{ opacity: 1, backgroundColor: '#111' }}
                      onPress={() => setActiveTab(tab.id)}
                    >
                      <Icon size={14} color={isActive ? '#06B6D4' : '#888'} />
                      <Text
                        fontSize={12}
                        fontWeight={isActive ? '600' : '500'}
                        color={isActive ? '#06B6D4' : '#888'}
                      >
                        {tab.label}
                      </Text>
                    </XStack>
                  );
                })}
              </XStack>
            </ScrollView>
          </YStack>

          {/* Tab Content */}
          <ScrollView flexGrow={1} flexShrink={1}>
            <YStack padding={16} gap={16}>
              {/* Conversations Tab */}
              {activeTab === 'conversations' && (
                <YStack gap={12}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <Text fontSize={14} fontWeight="600" color="#fff">
                      Recent Conversations
                    </Text>
                    {totalActiveCount > 0 && (
                      <Text fontSize={11} color="#888">
                        Mostrando {conversations.length} de {totalActiveCount}
                      </Text>
                    )}
                  </XStack>

                  {loadingConversations ? (
                    <YStack padding={32} alignItems="center">
                      <AppSpinner size="lg" variant="brand" />
                      <Text color="#888" marginTop={12}>
                        Loading conversations...
                      </Text>
                    </YStack>
                  ) : conversations.length === 0 ? (
                    <YStack
                      padding={32}
                      alignItems="center"
                      backgroundColor="#111"
                      borderRadius={8}
                      borderWidth={1}
                      borderColor="#1a1a1a"
                      gap={12}
                    >
                      <MessageSquare size={48} color="#555" />
                      <Text fontSize={14} fontWeight="600" color="#888">
                        No conversations yet
                      </Text>
                      <Text fontSize={12} color="#666" textAlign="center">
                        Start a new conversation with this agent using the button above.
                      </Text>
                    </YStack>
                  ) : (
                    <YStack gap={8}>
                      {conversations.map(renderConversationItem)}
                      
                      {/* Show more button if there are more active conversations */}
                      {totalActiveCount > 10 && (
                        <XStack
                          padding={12}
                          alignItems="center"
                          justifyContent="center"
                          backgroundColor="#111"
                          borderRadius={6}
                          borderWidth={1}
                          borderColor="#1a1a1a"
                          cursor="pointer"
                          hoverStyle={{ backgroundColor: '#151515', borderColor: '#222' }}
                          onPress={() => {
                            openWindow('conversations', {}, false, windowId);
                          }}
                        >
                          <Text fontSize={12} color="#06B6D4" fontWeight="500">
                            Ver {totalActiveCount - 10} more active conversations
                          </Text>
                        </XStack>
                      )}
                      
                      {/* Show inactive count if there are any */}
                      {totalInactiveCount > 0 && (
                        <XStack
                          padding={12}
                          alignItems="center"
                          justifyContent="center"
                          backgroundColor="#111"
                          borderRadius={6}
                          borderWidth={1}
                          borderColor="#1a1a1a"
                          cursor="pointer"
                          hoverStyle={{ backgroundColor: '#151515', borderColor: '#222' }}
                          onPress={() => {
                            openWindow('conversations', {}, false, windowId);
                          }}
                        >
                          <Text fontSize={12} color="#888" fontWeight="500">
                            {totalInactiveCount} inactive conversation{totalInactiveCount !== 1 ? 's' : ''} (view all)
                          </Text>
                        </XStack>
                      )}
                    </YStack>
                  )}
                </YStack>
              )}

              {/* General Tab */}
              {activeTab === 'general' && (
                <YStack gap={16}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <Text fontSize={14} fontWeight="600" color="#fff">
                      General Information
                    </Text>
                    {!isEditing ? (
                      <XStack gap={8}>
                        <Button
                          size="$2"
                          backgroundColor="#0891B2"
                          color="white"
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          icon={<Edit3 size={14} />}
                          onPress={startEditing}
                          hoverStyle={{ backgroundColor: '#06B6D4' }}
                        >
                          <Text color="white" fontSize={12} fontWeight="600">
                            Edit
                          </Text>
                        </Button>
                        <Button
                          size="$2"
                          backgroundColor="#ef4444"
                          color="white"
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          icon={<Trash2 size={14} />}
                          onPress={() => setShowDeleteConfirm(true)}
                          hoverStyle={{ backgroundColor: '#dc2626' }}
                        >
                          <Text color="white" fontSize={12} fontWeight="600">
                            Delete
                          </Text>
                        </Button>
                      </XStack>
                    ) : (
                      <XStack gap={8}>
                        <Button
                          size="$2"
                          backgroundColor="#222"
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          onPress={cancelEditing}
                          disabled={saving}
                          hoverStyle={{ backgroundColor: '#333' }}
                        >
                          <Text color="#ccc" fontSize={12} fontWeight="600">
                            Cancel
                          </Text>
                        </Button>
                        <Button
                          size="$2"
                          backgroundColor="#10B981"
                          color="white"
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          onPress={saveAgent}
                          disabled={saving}
                          icon={saving ? <AppSpinner size="sm" /> : <Save size={14} />}
                          hoverStyle={{ backgroundColor: '#059669' }}
                        >
                          <Text color="white" fontSize={12} fontWeight="600">
                            {saving ? 'Saving...' : 'Save'}
                          </Text>
                        </Button>
                      </XStack>
                    )}
                  </XStack>

                  {isEditing ? (
                    <YStack gap={12}>
                      <YStack gap={6}>
                        <Text fontSize={11} color="#888" fontWeight="600">
                          NAME
                        </Text>
                        <Input
                          placeholder="Name (e.g., Alice)"
                          value={editForm.name}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, name: text }))
                          }
                          backgroundColor="#111"
                          borderColor="#1a1a1a"
                          color="#ccc"
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color="#888" fontWeight="600">
                          FULL NAME
                        </Text>
                        <Input
                          placeholder="Full Name (e.g., Alice Evergreen)"
                          value={editForm.fullName}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, fullName: text }))
                          }
                          backgroundColor="#111"
                          borderColor="#1a1a1a"
                          color="#ccc"
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color="#888" fontWeight="600">
                          ROLE
                        </Text>
                        <Input
                          placeholder="Role (e.g., Personal Assistant)"
                          value={editForm.role}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, role: text }))
                          }
                          backgroundColor="#111"
                          borderColor="#1a1a1a"
                          color="#ccc"
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color="#888" fontWeight="600">
                          INTRODUCTION
                        </Text>
                        <TextArea
                          placeholder="Agent introduction and description..."
                          value={editForm.intro}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, intro: text }))
                          }
                          numberOfLines={4}
                          minHeight={100}
                          backgroundColor="#111"
                          borderColor="#1a1a1a"
                          color="#ccc"
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color="#888" fontWeight="600">
                          MAX STEPS
                        </Text>
                        <Input
                          placeholder="20 (default, 0 = unlimited)"
                          value={editForm.maxSteps === undefined ? '' : editForm.maxSteps.toString()}
                          onChangeText={(text: string) => {
                            if (text === '') {
                              setEditForm((prev) => ({ ...prev, maxSteps: undefined }));
                            } else {
                              const num = parseInt(text, 10);
                              setEditForm((prev) => ({
                                ...prev,
                                maxSteps: isNaN(num) ? undefined : num,
                              }));
                            }
                          }}
                          keyboardType="numeric"
                          backgroundColor="#111"
                          borderColor="#1a1a1a"
                          color="#ccc"
                          fontSize={13}
                        />
                      </YStack>
                    </YStack>
                  ) : (
                    <YStack gap={12}>
                      <YStack gap={6}>
                        <Text fontSize={11} color="#666" fontWeight="600">
                          NAME
                        </Text>
                        <Text fontSize={13} color="#ccc">
                          {agent.name}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor="#1a1a1a" />

                      <YStack gap={6}>
                        <Text fontSize={11} color="#666" fontWeight="600">
                          FULL NAME
                        </Text>
                        <Text fontSize={13} color="#ccc">
                          {agent.fullName}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor="#1a1a1a" />

                      <YStack gap={6}>
                        <Text fontSize={11} color="#666" fontWeight="600">
                          ROLE
                        </Text>
                        <Text fontSize={13} color="#ccc">
                          {agent.role}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor="#1a1a1a" />

                      <YStack gap={6}>
                        <Text fontSize={11} color="#666" fontWeight="600">
                          INTRODUCTION
                        </Text>
                        <Text fontSize={13} color="#ccc" lineHeight={20}>
                          {agent.intro}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor="#1a1a1a" />

                      <YStack gap={6}>
                        <Text fontSize={11} color="#666" fontWeight="600">
                          MAX STEPS
                        </Text>
                        <Text fontSize={13} color="#ccc">
                          {agent.maxSteps === 0 ? '∞ (Unlimited)' : agent.maxSteps || 20}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor="#1a1a1a" />

                      <YStack gap={6}>
                        <Text fontSize={11} color="#666" fontWeight="600">
                          AGENT ID
                        </Text>
                        <Text fontSize={11} color="#555" fontFamily="$mono">
                          {agent.agentId}
                        </Text>
                      </YStack>
                    </YStack>
                  )}
                </YStack>
              )}

              {/* Context Tab */}
              {activeTab === 'context' && (
                <YStack gap={16}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <H2 fontSize={14} color="#ccc">
                      System Context
                    </H2>
                    {!isEditing ? (
                      <Button
                        size="$3"
                        backgroundColor="#0891B2"
                        color="white"
                        icon={<Edit3 size={16} />}
                        onPress={startEditing}
                      >
                        Edit
                      </Button>
                    ) : (
                      <XStack gap={8}>
                        <Button
                          size="$3"
                          backgroundColor="#222"
                          onPress={cancelEditing}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="$3"
                          backgroundColor="#10B981"
                          color="white"
                          onPress={saveAgent}
                          disabled={saving}
                          icon={saving ? <AppSpinner size="sm" /> : <Save size={16} />}
                        >
                          {saving ? 'Saving...' : 'Save'}
                        </Button>
                      </XStack>
                    )}
                  </XStack>

                  <YStack
                    backgroundColor="rgba(8, 145, 178, 0.1)"
                    borderRadius={6}
                    padding={12}
                    borderWidth={1}
                    borderColor="rgba(8, 145, 178, 0.3)"
                  >
                    <Text fontSize={11} color="#06B6D4">
                      The system context is injected into every conversation with this agent. Use it
                      to provide persistent instructions, guidelines, or knowledge.
                    </Text>
                  </YStack>

                  {isEditing ? (
                    <YStack gap={8}>
                      <TextArea
                        placeholder="Enter system context (supports Markdown)..."
                        value={editForm.context}
                        onChangeText={(text: string) =>
                          setEditForm((prev) => ({ ...prev, context: text }))
                        }
                        numberOfLines={15}
                        minHeight={300}
                        fontFamily="$mono"
                        fontSize={12}
                      />
                    </YStack>
                  ) : (
                    <YStack
                      backgroundColor="#111"
                      borderRadius={8}
                      padding={16}
                      borderWidth={1}
                      borderColor="#1a1a1a"
                      minHeight={300}
                    >
                      {agent.context ? (
                        <Text
                          fontSize={12}
                          color="#ccc"
                          lineHeight="$4"
                          fontFamily="$mono"
                          whiteSpace="pre-wrap"
                        >
                          {agent.context}
                        </Text>
                      ) : (
                        <Text fontSize={12} color="#666" fontStyle="italic">
                          No system context configured
                        </Text>
                      )}
                    </YStack>
                  )}
                </YStack>
              )}

              {/* Apps Tab */}
              {activeTab === 'apps' && (
                <YStack gap={12}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <XStack alignItems="center" gap={8}>
                      <H2 fontSize={14} color="#ccc">
                        Apps
                      </H2>
                      {apps.filter((a) => a.hasAccess).length > 0 && (
                        <YStack
                          backgroundColor="#0891B2"
                          paddingHorizontal={8}
                          paddingVertical={4}
                          borderRadius={6}
                        >
                          <Text color="#06B6D4" fontSize={11} fontWeight="600">
                            {apps.filter((a) => a.hasAccess).length}
                          </Text>
                        </YStack>
                      )}
                    </XStack>
                    <Button
                      size="$3"
                      backgroundColor="#0891B2"
                      color="white"
                      icon={<Plus size={16} />}
                      onPress={() => setShowAddApp(true)}
                    >
                      Add App
                    </Button>
                  </XStack>

                  {(() => {
                    const sortedApps = apps
                      .filter((a) => a.hasAccess)
                      .sort((a, b) => a.name.localeCompare(b.name));

                    if (sortedApps.length === 0) {
                      return (
                        <YStack
                          padding="$8"
                          alignItems="center"
                          backgroundColor="#111"
                          borderRadius={8}
                          borderWidth={1}
                          borderColor="#1a1a1a"
                          gap={12}
                        >
                          <Package size={48} color="#555" />
                          <Text fontSize={13} fontWeight="600" color="#888">
                            No apps assigned
                          </Text>
                          <Text fontSize={12} color="#666" textAlign="center">
                            Add apps to give this agent access to tools and capabilities.
                          </Text>
                        </YStack>
                      );
                    }

                    const midpoint = Math.ceil(sortedApps.length / 2);
                    const leftColumn = sortedApps.slice(0, midpoint);
                    const rightColumn = sortedApps.slice(midpoint);

                    return (
                      <XStack gap={8}>
                        <YStack flex={1} gap={8}>
                          {leftColumn.map(renderAppCard)}
                        </YStack>
                        {rightColumn.length > 0 && (
                          <YStack flex={1} gap={8}>
                            {rightColumn.map(renderAppCard)}
                          </YStack>
                        )}
                      </XStack>
                    );
                  })()}
                </YStack>
              )}

              {/* Model Tab */}
              {activeTab === 'model' && (
                <YStack gap={16}>
                  <H2 fontSize={14} color="#ccc">
                    LLM Model
                  </H2>

                  <Text fontSize={12} color="#888">
                    Select which model this agent should use. Each agent requires a configured
                    provider.
                  </Text>

                  {providers.length === 0 ? (
                    <YStack
                      backgroundColor="$red2"
                      borderRadius={8}
                      padding={16}
                      gap={12}
                      borderWidth={1}
                      borderColor="$red5"
                    >
                      <Text fontSize={13} fontWeight="600" color="#ef4444">
                        No Providers Configured
                      </Text>
                      <Text fontSize={12} color="#888">
                        You need to configure at least one LLM provider to use this agent.
                      </Text>
                      <Text fontSize={12} color="#888">
                        Go to <Text fontWeight="600" color="#ccc">Mis Providers</Text> in the sidebar to add a provider
                        (Anthropic, OpenAI, etc.).
                      </Text>
                    </YStack>
                  ) : (
                    <>
                      {!agent.selectedModelId && (
                        <YStack
                          backgroundColor="rgba(251, 191, 36, 0.1)"
                          borderRadius={6}
                          padding={12}
                          borderWidth={1}
                          borderColor="rgba(251, 191, 36, 0.3)"
                        >
                          <Text fontSize={12} color="#fbbf24">
                            ⚠️ No model selected. Please select a model from your configured
                            providers below.
                          </Text>
                        </YStack>
                      )}

                      <YStack gap={12}>
                        {providers.map((provider) => (
                          <YStack key={provider.providerId} gap={8}>
                            <Text fontSize={12} fontWeight="600" color="#888" marginTop={8}>
                              {provider.displayName}
                            </Text>
                            {provider.models.map((model) => {
                              const isSelected = agent.selectedModelId === model.modelId;
                              const providerColor =
                                provider.providerType === 'anthropic-oauth' ||
                                provider.providerType === 'anthropic'
                                  ? '#f97316'
                                  : provider.providerType === 'openai'
                                    ? '#10B981'
                                    : '#a855f7';
                              return (
                                <XStack
                                  key={model.modelId}
                                  padding={12}
                                  backgroundColor={isSelected ? '#0a2a1a' : '#111'}
                                  borderRadius={6}
                                  borderWidth={1}
                                  borderColor={isSelected ? '#10B981' : '#1a1a1a'}
                                  alignItems="center"
                                  gap={12}
                                  cursor="pointer"
                                  hoverStyle={{ backgroundColor: isSelected ? '#0a3a2a' : '#151515' }}
                                  pressStyle={{ opacity: 0.8 }}
                                  onPress={async () => {
                                    if (isSelected) return;
                                    setSavingProvider(true);
                                    try {
                                      await client.updateAgent({
                                        agentId: agent.agentId,
                                        availableProviders: [provider.providerId],
                                        selectedProviderId: provider.providerId,
                                        selectedModelId: model.modelId,
                                      });
                                      setAgent({
                                        ...agent,
                                        availableProviders: [provider.providerId],
                                        selectedProviderId: provider.providerId,
                                        selectedModelId: model.modelId,
                                      });
                                    } catch (err) {
                                      console.error('Failed to update model:', err);
                                    } finally {
                                      setSavingProvider(false);
                                    }
                                  }}
                                >
                                  <YStack
                                    width={8}
                                    height={8}
                                    borderRadius={4}
                                    backgroundColor={providerColor}
                                  />
                                  <YStack flex={1}>
                                    <Text fontSize={12} fontWeight="500" color="#ccc">
                                      {model.modelId}
                                    </Text>
                                    <Text fontSize={11} color="#888" fontFamily="$mono">
                                      {model.modelString}
                                    </Text>
                                  </YStack>
                                  {isSelected && (
                                    <YStack
                                      backgroundColor="#10B981"
                                      paddingHorizontal={8}
                                      paddingVertical={4}
                                      borderRadius={4}
                                    >
                                      <Text fontSize={11} color="white" fontWeight="600">
                                        Active
                                      </Text>
                                    </YStack>
                                  )}
                                  {savingProvider && (
                                    <AppSpinner size="sm" variant="brand" />
                                  )}
                                </XStack>
                              );
                            })}
                          </YStack>
                        ))}
                      </YStack>
                    </>
                  )}
                </YStack>
              )}
            </YStack>
          </ScrollView>

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
              animation="lazy"
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
              backgroundColor="rgba(0, 0, 0, 0.5)"
            />
            <Sheet.Frame backgroundColor="$background" padding={16} gap={16}>
              <Sheet.Handle />

              <XStack justifyContent="space-between" alignItems="center">
                <Text fontSize={14} fontWeight="600" color="#ccc">
                  Add App
                </Text>
                <Button
                  size="$2"
                  circular
                  backgroundColor="transparent"
                  icon={<X size={18} color="#888" />}
                  onPress={() => setShowAddApp(false)}
                />
              </XStack>

              <XStack
                backgroundColor="#111"
                borderRadius={6}
                paddingHorizontal={12}
                paddingVertical={8}
                alignItems="center"
                gap={8}
                borderWidth={1}
                borderColor="#1a1a1a"
              >
                <Search size={18} color="#666" />
                <Input
                  flex={1}
                  placeholder="Search apps..."
                  backgroundColor="transparent"
                  borderWidth={0}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                />
              </XStack>

              <ScrollView maxHeight={400}>
                <YStack gap={8}>
                  {apps
                    .filter((a) => !a.hasAccess)
                    .filter(
                      (a) =>
                        searchQuery === '' ||
                        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        a.description.toLowerCase().includes(searchQuery.toLowerCase()),
                    )
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((app) => (
                      <XStack
                        key={app.appId}
                        backgroundColor="#111"
                        borderRadius={6}
                        padding={12}
                        borderWidth={1}
                        borderColor="#1a1a1a"
                        alignItems="center"
                        gap={12}
                        cursor="pointer"
                        hoverStyle={{
                          backgroundColor: '#151515',
                          borderColor: '#0891B2',
                        }}
                        onPress={async () => {
                          if (!agent) return;
                          try {
                            await client.app.grantAccess(agent.agentId, app.appId);
                            setApps((prev) =>
                              prev.map((a) => (a.appId === app.appId ? { ...a, hasAccess: true } : a)),
                            );
                          } catch (err) {
                            console.error('Failed to add app access:', err);
                          }
                        }}
                      >
                        <YStack
                          width={32}
                          height={32}
                          borderRadius={6}
                          backgroundColor={app.color || '#222'}
                          justifyContent="center"
                          alignItems="center"
                          overflow="hidden"
                        >
                          {(() => {
                            if (app.icon && app.icon.startsWith('http')) {
                              return (
                                <img
                                  src={app.icon}
                                  alt={app.name}
                                  style={{ width: 20, height: 20, objectFit: 'contain' }}
                                />
                              );
                            }
                            if (app.icon && app.icon.length <= 2) {
                              return <Text fontSize={16}>{app.icon}</Text>;
                            }
                            const IconComponent = app.icon ? iconMap[app.icon] : null;
                            if (IconComponent) {
                              return <IconComponent size={16} color="white" />;
                            }
                            return (
                              <Text color="white" fontSize={14} fontWeight="600">
                                {app.name.charAt(0).toUpperCase()}
                              </Text>
                            );
                          })()}
                        </YStack>
                        <YStack flex={1}>
                          <Text fontSize={12} fontWeight="500" color="#ccc">
                            {app.name}
                          </Text>
                          <Text fontSize={11} color="#888" numberOfLines={1}>
                            {app.description}
                          </Text>
                        </YStack>
                        <Plus size={18} color="#06B6D4" />
                      </XStack>
                    ))}
                  {apps
                    .filter((a) => !a.hasAccess)
                    .filter(
                      (a) =>
                        searchQuery === '' || a.name.toLowerCase().includes(searchQuery.toLowerCase()),
                    ).length === 0 && (
                    <Text color="#666" textAlign="center" padding={16}>
                      {searchQuery ? 'No apps found' : 'All apps are already assigned'}
                    </Text>
                  )}
                </YStack>
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
              animation="lazy"
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
              backgroundColor="rgba(0, 0, 0, 0.5)"
            />
            <Sheet.Frame backgroundColor="$background" padding={16} gap={16}>
              <Sheet.Handle />

              <YStack gap={12} alignItems="center">
                <YStack
                  width={60}
                  height={60}
                  borderRadius={30}
                  backgroundColor="$red2"
                  justifyContent="center"
                  alignItems="center"
                >
                  <Trash2 size={30} color="#ef4444" />
                </YStack>

                <Text fontSize={14} fontWeight="600" color="#ccc" textAlign="center">
                  Delete Agent?
                </Text>

                <Text fontSize={12} color="#888" textAlign="center">
                  Are you sure you want to delete "{agent.fullName || agent.name}"? This action
                  cannot be undone.
                </Text>

                <XStack gap={12} marginTop={8}>
                  <Button
                    flex={1}
                    size="$4"
                    onPress={() => setShowDeleteConfirm(false)}
                    disabled={deleting}
                    backgroundColor="#222"
                  >
                    Cancel
                  </Button>
                  <Button
                    flex={1}
                    size="$4"
                    onPress={deleteAgent}
                    disabled={deleting}
                    backgroundColor="#ef4444"
                    color="white"
                    icon={deleting ? <AppSpinner size="sm" /> : undefined}
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </Button>
                </XStack>
              </YStack>
            </Sheet.Frame>
          </Sheet>
        </>
      )}
    </YStack>
  );
}
