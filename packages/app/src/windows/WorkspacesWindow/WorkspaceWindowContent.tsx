/**
 * Workspace Window Content
 *
 * Shows details of a single workspace: volume, apps, agents, members.
 */

import * as LucideIcons from '@tamagui/lucide-icons';
import {
  Archive,
  Bot,
  Box,
  Check,
  Crown,
  Download,
  Edit2,
  FileText,
  Folder,
  HardDrive,
  MessageCircle,
  Package,
  Palette,
  Plus,
  Settings,
  Users,
  X,
} from '@tamagui/lucide-icons';
import {
  COLOR_PALETTE,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  type WorkspaceColor,
} from '@teros/shared';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Image,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { AppCard } from '../../components/AppCard';
import type { AppAuthInfo } from '../../components/apps';
import { useToast } from '../../components/Toast';
import { WorkspaceIcon } from '../../components/WorkspaceIcon';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import { useTilingStore } from '../../store/tilingStore';
import type { WorkspaceWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

interface WorkspaceDetails {
  workspaceId: string;
  name: string;
  description?: string;
  context?: string;
  volumeId: string;
  ownerId: string;
  members: Array<{
    userId: string;
    role: 'admin' | 'write' | 'read';
    addedAt: string;
    addedBy: string;
  }>;
  settings: {
    defaultBranch?: string;
  };
  appearance?: {
    color?: string;
    icon?: string;
  };
  role: 'owner' | 'admin' | 'write' | 'read';
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceApp {
  appId: string;
  name: string;
  mcaId: string;
  mcaName: string;
  description: string;
  icon?: string;
  color?: string;
  category: string;
  status: 'active' | 'disabled';
}

interface WorkspaceAgent {
  agentId: string;
  name: string;
  fullName: string;
  role: string;
  intro: string;
  avatarUrl?: string;
  coreId?: string;
}

interface AgentCore {
  coreId: string;
  name: string;
  fullName: string;
  version: string;
  personality: string[];
  capabilities: string[];
  avatarUrl?: string;
  status: string;
}

interface WorkspaceChannel {
  channelId: string;
  agentId: string;
  status: 'active' | 'closed';
  metadata: {
    name?: string;
  };
  createdAt: string;
  updatedAt: string;
  lastMessage?: {
    content: string;
    timestamp: string;
    role?: 'user' | 'assistant';
  };
  unreadCount?: number;
}

interface CatalogMca {
  mcaId: string;
  name: string;
  description: string;
  icon?: string;
  color?: string;
  category: string;
  tools: string[];
  availability: {
    enabled: boolean;
    multi: boolean;
    system: boolean;
  };
}

// Role display info
const roleInfo: Record<string, { label: string; color: string; icon: any }> = {
  owner: { label: 'Propietario', color: '#FFD700', icon: Crown },
  admin: { label: 'Admin', color: '#9B59B6', icon: Settings },
  write: { label: 'Editor', color: '#3498DB', icon: Edit2 },
  read: { label: 'Lector', color: '#95A5A6', icon: Users },
};

type TabType = 'conversations' | 'agents' | 'apps';
type ModalType = 'none' | 'install-app' | 'edit-appearance' | 'edit-context';

interface WorkspaceWindowContentProps extends WorkspaceWindowProps {
  windowId: string;
}

export function WorkspaceWindowContent({ windowId, workspaceId }: WorkspaceWindowContentProps) {
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
  const [workspaceApps, setWorkspaceApps] = useState<WorkspaceApp[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgent[]>([]);
  const [workspaceChannels, setWorkspaceChannels] = useState<WorkspaceChannel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingApps, setIsLoadingApps] = useState(false);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('conversations');
  const [activeModal, setActiveModal] = useState<ModalType>('none');
  const [authStatuses, setAuthStatuses] = useState<Record<string, AppAuthInfo | null>>({});
  const [loadingAuthStatus, setLoadingAuthStatus] = useState<Record<string, boolean>>({});

  // Create agent modal state

  // Install app modal state
  const [catalog, setCatalog] = useState<CatalogMca[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [installingMcaId, setInstallingMcaId] = useState<string | null>(null);

  // Edit appearance modal state
  const [selectedColor, setSelectedColor] = useState<string>('amber');
  const [selectedIcon, setSelectedIcon] = useState<string>('folder');
  const [savingAppearance, setSavingAppearance] = useState(false);

  // Edit context modal state
  const [contextText, setContextText] = useState<string>('');
  const [savingContext, setSavingContext] = useState(false);

  const client = getTerosClient();
  const toast = useToast();
  const { closeWindow, updateWindowProps, openWindow } = useTilingStore();
  const { shouldOpenInNewTab } = useClickModifiers();

  // Load workspace details on mount
  useEffect(() => {
    const loadData = async () => {
      if (!workspaceId) return;

      setIsLoading(true);
      try {
        const data = await client.getWorkspace(workspaceId);
        setWorkspace(data);
        updateWindowProps(windowId, { name: data.name });
        loadWorkspaceChannels(workspaceId);
        loadWorkspaceApps(workspaceId);
        loadWorkspaceAgents(workspaceId);
      } catch (err: any) {
        console.error('Error loading workspace:', err);
        toast.error('Error', 'No se pudo cargar el workspace');
      } finally {
        setIsLoading(false);
      }
    };

    if (client.isConnected()) {
      loadData();
    } else {
      const onConnected = () => {
        client.off('connected', onConnected);
        loadData();
      };
      client.on('connected', onConnected);
      return () => client.off('connected', onConnected);
    }
  }, [workspaceId]);

  const loadWorkspaceApps = async (wsId: string) => {
    setIsLoadingApps(true);
    try {
      const apps = await client.listWorkspaceApps(wsId);
      setWorkspaceApps(apps);
      loadAllAuthStatuses(apps);
    } catch (err: any) {
      console.error('Error loading workspace apps:', err);
    } finally {
      setIsLoadingApps(false);
    }
  };

  const loadWorkspaceAgents = async (wsId: string) => {
    setIsLoadingAgents(true);
    try {
      const agents = await client.agent.listAgents(wsId).then((r) => r.agents);
      setWorkspaceAgents(agents);
    } catch (err: any) {
      console.error('Error loading workspace agents:', err);
    } finally {
      setIsLoadingAgents(false);
    }
  };

  const loadWorkspaceChannels = async (wsId: string) => {
    setIsLoadingChannels(true);
    try {
      const { channels } = await client.channel.list(wsId);
      setWorkspaceChannels(channels as WorkspaceChannel[]);
    } catch (err: any) {
      console.error('Error loading workspace channels:', err);
    } finally {
      setIsLoadingChannels(false);
    }
  };

  const loadAuthStatus = useCallback(
    async (appId: string) => {
      setLoadingAuthStatus((prev) => ({ ...prev, [appId]: true }));
      try {
        const authInfo = (await client.app.getAuthStatus(appId)).auth;
        setAuthStatuses((prev) => ({ ...prev, [appId]: authInfo as any }));
      } catch (err) {
        console.error(`Error loading auth status for ${appId}:`, err);
        setAuthStatuses((prev) => ({ ...prev, [appId]: null }));
      } finally {
        setLoadingAuthStatus((prev) => ({ ...prev, [appId]: false }));
      }
    },
    [client],
  );

  const loadAllAuthStatuses = useCallback(
    async (apps: WorkspaceApp[]) => {
      await Promise.all(apps.map((app) => loadAuthStatus(app.appId)));
    },
    [loadAuthStatus],
  );

  const handleOpenChat = (channel: WorkspaceChannel, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow(
      'chat',
      {
        channelId: channel.channelId,
        workspaceId: workspaceId,
      },
      inNewTab,
      windowId,
    );
  };

  const handleNewChat = (agent: WorkspaceAgent, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow(
      'chat',
      {
        agentId: agent.agentId,
        workspaceId: workspaceId,
      },
      inNewTab,
      windowId,
    );
  };

  const handleArchiveWorkspace = async () => {
    if (!workspace) return;
    try {
      await client.archiveWorkspace(workspace.workspaceId);
      toast.success('Archivado', `Workspace "${workspace.name}" archivado`);
      closeWindow(windowId);
    } catch (err: any) {
      console.error('Error archiving workspace:', err);
      toast.error('Error', err.message || 'No se pudo archivar el workspace');
    }
  };

  const handleOpenAgent = (agent: WorkspaceAgent, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('agent', { agentId: agent.agentId, workspaceId }, inNewTab, windowId);
  };

  const handleOpenApp = (app: WorkspaceApp, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('app', { appId: app.appId, workspaceId }, inNewTab, windowId);
  };

  const handleUninstallApp = async (app: WorkspaceApp) => {
    if (!canEdit) return;

    try {
      await client.app.uninstallApp(app.appId);
      setWorkspaceApps((prev) => prev.filter((a) => a.appId !== app.appId));
      toast.success('Desinstalada', `${app.name} ha sido desinstalada`);
    } catch (err: any) {
      console.error('Error uninstalling app:', err);
      toast.error('Error', err.message || 'No se pudo desinstalar la app');
    }
  };

  // ============================================================================
  // CREATE AGENT MODAL
  // ============================================================================

  const openCreateAgentModal = () => {
    // Open the unified CreateAgentWindow with workspaceId
    openWindow('create-agent', { workspaceId }, false, windowId);
  };

  // ============================================================================
  // EDIT CONTEXT MODAL
  // ============================================================================

  const openEditContextModal = () => {
    setContextText(workspace?.context || '');
    setActiveModal('edit-context');
  };

  const handleSaveContext = async () => {
    if (!workspace) return;

    setSavingContext(true);
    try {
      const updated = await client.updateWorkspace(workspace.workspaceId, {
        context: contextText.trim(),
      });
      setWorkspace((prev) => (prev ? { ...prev, context: updated.context } : null));
      setActiveModal('none');
      toast.success('Guardado', 'Contexto actualizado');
    } catch (err: any) {
      console.error('Error saving context:', err);
      toast.error('Error', err.message || 'No se pudo guardar el contexto');
    } finally {
      setSavingContext(false);
    }
  };

  // ============================================================================
  // EDIT APPEARANCE MODAL
  // ============================================================================

  const openEditAppearanceModal = () => {
    setSelectedColor(workspace?.appearance?.color || 'amber');
    setSelectedIcon(workspace?.appearance?.icon || 'folder');
    setActiveModal('edit-appearance');
  };

  const handleSaveAppearance = async () => {
    if (!workspace) return;

    setSavingAppearance(true);
    try {
      const updated = await client.updateWorkspace(workspace.workspaceId, {
        appearance: {
          color: selectedColor,
          icon: selectedIcon,
        },
      });
      setWorkspace((prev) => (prev ? { ...prev, appearance: updated.appearance } : null));
      setActiveModal('none');
      toast.success('Guardado', 'Apariencia actualizada');
    } catch (err: any) {
      console.error('Error saving appearance:', err);
      toast.error('Error', err.message || 'No se pudo guardar la apariencia');
    } finally {
      setSavingAppearance(false);
    }
  };

  // ============================================================================
  // INSTALL APP MODAL
  // ============================================================================

  const openInstallAppModal = async () => {
    setActiveModal('install-app');
    setLoadingCatalog(true);
    try {
      const { catalog: catalogData } = await client.app.listCatalog();
      // Filter out system apps and already installed MCAs (unless multi)
      const installedMcaIds = workspaceApps.map((a) => a.mcaId);
      const available = catalogData.filter(
        (mca: CatalogMca) =>
          mca.availability.enabled &&
          !mca.availability.system &&
          (mca.availability.multi || !installedMcaIds.includes(mca.mcaId)),
      );
      setCatalog(available);
    } catch (err) {
      console.error('Failed to load catalog:', err);
      toast.error('Error', 'Could not load the catalog');
    } finally {
      setLoadingCatalog(false);
    }
  };

  const handleInstallApp = async (mca: CatalogMca) => {
    setInstallingMcaId(mca.mcaId);
    try {
      const app = await client.installWorkspaceApp(workspaceId, mca.mcaId);
      setWorkspaceApps((prev) => [
        ...prev,
        {
          appId: app.appId,
          name: app.name,
          mcaId: app.mcaId,
          mcaName: mca.name,
          description: mca.description,
          icon: mca.icon,
          color: mca.color,
          category: mca.category,
          status: 'active',
        },
      ]);
      toast.success('Installed', `${mca.name} instalada`);

      // Remove from catalog if not multi
      if (!mca.availability.multi) {
        setCatalog((prev) => prev.filter((m) => m.mcaId !== mca.mcaId));
      }
    } catch (err: any) {
      console.error('Error installing app:', err);
      toast.error('Error', err.message || 'No se pudo instalar la app');
    } finally {
      setInstallingMcaId(null);
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (isLoading) {
    return (
      <FullscreenLoader variant="default" label="Cargando workspace..." />
    );
  }

  if (!workspace) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor="#09090B">
        <Folder size={64} color="#27272A" />
        <Text color="#71717A" marginTop="$3" fontSize="$4">
          Workspace no encontrado
        </Text>
      </YStack>
    );
  }

  const role = roleInfo[workspace.role];
  const RoleIcon = role.icon;
  const canEdit =
    workspace.role === 'owner' || workspace.role === 'admin' || workspace.role === 'write';

  const renderTabButton = (tab: TabType, label: string, count: number, icon: any) => {
    const isActive = activeTab === tab;
    const Icon = icon;
    return (
      <TouchableOpacity
        onPress={() => setActiveTab(tab)}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 6,
          backgroundColor: isActive ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon size={14} color={isActive ? '#3B82F6' : '#71717A'} />
        <Text
          fontSize={13}
          fontWeight={isActive ? '600' : '400'}
          color={isActive ? '#3B82F6' : '#71717A'}
        >
          {label}
        </Text>
        <View
          style={{
            backgroundColor: isActive ? 'rgba(59, 130, 246, 0.2)' : 'rgba(39, 39, 42, 0.6)',
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 10,
            minWidth: 20,
            alignItems: 'center',
          }}
        >
          <Text fontSize={10} color={isActive ? '#3B82F6' : '#71717A'} fontWeight="500">
            {count}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <YStack flex={1} backgroundColor="#09090B">
      {/* Header */}
      <YStack padding="$3" borderBottomWidth={1} borderBottomColor="rgba(39, 39, 42, 0.6)" gap="$2">
        <XStack alignItems="center" justifyContent="space-between">
          <XStack alignItems="center" gap="$3">
            <TouchableOpacity
              onPress={canEdit ? openEditAppearanceModal : undefined}
              activeOpacity={canEdit ? 0.7 : 1}
            >
              <WorkspaceIcon
                icon={workspace.appearance?.icon || 'folder'}
                color={workspace.appearance?.color || 'amber'}
                size={20}
                containerSize={40}
              />
            </TouchableOpacity>
            <YStack>
              <Text fontSize={16} fontWeight="600" color="#FAFAFA">
                {workspace.name}
              </Text>
              {workspace.description && (
                <Text color="#71717A" fontSize={12}>
                  {workspace.description}
                </Text>
              )}
            </YStack>
          </XStack>

          <XStack gap="$2" alignItems="center">
            <XStack
              alignItems="center"
              gap="$1"
              paddingHorizontal={8}
              paddingVertical={4}
              backgroundColor="rgba(39, 39, 42, 0.6)"
              borderRadius={6}
            >
              <RoleIcon size={12} color={role.color} />
              <Text fontSize={11} color={role.color}>
                {role.label}
              </Text>
            </XStack>
            {canEdit && (
              <TouchableOpacity onPress={openEditAppearanceModal}>
                <View
                  style={{ padding: 8, borderRadius: 6, backgroundColor: 'rgba(39, 39, 42, 0.6)' }}
                >
                  <Palette size={14} color="#71717A" />
                </View>
              </TouchableOpacity>
            )}
            {canEdit && (
              <TouchableOpacity onPress={openEditContextModal}>
                <View
                  style={{ padding: 8, borderRadius: 6, backgroundColor: 'rgba(39, 39, 42, 0.6)' }}
                >
                  <FileText size={14} color="#71717A" />
                </View>
              </TouchableOpacity>
            )}
            {workspace.role === 'owner' && (
              <TouchableOpacity onPress={handleArchiveWorkspace}>
                <View
                  style={{ padding: 8, borderRadius: 6, backgroundColor: 'rgba(39, 39, 42, 0.6)' }}
                >
                  <Archive size={14} color="#EF4444" />
                </View>
              </TouchableOpacity>
            )}
          </XStack>
        </XStack>

        <XStack alignItems="center" gap="$2">
          <HardDrive size={12} color="#52525B" />
          <Text color="#52525B" fontSize={11}>
            {workspace.volumeId}
          </Text>
        </XStack>

        <XStack gap="$1" marginTop="$1">
          {renderTabButton('conversations', 'Chats', workspaceChannels.length, MessageCircle)}
          {renderTabButton('agents', 'Agentes', workspaceAgents.length, Bot)}
          {renderTabButton('apps', 'Apps', workspaceApps.length, Package)}
        </XStack>
      </YStack>

      {/* Content */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
        {activeTab === 'conversations' && (
          <>
            {/* New chat button - show agent selector */}
            {workspaceAgents.length > 0 && (
              <YStack gap="$2" marginBottom="$3">
                <Text color="#71717A" fontSize={11} marginBottom="$1">
                  New conversation con:
                </Text>
                <XStack flexWrap="wrap" gap="$2">
                  {workspaceAgents.map((agent) => (
                    <TouchableOpacity
                      key={agent.agentId}
                      onPress={(e) => handleNewChat(agent, e)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        borderRadius: 16,
                        borderWidth: 1,
                        borderColor: 'rgba(59, 130, 246, 0.2)',
                      }}
                    >
                      {agent.avatarUrl ? (
                        <Image
                          source={{ uri: agent.avatarUrl }}
                          style={{ width: 20, height: 20, borderRadius: 10 }}
                        />
                      ) : (
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            backgroundColor: 'rgba(59, 130, 246, 0.3)',
                            justifyContent: 'center',
                            alignItems: 'center',
                          }}
                        >
                          <Bot size={12} color="#3B82F6" />
                        </View>
                      )}
                      <Text color="#3B82F6" fontSize={12} fontWeight="500">
                        {agent.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </XStack>
              </YStack>
            )}
            {isLoadingChannels ? (
              <YStack padding="$4" alignItems="center">
                <AppSpinner size="sm" variant="default" />
              </YStack>
            ) : workspaceChannels.length === 0 ? (
              <YStack
                padding="$6"
                alignItems="center"
                backgroundColor="rgba(24, 24, 27, 0.5)"
                borderRadius={12}
              >
                <MessageCircle size={40} color="#27272A" />
                <Text color="#52525B" marginTop="$2" textAlign="center" fontSize={13}>
                  {workspaceAgents.length === 0
                    ? 'Crea un agente para iniciar conversaciones'
                    : 'No conversations yet'}
                </Text>
              </YStack>
            ) : (
              <YStack gap="$2">
                {workspaceChannels.map((channel) => {
                  const agent = workspaceAgents.find((a) => a.agentId === channel.agentId);
                  return (
                    <TouchableOpacity
                      key={channel.channelId}
                      onPress={(e) => handleOpenChat(channel, e)}
                      activeOpacity={0.7}
                    >
                      <XStack
                        padding="$3"
                        backgroundColor="rgba(24, 24, 27, 0.9)"
                        borderRadius={10}
                        alignItems="center"
                        gap="$3"
                        borderWidth={1}
                        borderColor="rgba(39, 39, 42, 0.6)"
                      >
                        {agent?.avatarUrl ? (
                          <Image
                            source={{ uri: agent.avatarUrl }}
                            style={{ width: 40, height: 40, borderRadius: 20 }}
                          />
                        ) : (
                          <View
                            style={{
                              width: 40,
                              height: 40,
                              borderRadius: 20,
                              backgroundColor: 'rgba(59, 130, 246, 0.15)',
                              justifyContent: 'center',
                              alignItems: 'center',
                            }}
                          >
                            <MessageCircle size={20} color="#3B82F6" />
                          </View>
                        )}
                        <YStack flex={1}>
                          <Text color="#FAFAFA" fontWeight="500" fontSize={14} numberOfLines={1}>
                            {channel.metadata?.name || `Chat con ${agent?.name || 'Agente'}`}
                          </Text>
                          {channel.lastMessage && (
                            <Text color="#71717A" fontSize={11} numberOfLines={1}>
                              {channel.lastMessage.content}
                            </Text>
                          )}
                        </YStack>
                        {(channel.unreadCount ?? 0) > 0 && (
                          <View
                            style={{
                              backgroundColor: '#3B82F6',
                              borderRadius: 10,
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              minWidth: 20,
                              alignItems: 'center',
                            }}
                          >
                            <Text color="#FFFFFF" fontSize={10} fontWeight="600">
                              {channel.unreadCount}
                            </Text>
                          </View>
                        )}
                      </XStack>
                    </TouchableOpacity>
                  );
                })}
              </YStack>
            )}
          </>
        )}

        {activeTab === 'agents' && (
          <>
            {canEdit && (
              <TouchableOpacity
                onPress={openCreateAgentModal}
                style={{
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(59, 130, 246, 0.2)',
                  borderStyle: 'dashed',
                }}
              >
                <Plus size={16} color="#3B82F6" />
                <Text color="#3B82F6" fontSize={13} fontWeight="500">
                  Crear agente
                </Text>
              </TouchableOpacity>
            )}
            {isLoadingAgents ? (
              <YStack padding="$4" alignItems="center">
                <AppSpinner size="sm" variant="default" />
              </YStack>
            ) : workspaceAgents.length === 0 ? (
              <YStack
                padding="$6"
                alignItems="center"
                backgroundColor="rgba(24, 24, 27, 0.5)"
                borderRadius={12}
              >
                <Bot size={40} color="#27272A" />
                <Text color="#52525B" marginTop="$2" textAlign="center" fontSize={13}>
                  No hay agentes en este workspace
                </Text>
              </YStack>
            ) : (
              <YStack gap="$2">
                {workspaceAgents.map((agent) => (
                  <TouchableOpacity
                    key={agent.agentId}
                    onPress={(e) => handleOpenAgent(agent, e)}
                    activeOpacity={0.7}
                  >
                    <XStack
                      padding="$3"
                      backgroundColor="rgba(24, 24, 27, 0.9)"
                      borderRadius={10}
                      alignItems="center"
                      gap="$3"
                      borderWidth={1}
                      borderColor="rgba(39, 39, 42, 0.6)"
                    >
                      {agent.avatarUrl ? (
                        <Image
                          source={{ uri: agent.avatarUrl }}
                          style={{ width: 40, height: 40, borderRadius: 20 }}
                        />
                      ) : (
                        <View
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: 20,
                            backgroundColor: 'rgba(59, 130, 246, 0.15)',
                            justifyContent: 'center',
                            alignItems: 'center',
                          }}
                        >
                          <Bot size={20} color="#3B82F6" />
                        </View>
                      )}
                      <YStack flex={1}>
                        <Text color="#FAFAFA" fontWeight="500" fontSize={14}>
                          {agent.name}
                        </Text>
                        <Text color="#71717A" fontSize={11}>
                          {agent.role}
                        </Text>
                      </YStack>
                    </XStack>
                  </TouchableOpacity>
                ))}
              </YStack>
            )}
          </>
        )}

        {activeTab === 'apps' && (
          <>
            {canEdit && (
              <TouchableOpacity
                onPress={openInstallAppModal}
                style={{
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(59, 130, 246, 0.2)',
                  borderStyle: 'dashed',
                }}
              >
                <Plus size={16} color="#3B82F6" />
                <Text color="#3B82F6" fontSize={13} fontWeight="500">
                  Install app
                </Text>
              </TouchableOpacity>
            )}
            {isLoadingApps ? (
              <YStack padding="$4" alignItems="center">
                <AppSpinner size="sm" variant="default" />
              </YStack>
            ) : workspaceApps.length === 0 ? (
              <YStack
                padding="$6"
                alignItems="center"
                backgroundColor="rgba(24, 24, 27, 0.5)"
                borderRadius={12}
              >
                <Package size={40} color="#27272A" />
                <Text color="#52525B" marginTop="$2" textAlign="center" fontSize={13}>
                  No hay apps instaladas
                </Text>
              </YStack>
            ) : (
              <XStack flexWrap="wrap" gap="$2">
                {workspaceApps.map((app) => (
                  <AppCard
                    key={app.appId}
                    appId={app.appId}
                    name={app.name}
                    icon={app.icon}
                    color={app.color}
                    category={app.category}
                    authInfo={authStatuses[app.appId]}
                    loading={loadingAuthStatus[app.appId]}
                    onPress={(e) => handleOpenApp(app, e)}
                    onUninstall={canEdit ? () => handleUninstallApp(app) : undefined}
                    showUninstall={canEdit}
                  />
                ))}
              </XStack>
            )}
          </>
        )}
      </ScrollView>

      {/* Create Agent Modal */}
      {/* Install App Modal */}
      {activeModal === 'install-app' && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
          }}
        >
          <View
            style={{
              backgroundColor: '#18181B',
              borderRadius: 12,
              width: '100%',
              maxWidth: 500,
              maxHeight: '90%',
              borderWidth: 1,
              borderColor: 'rgba(39, 39, 42, 0.6)',
            }}
          >
            {/* Header */}
            <XStack
              padding="$3"
              borderBottomWidth={1}
              borderBottomColor="rgba(39, 39, 42, 0.6)"
              justifyContent="space-between"
              alignItems="center"
            >
              <Text fontSize={16} fontWeight="600" color="#FAFAFA">
                Install app
              </Text>
              <TouchableOpacity onPress={() => setActiveModal('none')}>
                <X size={20} color="#71717A" />
              </TouchableOpacity>
            </XStack>

            <ScrollView style={{ maxHeight: 450 }} contentContainerStyle={{ padding: 16 }}>
              {loadingCatalog ? (
                <YStack padding="$4" alignItems="center">
                  <AppSpinner size="lg" variant="default" />
                  <Text color="#71717A" marginTop="$2">
                    Loading catalog...
                  </Text>
                </YStack>
              ) : catalog.length === 0 ? (
                <YStack padding="$6" alignItems="center">
                  <Package size={40} color="#27272A" />
                  <Text color="#52525B" marginTop="$2" textAlign="center">
                    No hay apps disponibles para instalar
                  </Text>
                </YStack>
              ) : (
                <YStack gap="$2">
                  {catalog.map((mca) => {
                    const isInstalling = installingMcaId === mca.mcaId;
                    return (
                      <XStack
                        key={mca.mcaId}
                        padding="$3"
                        backgroundColor="rgba(24, 24, 27, 0.9)"
                        borderRadius={10}
                        alignItems="center"
                        gap="$3"
                        borderWidth={1}
                        borderColor="rgba(39, 39, 42, 0.6)"
                      >
                        <View
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: 8,
                            backgroundColor: mca.color || 'rgba(39, 39, 42, 0.6)',
                            justifyContent: 'center',
                            alignItems: 'center',
                            overflow: 'hidden',
                          }}
                        >
                          {mca.icon ? (
                            <Image
                              source={{ uri: mca.icon }}
                              style={{ width: 28, height: 28 }}
                              resizeMode="contain"
                            />
                          ) : (
                            <Package size={20} color="#FAFAFA" />
                          )}
                        </View>
                        <YStack flex={1}>
                          <Text color="#FAFAFA" fontWeight="500" fontSize={14}>
                            {mca.name}
                          </Text>
                          <Text color="#71717A" fontSize={11} numberOfLines={1}>
                            {mca.description}
                          </Text>
                          <Text color="#52525B" fontSize={10}>
                            {mca.tools.length} herramientas
                          </Text>
                        </YStack>
                        <TouchableOpacity
                          onPress={() => handleInstallApp(mca)}
                          disabled={isInstalling}
                          style={{
                            backgroundColor: 'rgba(59, 130, 246, 0.15)',
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 6,
                            opacity: isInstalling ? 0.5 : 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          {isInstalling ? (
                            <AppSpinner size="sm" variant="default" />
                          ) : (
                            <>
                              <Download size={14} color="#3B82F6" />
                              <Text color="#3B82F6" fontSize={12} fontWeight="500">
                                Install
                              </Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </XStack>
                    );
                  })}
                </YStack>
              )}
            </ScrollView>
          </View>
        </View>
      )}

      {/* Edit Appearance Modal */}
      {activeModal === 'edit-appearance' && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
          }}
        >
          <View
            style={{
              backgroundColor: '#18181B',
              borderRadius: 12,
              width: '100%',
              maxWidth: 400,
              maxHeight: '90%',
              borderWidth: 1,
              borderColor: 'rgba(39, 39, 42, 0.6)',
            }}
          >
            {/* Header */}
            <XStack
              padding="$3"
              borderBottomWidth={1}
              borderBottomColor="rgba(39, 39, 42, 0.6)"
              justifyContent="space-between"
              alignItems="center"
            >
              <Text fontSize={16} fontWeight="600" color="#FAFAFA">
                Personalizar apariencia
              </Text>
              <TouchableOpacity onPress={() => setActiveModal('none')}>
                <X size={20} color="#71717A" />
              </TouchableOpacity>
            </XStack>

            <ScrollView style={{ maxHeight: 500 }} contentContainerStyle={{ padding: 16 }}>
              {/* Preview */}
              <YStack alignItems="center" marginBottom="$4">
                <WorkspaceIcon
                  icon={selectedIcon}
                  color={selectedColor}
                  size={32}
                  containerSize={64}
                />
                <Text color="#71717A" fontSize={12} marginTop="$2">
                  Vista previa
                </Text>
              </YStack>

              {/* Color Picker */}
              <YStack gap="$2" marginBottom="$4">
                <Text color="#A1A1AA" fontSize={12} fontWeight="500">
                  Color
                </Text>
                <XStack flexWrap="wrap" gap="$2">
                  {WORKSPACE_COLORS.map((color) => {
                    const isSelected = selectedColor === color;
                    const palette = COLOR_PALETTE[color];
                    return (
                      <TouchableOpacity
                        key={color}
                        onPress={() => setSelectedColor(color)}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 8,
                          backgroundColor: palette['500'],
                          justifyContent: 'center',
                          alignItems: 'center',
                          borderWidth: 2,
                          borderColor: isSelected ? '#FAFAFA' : 'transparent',
                        }}
                      >
                        {isSelected && <Check size={16} color="#FAFAFA" />}
                      </TouchableOpacity>
                    );
                  })}
                </XStack>
              </YStack>

              {/* Icon Picker */}
              <YStack gap="$2">
                <Text color="#A1A1AA" fontSize={12} fontWeight="500">
                  Icono
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {WORKSPACE_ICONS.map((icon) => {
                    const isSelected = selectedIcon === icon;
                    const iconName = icon
                      .split('-')
                      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                      .join('');
                    const IconComponent = (LucideIcons as any)[iconName] || Folder;
                    const palette =
                      COLOR_PALETTE[selectedColor as WorkspaceColor] || COLOR_PALETTE.amber;
                    return (
                      <TouchableOpacity
                        key={icon}
                        onPress={() => setSelectedIcon(icon)}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 6,
                          backgroundColor: isSelected
                            ? palette['900'] + '60'
                            : 'rgba(39, 39, 42, 0.4)',
                          justifyContent: 'center',
                          alignItems: 'center',
                          borderWidth: 1,
                          borderColor: isSelected ? palette['500'] : 'transparent',
                        }}
                      >
                        <IconComponent size={16} color={isSelected ? palette['500'] : '#71717A'} />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </YStack>
            </ScrollView>

            {/* Footer */}
            <XStack
              padding="$3"
              borderTopWidth={1}
              borderTopColor="rgba(39, 39, 42, 0.6)"
              justifyContent="flex-end"
              gap="$2"
            >
              <TouchableOpacity
                onPress={() => setActiveModal('none')}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(63, 63, 70, 0.5)',
                }}
              >
                <Text color="#A1A1AA" fontSize={13}>
                  Cancelar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSaveAppearance}
                disabled={savingAppearance}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: '#3B82F6',
                  opacity: savingAppearance ? 0.5 : 1,
                  minWidth: 100,
                  alignItems: 'center',
                }}
              >
                {savingAppearance ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <Text color="#fff" fontSize={13} fontWeight="500">
                    Guardar
                  </Text>
                )}
              </TouchableOpacity>
            </XStack>
          </View>
        </View>
      )}

      {/* Edit Context Modal */}
      {activeModal === 'edit-context' && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
          }}
        >
          <View
            style={{
              backgroundColor: '#18181B',
              borderRadius: 12,
              width: '100%',
              maxWidth: 500,
              maxHeight: '80%',
              borderWidth: 1,
              borderColor: 'rgba(39, 39, 42, 0.6)',
            }}
          >
            {/* Header */}
            <XStack
              padding="$3"
              borderBottomWidth={1}
              borderBottomColor="rgba(39, 39, 42, 0.6)"
              justifyContent="space-between"
              alignItems="center"
            >
              <Text fontSize={16} fontWeight="600" color="#FAFAFA">
                Editar contexto del workspace
              </Text>
              <TouchableOpacity onPress={() => setActiveModal('none')}>
                <X size={20} color="#71717A" />
              </TouchableOpacity>
            </XStack>

            {/* Content */}
            <View style={{ padding: 16, flex: 1 }}>
              <Text color="#71717A" fontSize={12} marginBottom="$2">
                The context is included in the prompts of agents in this workspace. Use it to
                provide project-specific information, coding standards, or any
                other relevant information that agents should know.
              </Text>

              <TextInput
                value={contextText}
                onChangeText={setContextText}
                multiline
                numberOfLines={8}
                placeholder="Write the workspace context here..."
                placeholderTextColor="#52525B"
                style={{
                  backgroundColor: '#27272A',
                  color: '#FAFAFA',
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 14,
                  borderWidth: 1,
                  borderColor: 'rgba(39, 39, 42, 0.6)',
                  textAlignVertical: 'top',
                  minHeight: 150,
                  flex: 1,
                }}
                editable={!savingContext}
              />
            </View>

            {/* Actions */}
            <XStack
              padding="$3"
              borderTopWidth={1}
              borderTopColor="rgba(39, 39, 42, 0.6)"
              justifyContent="flex-end"
              gap="$2"
            >
              <TouchableOpacity
                onPress={() => setActiveModal('none')}
                disabled={savingContext}
                style={{ padding: 12, borderRadius: 6, backgroundColor: 'rgba(39, 39, 42, 0.6)' }}
              >
                <Text color="#FAFAFA" fontSize={13}>
                  Cancelar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSaveContext}
                disabled={savingContext}
                style={{
                  padding: 12,
                  borderRadius: 6,
                  backgroundColor: savingContext ? 'rgba(59, 130, 246, 0.5)' : '#3B82F6',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {savingContext ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <Text color="#fff" fontSize={13} fontWeight="500">
                    Guardar
                  </Text>
                )}
              </TouchableOpacity>
            </XStack>
          </View>
        </View>
      )}
    </YStack>
  );
}
