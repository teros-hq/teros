/**
 * Workspace Window Content
 *
 * Shows details of a single workspace: volume, apps, agents, members.
 */

import * as LucideIcons from '@tamagui/lucide-icons';
import {
  Archive,
  Bot,

  Check,
  Crown,
  Download,
  Edit3,
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
import { useTranslation } from 'react-i18next';
import { getTerosClient } from '../../services/terosClientSingleton';
import { AppCard } from '../../components/AppCard';
import type { AppAuthInfo } from '../../components/apps';
import { useToast } from '../../components/Toast';
import { WorkspaceIcon } from '../../components/WorkspaceIcon';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import { useTilingStore } from '../../store/tilingStore';
import type { WorkspaceWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';
import { ContextEditor } from '../../components/ContextEditor';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';

interface WorkspaceDetails {
  workspaceId: string;
  name: string;
  description?: string;
  context?: string;
  volumeId?: string;
  ownerId?: string;
  members?: Array<{
    userId: string;
    role: 'admin' | 'write' | 'read';
    addedAt: string;
    addedBy: string;
  }>;
  settings?: {
    defaultBranch?: string;
  };
  appearance?: {
    color?: string;
    icon?: string;
  };
  /** Workspace type — 'private' is the user's personal workspace and cannot be deleted/archived */
  type?: 'private' | 'shared';
  role?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
}

interface WorkspaceApp {
  appId: string;
  name: string;
  mcaId: string;
  mcaName?: string;
  description: string;
  icon?: string;
  color?: string;
  category: string;
  status: string;
  volumes?: any[];
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

const roleIcons: Record<string, { color: string; icon: any }> = {
  owner: { color: '#FFD700', icon: Crown },
  admin: { color: '#9B59B6', icon: Settings },
  write: { color: '#3498DB', icon: Edit3 },
  read: { color: '#95A5A6', icon: Users },
};

type TabType = 'conversations' | 'agents' | 'apps' | 'members' | 'context';
type ModalType = 'none' | 'install-app' | 'edit-appearance' | 'edit-context';

interface WorkspaceWindowContentProps extends WorkspaceWindowProps {
  windowId: string;
}

export function WorkspaceWindowContent({ windowId, workspaceId }: WorkspaceWindowContentProps) {
  const { t } = useTranslation();
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
  const [iconSearch, setIconSearch] = useState<string>('');

  // Edit context state
  const [savingContext, setSavingContext] = useState(false);
  const [contextText, setContextText] = useState(workspace?.context || '');

  const client = getTerosClient();
  const toast = useToast();
  const { closeWindow, updateWindowProps, openWindow } = useTilingStore();
  const { shouldOpenInNewTab } = useClickModifiers();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  // Load workspace details on mount
  useEffect(() => {
    const loadData = async () => {
      if (!workspaceId) return;

      setIsLoading(true);
      try {
        const { workspace: data } = await client.workspace.getWorkspace(workspaceId);
        setWorkspace(data);
        updateWindowProps(windowId, { name: data.name });
        loadWorkspaceChannels(workspaceId);
        loadWorkspaceApps(workspaceId);
        loadWorkspaceAgents(workspaceId);
      } catch (err: any) {
        console.error('Error loading workspace:', err);
        toast.error(t('workspaceDetail.error'), t('workspaceDetail.loadError'));
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
      const { apps } = await client.workspace.listWorkspaceApps(wsId);
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
    // Guard: private workspaces cannot be archived/deleted
    if (workspace.type === 'private') {
      toast.error(t('workspaceDetail.notAllowed'), t('workspaceDetail.privateCannotArchive'));
      return;
    }
    try {
      await client.workspace.archiveWorkspace(workspace.workspaceId);
      toast.success(t('workspaceDetail.archived'), t('workspaceDetail.archivedMessage', { name: workspace.name }));
      closeWindow(windowId);
    } catch (err: any) {
      console.error('Error archiving workspace:', err);
      toast.error(t('workspaceDetail.error'), err.message || t('workspaceDetail.archiveError'));
    }
  };

  const handleOpenAgent = (agent: WorkspaceAgent, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('agent', { agentId: agent.agentId, workspaceId }, inNewTab, windowId);
  };

  const handleOpenApp = (app: WorkspaceApp, e?: any) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('app', { appId: app.appId }, inNewTab, windowId);
  };

  const handleUninstallApp = async (app: WorkspaceApp) => {
    if (!canEdit) return;

    try {
      await client.app.uninstallApp(app.appId);
      setWorkspaceApps((prev) => prev.filter((a) => a.appId !== app.appId));
      toast.success(t('workspaceDetail.uninstalled'), t('workspaceDetail.uninstalledMessage', { name: app.name }));
    } catch (err: any) {
      console.error('Error uninstalling app:', err);
      toast.error(t('workspaceDetail.error'), err.message || t('workspaceDetail.uninstallError'));
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
  // EDIT CONTEXT INLINE
  // ============================================================================

  const handleSaveContext = async (newContext: string) => {
    if (!workspace) return;

    setSavingContext(true);
    try {
      const { workspace: updated } = await client.workspace.updateWorkspace({
        workspaceId: workspace.workspaceId,
        context: newContext.trim(),
      });
      setWorkspace((prev) => (prev ? { ...prev, context: updated.context } : null));
      setActiveModal('none');
      toast.success(t('workspaceDetail.saved'), t('workspaceDetail.contextUpdated'));
    } catch (err: any) {
      console.error('Error saving context:', err);
      toast.error(t('workspaceDetail.error'), err.message || t('workspaceDetail.contextSaveError'));
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
    setIconSearch('');
    setActiveModal('edit-appearance');
  };

  const handleSaveAppearance = async () => {
    if (!workspace) return;

    setSavingAppearance(true);
    try {
      const { workspace: updated } = await client.workspace.updateWorkspace({
        workspaceId: workspace.workspaceId,
        appearance: {
          color: selectedColor,
          icon: selectedIcon,
        },
      });
      setWorkspace((prev) => (prev ? { ...prev, appearance: updated.appearance } : null));
      setActiveModal('none');
      toast.success(t('workspaceDetail.saved'), t('workspaceDetail.appearanceUpdated'));
    } catch (err: any) {
      console.error('Error saving appearance:', err);
      toast.error(t('workspaceDetail.error'), err.message || t('workspaceDetail.appearanceSaveError'));
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
      toast.error(t('workspaceDetail.error'), t('workspaceDetail.catalogLoadError'));
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
      toast.success(t('workspaceDetail.installed'), t('workspaceDetail.installedMessage', { name: mca.name }));

      // Remove from catalog if not multi
      if (!mca.availability.multi) {
        setCatalog((prev) => prev.filter((m) => m.mcaId !== mca.mcaId));
      }
    } catch (err: any) {
      console.error('Error installing app:', err);
      toast.error(t('workspaceDetail.error'), err.message || t('workspaceDetail.installError'));
    } finally {
      setInstallingMcaId(null);
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (isLoading) {
    return (
      <FullscreenLoader variant="default" label={t('workspaceDetail.loadingWorkspace')} />
    );
  }

  if (!workspace) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgPage}>
        <Folder size={64} color={c.text3} />
        <Text color={c.text2} marginTop="$3" fontSize="$4">
          {t('workspaceDetail.notFound')}
        </Text>
      </YStack>
    );
  }

  const roleKey = workspace.role ?? 'read';
  const roleData = roleIcons[roleKey] ?? roleIcons.read;
  const roleLabel = t(`workspaceDetail.role_${roleKey}`);
  const RoleIcon = roleData.icon;
  const canEdit =
    workspace.role === 'owner' || workspace.role === 'admin' || workspace.role === 'write';

  // ============================================================================
  // ICON PICKER HELPERS
  // ============================================================================

  /** Convert PascalCase Lucide export name to kebab-case icon name */
  const pascalToKebab = (name: string): string =>
    name.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

  /**
   * Returns the list of icons to display in the icon picker:
   * - Empty search → curated WORKSPACE_ICONS (~50)
   * - With search → all Lucide icons filtered by kebab-case name
   */
  const getFilteredIcons = (): string[] => {
    const query = iconSearch.trim().toLowerCase();
    if (!query) return [...WORKSPACE_ICONS];

    return Object.keys(LucideIcons)
      .map(pascalToKebab)
      .filter(
        (name) =>
          // Exclude non-icon exports (they tend to be short or have special chars)
          /^[a-z][a-z0-9-]+$/.test(name) && name.includes(query),
      );
  };

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header */}
      <YStack padding="$3" borderBottomWidth={1} borderBottomColor={c.border} gap="$2">
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
              <Text fontSize={16} fontWeight="600" color={c.text}>
                {workspace.name}
              </Text>
              {workspace.description && (
                <Text color={c.text2} fontSize={12}>
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
              backgroundColor={c.bgCardHover}
              borderRadius={6}
            >
              <RoleIcon size={12} color={roleData.color} />
              <Text fontSize={11} color={roleData.color}>
                {roleLabel}
              </Text>
            </XStack>
            {canEdit && (
              <TouchableOpacity onPress={openEditAppearanceModal}>
                <View
                  style={{ padding: 8, borderRadius: 6, backgroundColor: c.bgCardHover }}
                >
                  <Palette size={14} color={c.text2} />
                </View>
              </TouchableOpacity>
            )}
            {workspace.role === 'owner' && workspace.type !== 'private' && (
              <TouchableOpacity onPress={handleArchiveWorkspace}>
                <View
                  style={{ padding: 8, borderRadius: 6, backgroundColor: c.bgCardHover }}
                >
                  <Archive size={14} color={semanticColors.red} />
                </View>
              </TouchableOpacity>
            )}
          </XStack>
        </XStack>

        <XStack alignItems="center" gap="$2">
          <HardDrive size={12} color={c.text3} />
          <Text color={c.text3} fontSize={11}>
            {workspace.volumeId}
          </Text>
        </XStack>

      </YStack>

      {/* Tabs */}
      <YStack
        backgroundColor={c.bgPage}
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <XStack paddingHorizontal={16}>
            {[
              { id: 'conversations' as TabType, label: t('workspaceDetail.tabChats'), icon: MessageCircle, count: workspaceChannels.length },
              { id: 'agents' as TabType, label: t('workspaceDetail.tabAgents'), icon: Bot, count: workspaceAgents.length },
              { id: 'apps' as TabType, label: t('workspaceDetail.tabApps'), icon: Package, count: workspaceApps.length },
              { id: 'members' as TabType, label: t('workspaceDetail.tabMembers'), icon: Users, count: workspace?.members?.length ?? 0 },
              { id: 'context' as TabType, label: t('workspaceDetail.tabContext'), icon: FileText, count: 0 },
            ].map((tab) => {
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
                  borderBottomColor={isActive ? semanticColors.indigo : 'transparent'}
                  opacity={isActive ? 1 : 0.6}
                  hoverStyle={{ opacity: 1, backgroundColor: isDark ? '#111' : 'rgba(10,10,15,0.06)' }}
                  onPress={() => setActiveTab(tab.id)}
                >
                  <Icon size={14} color={isActive ? semanticColors.indigo : c.text2} />
                  <Text
                    fontSize={12}
                    fontWeight={isActive ? '600' : '500'}
                    color={isActive ? semanticColors.indigo : c.text2}
                  >
                    {tab.label}
                  </Text>
                  {tab.count > 0 && (
                    <View
                      style={{
                        backgroundColor: isActive ? 'rgba(94,106,210,0.20)' : c.bgCardHover,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 10,
                        minWidth: 20,
                        alignItems: 'center',
                      }}
                    >
                      <Text fontSize={10} color={isActive ? semanticColors.indigo : c.text2} fontWeight="500">
                        {tab.count}
                      </Text>
                    </View>
                  )}
                </XStack>
              );
            })}
          </XStack>
        </ScrollView>
      </YStack>

      {/* Tab Content */}
      <ScrollView contentContainerStyle={{ flexGrow: 1, flexShrink: 1 }}>
        <YStack padding={16} gap={16}>
        {activeTab === 'conversations' && (
          <>
            {/* New chat button - show agent selector */}
            {workspaceAgents.length > 0 && (
              <YStack gap="$2" marginBottom="$3">
                <Text color={c.text2} fontSize={11} marginBottom="$1">
                  {t('workspaceDetail.newConversationWith')}
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
                        backgroundColor: semanticColors.indigoGlow,
                        borderRadius: 16,
                        borderWidth: 1,
                        borderColor: 'rgba(94,106,210,0.20)',
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
                            backgroundColor: 'rgba(94,106,210,0.30)',
                            justifyContent: 'center',
                            alignItems: 'center',
                          }}
                        >
                          <Bot size={12} color={semanticColors.indigo} />
                        </View>
                      )}
                      <Text color={semanticColors.indigo} fontSize={12} fontWeight="500">
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
                backgroundColor={c.bgInner}
                borderRadius={12}
              >
                <MessageCircle size={40} color={c.text3} />
                <Text color={c.text3} marginTop="$2" textAlign="center" fontSize={13}>
                  {workspaceAgents.length === 0
                    ? t('workspaceDetail.createAgentToChat')
                    : t('workspaceDetail.noConversationsYet')}
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
                        backgroundColor={c.bgCard}
                        borderRadius={10}
                        alignItems="center"
                        gap="$3"
                        borderWidth={1}
                        borderColor={c.border}
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
                              backgroundColor: semanticColors.indigoGlow,
                              justifyContent: 'center',
                              alignItems: 'center',
                            }}
                          >
                            <MessageCircle size={20} color={semanticColors.indigo} />
                          </View>
                        )}
                        <YStack flex={1}>
                          <Text color={c.text} fontWeight="500" fontSize={14} numberOfLines={1}>
                            {channel.metadata?.name || t('workspaceDetail.chatWith', { name: agent?.name || t('workspaceDetail.agent') })}
                          </Text>
                          {channel.lastMessage && (
                            <Text color={c.text2} fontSize={11} numberOfLines={1}>
                              {channel.lastMessage.content}
                            </Text>
                          )}
                        </YStack>
                        {(channel.unreadCount ?? 0) > 0 && (
                          <View
                            style={{
                              backgroundColor: semanticColors.indigo,
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
                  backgroundColor: semanticColors.indigoGlow,
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(94,106,210,0.20)',
                  borderStyle: 'dashed',
                }}
              >
                <Plus size={16} color={semanticColors.indigo} />
                <Text color={semanticColors.indigo} fontSize={13} fontWeight="500">
                  {t('workspaceDetail.createAgent')}
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
                backgroundColor={c.bgInner}
                borderRadius={12}
              >
                <Bot size={40} color={c.text3} />
                <Text color={c.text3} marginTop="$2" textAlign="center" fontSize={13}>
                  {t('workspaceDetail.noAgents')}
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
                      backgroundColor={c.bgCard}
                      borderRadius={10}
                      alignItems="center"
                      gap="$3"
                      borderWidth={1}
                      borderColor={c.border}
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
                            backgroundColor: semanticColors.indigoGlow,
                            justifyContent: 'center',
                            alignItems: 'center',
                          }}
                        >
                          <Bot size={20} color={semanticColors.indigo} />
                        </View>
                      )}
                      <YStack flex={1}>
                        <Text color={c.text} fontWeight="500" fontSize={14}>
                          {agent.name}
                        </Text>
                        <Text color={c.text2} fontSize={11}>
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
                  backgroundColor: semanticColors.indigoGlow,
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(94,106,210,0.20)',
                  borderStyle: 'dashed',
                }}
              >
                <Plus size={16} color={semanticColors.indigo} />
                <Text color={semanticColors.indigo} fontSize={13} fontWeight="500">
                  {t('workspaceDetail.installApp')}
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
                backgroundColor={c.bgInner}
                borderRadius={12}
              >
                <Package size={40} color={c.text3} />
                <Text color={c.text3} marginTop="$2" textAlign="center" fontSize={13}>
                  {t('workspaceDetail.noAppsInstalled')}
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
                    onPress={(e?: any) => handleOpenApp(app, e)}
                    onUninstall={canEdit ? () => handleUninstallApp(app) : undefined}
                    showUninstall={canEdit}
                  />
                ))}
              </XStack>
            )}
          </>
        )}

        {/* Members Tab */}
        {activeTab === 'members' && (
          <>
            {workspace?.members && workspace.members.length > 0 ? (
              <YStack gap={12}>
                <Text fontSize={14} fontWeight="600" color={c.text}>
                  {t('workspaceDetail.membersTitle')}
                </Text>
                <YStack gap={8}>
                  {workspace.members.map((member) => {
                    const roleInfo: any = { owner: { icon: Crown }, admin: { icon: Settings }, write: { icon: Edit3 }, read: { icon: LucideIcons.Eye } };
                    const mRole = roleInfo[member.role] || roleInfo.read;
                    const MRoleIcon = mRole.icon;
                    return (
                      <XStack
                        key={member.userId}
                        padding="$3"
                        backgroundColor={c.bgCard}
                        borderRadius={10}
                        alignItems="center"
                        gap="$3"
                        borderWidth={1}
                        borderColor={c.border}
                      >
                        <View
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            backgroundColor: semanticColors.indigoGlow,
                            justifyContent: 'center',
                            alignItems: 'center',
                          }}
                        >
                          <Users size={16} color={semanticColors.indigo} />
                        </View>
                        <YStack flex={1}>
                          <Text color={c.text} fontWeight="500" fontSize={14}>
                            {member.userId}
                          </Text>
                          <XStack alignItems="center" gap={4}>
                            <MRoleIcon size={10} color={mRole.color} />
                            <Text color={c.text2} fontSize={11}>
                              {mRole.label}
                            </Text>
                          </XStack>
                        </YStack>
                      </XStack>
                    );
                  })}
                </YStack>
              </YStack>
            ) : (
              <YStack
                padding="$6"
                alignItems="center"
                backgroundColor={c.bgInner}
                borderRadius={12}
              >
                <Users size={40} color={c.text3} />
                <Text color={c.text3} marginTop="$2" textAlign="center" fontSize={13}>
                  {t('workspaceDetail.noMembers')}
                </Text>
              </YStack>
            )}
          </>
        )}

        {/* Context Tab */}
        {activeTab === 'context' && (
          <ContextEditor
            title={t('workspaceDetail.workspaceContext')}
            description={t('workspaceDetail.workspaceContextDescription')}
            value={workspace?.context ?? ''}
            onChange={(text) =>
              setWorkspace((prev) => (prev ? { ...prev, context: text } : null))
            }
            onSave={async () => {
              await handleSaveContext(workspace?.context ?? '');
            }}
            isSaving={savingContext}
            placeholder={t('workspace.contextPlaceholder')}
          />
        )}
        </YStack>
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
            backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
          }}
        >
          <View
            style={{
              backgroundColor: c.bgCard,
              borderRadius: 12,
              width: '100%',
              maxWidth: 500,
              maxHeight: '90%',
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            {/* Header */}
            <XStack
              padding="$3"
              borderBottomWidth={1}
              borderBottomColor={c.border}
              justifyContent="space-between"
              alignItems="center"
            >
              <Text fontSize={16} fontWeight="600" color={c.text}>
                {t('workspaceDetail.installApp')}
              </Text>
              <TouchableOpacity onPress={() => setActiveModal('none')}>
                <X size={20} color={c.text2} />
              </TouchableOpacity>
            </XStack>

            <ScrollView style={{ maxHeight: 450 }} contentContainerStyle={{ padding: 16 }}>
              {loadingCatalog ? (
                <YStack padding="$4" alignItems="center">
                  <AppSpinner size="lg" variant="default" />
                  <Text color={c.text2} marginTop="$2">
                    {t('workspaceDetail.loadingCatalog')}
                  </Text>
                </YStack>
              ) : catalog.length === 0 ? (
                <YStack padding="$6" alignItems="center">
                  <Package size={40} color={c.text3} />
                  <Text color={c.text3} marginTop="$2" textAlign="center">
                    {t('workspaceDetail.noAppsAvailable')}
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
                        backgroundColor={c.bgCard}
                        borderRadius={10}
                        alignItems="center"
                        gap="$3"
                        borderWidth={1}
                        borderColor={c.border}
                      >
                        <View
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: 8,
                            backgroundColor: mca.color || c.bgCardHover,
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
                            <Package size={20} color={c.text} />
                          )}
                        </View>
                        <YStack flex={1}>
                          <Text color={c.text} fontWeight="500" fontSize={14}>
                            {mca.name}
                          </Text>
                          <Text color={c.text2} fontSize={11} numberOfLines={1}>
                            {mca.description}
                          </Text>
                          <Text color={c.text3} fontSize={10}>
                            {t('workspaceDetail.toolCount', { count: mca.tools.length })}
                          </Text>
                        </YStack>
                        <TouchableOpacity
                          onPress={() => handleInstallApp(mca)}
                          disabled={isInstalling}
                          style={{
                            backgroundColor: semanticColors.indigoGlow,
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
                              <Download size={14} color={semanticColors.indigo} />
                              <Text color={semanticColors.indigo} fontSize={12} fontWeight="500">
                                {t('workspaceDetail.install')}
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
            backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
          }}
        >
          <View
            style={{
              backgroundColor: c.bgCard,
              borderRadius: 12,
              width: '100%',
              maxWidth: 400,
              maxHeight: '90%',
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            {/* Header */}
            <XStack
              padding="$3"
              borderBottomWidth={1}
              borderBottomColor={c.border}
              justifyContent="space-between"
              alignItems="center"
            >
              <Text fontSize={16} fontWeight="600" color={c.text}>
                {t('workspaceDetail.customizeAppearance')}
              </Text>
              <TouchableOpacity onPress={() => setActiveModal('none')}>
                <X size={20} color={c.text2} />
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
                <Text color={c.text2} fontSize={12} marginTop="$2">
                  {t('workspaceDetail.preview')}
                </Text>
              </YStack>

              {/* Color Picker */}
              <YStack gap="$2" marginBottom="$4">
                <Text color={c.text2} fontSize={12} fontWeight="500">
                  {t('workspaceDetail.color')}
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
                          borderColor: isSelected ? c.text : 'transparent',
                        }}
                      >
                        {isSelected && <Check size={16} color={c.text} />}
                      </TouchableOpacity>
                    );
                  })}
                </XStack>
              </YStack>

              {/* Icon Picker */}
              <YStack gap="$2">
                <Text color={c.text2} fontSize={12} fontWeight="500">
                  {t('workspaceDetail.icon')}
                </Text>

                {/* Search input */}
                <TextInput
                  value={iconSearch}
                  onChangeText={setIconSearch}
                  placeholder={t('workspace.searchIconPlaceholder')}
                  placeholderTextColor={c.text3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    backgroundColor: isDark ? '#27272A' : 'rgba(10,10,15,0.05)',
                    color: c.text,
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    fontSize: 13,
                    borderWidth: 1,
                    borderColor: c.borderStrong,
                    marginBottom: 8,
                  }}
                />

                {/* Icon grid */}
                {(() => {
                  const icons = getFilteredIcons();
                  const palette =
                    COLOR_PALETTE[selectedColor as WorkspaceColor] || COLOR_PALETTE.amber;

                  if (icons.length === 0) {
                    return (
                      <Text color={c.text3} fontSize={12} textAlign="center" paddingVertical="$3">
                        {t('workspaceDetail.noIconsFound', { query: iconSearch })}
                      </Text>
                    );
                  }

                  return (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {icons.map((icon) => {
                        const isSelected = selectedIcon === icon;
                        const iconName = icon
                          .split('-')
                          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                          .join('');
                        const IconComponent = (LucideIcons as any)[iconName] || Folder;
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
                            <IconComponent
                              size={16}
                              color={isSelected ? palette['500'] : c.text2}
                            />
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  );
                })()}
              </YStack>
            </ScrollView>

            {/* Footer */}
            <XStack
              padding="$3"
              borderTopWidth={1}
              borderTopColor={c.border}
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
                  borderColor: c.borderStrong,
                }}
              >
                <Text color={c.text2} fontSize={13}>
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSaveAppearance}
                disabled={savingAppearance}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: semanticColors.indigo,
                  opacity: savingAppearance ? 0.5 : 1,
                  minWidth: 100,
                  alignItems: 'center',
                }}
              >
                {savingAppearance ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <Text color="#FFFFFF" fontSize={13} fontWeight="500">
                    {t('common.save')}
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
            backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 16,
          }}
        >
          <View
            style={{
              backgroundColor: c.bgCard,
              borderRadius: 12,
              width: '100%',
              maxWidth: 500,
              maxHeight: '80%',
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            {/* Header */}
            <XStack
              padding="$3"
              borderBottomWidth={1}
              borderBottomColor={c.border}
              justifyContent="space-between"
              alignItems="center"
            >
              <Text fontSize={16} fontWeight="600" color={c.text}>
                {t('workspaceDetail.editContext')}
              </Text>
              <TouchableOpacity onPress={() => setActiveModal('none')}>
                <X size={20} color={c.text2} />
              </TouchableOpacity>
            </XStack>

            {/* Content */}
            <View style={{ padding: 16, flex: 1 }}>
              <Text color={c.text2} fontSize={12} marginBottom="$2">
                {t('workspaceDetail.workspaceContextDescription')}
              </Text>

              <TextInput
                value={contextText}
                onChangeText={setContextText}
                multiline
                numberOfLines={8}
                placeholder={t('workspace.contextPlaceholder')}
                placeholderTextColor={c.text3}
                style={{
                  backgroundColor: isDark ? '#27272A' : 'rgba(10,10,15,0.05)',
                  color: c.text,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 14,
                  borderWidth: 1,
                  borderColor: c.border,
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
              borderTopColor={c.border}
              justifyContent="flex-end"
              gap="$2"
            >
              <TouchableOpacity
                onPress={() => setActiveModal('none')}
                disabled={savingContext}
                style={{ padding: 12, borderRadius: 6, backgroundColor: c.bgCardHover }}
              >
                <Text color={c.text} fontSize={13}>
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleSaveContext(contextText)}
                disabled={savingContext}
                style={{
                  padding: 12,
                  borderRadius: 6,
                  backgroundColor: savingContext ? 'rgba(94,106,210,0.50)' : semanticColors.indigo,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {savingContext ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <Text color="#FFFFFF" fontSize={13} fontWeight="500">
                    {t('common.save')}
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
