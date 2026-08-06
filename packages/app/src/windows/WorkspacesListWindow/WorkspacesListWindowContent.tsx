/**
 * Workspaces List Window Content
 *
 * Shows list of user's workspaces with ability to create new ones.
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border/text tokens.
 * - Uses `semanticColors` for brand accents (indigo, amber).
 * - Uses `indicators.risk` for the private-workspace amber glow.
 * - Uses `isDark` to switch dark-only rgba values to light equivalents.
 */

import {
  Archive,
  ChevronRight,
  Clock,
  Folder,
  HardDrive,
  Lock,
  Plus,
  Search,
  Users,
} from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { useToast } from '../../components/Toast';
import { useNavbarStore } from '../../store/navbarStore';
import { useTilingStore } from '../../store/tilingStore';
import type { WorkspacesListWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';
import { useColors } from '../../components/mca/primitives/useColors';
import {
  colors as semanticColors,
  indicators,
  surface,
} from '../../components/mca/primitives/colors';

interface WorkspaceListItem {
  workspaceId: string;
  name: string;
  description?: string;
  volumeId: string;
  role: 'owner' | 'admin' | 'write' | 'read';
  status: 'active' | 'archived';
  memberCount: number;
  appCount: number;
  createdAt: string;
  updatedAt: string;
  /** Workspace type — 'private' is the user's personal workspace and cannot be deleted/archived */
  type?: 'private' | 'shared';
}

interface WorkspacesListWindowContentProps extends WorkspacesListWindowProps {
  windowId: string;
}

export function WorkspacesListWindowContent({
  windowId,
  status: initialStatus,
  search: initialSearch,
}: WorkspacesListWindowContentProps) {
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  const [activeTab, setActiveTab] = useState<'active' | 'archived'>(
    initialStatus === 'archived' ? 'archived' : 'active',
  );
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(initialSearch || '');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceDescription, setNewWorkspaceDescription] = useState('');

  const client = getTerosClient();
  const toast = useToast();
  const { openWindow } = useTilingStore();

  // Theme-adaptive input style — shared by all TextInput fields
  const inputStyle = {
    backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: c.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: c.borderStrong,
  } as const;

  // Load workspaces on mount
  useEffect(() => {
    const loadData = async () => {
      if (client.isConnected()) {
        await loadWorkspaces();
      } else {
        const onConnected = () => {
          client.off('connected', onConnected);
          loadWorkspaces();
        };
        client.on('connected', onConnected);
        return () => {
          client.off('connected', onConnected);
        };
      }
    };
    loadData();
  }, []);

  const loadWorkspaces = async () => {
    setIsLoading(true);
    try {
      const { workspaces: data } = await client.workspace.listWorkspaces();
      setWorkspaces(data as any);
    } catch (err: any) {
      console.error('Error loading workspaces:', err);
      toast.error(t('common.error'), t('workspaces.loadError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      toast.error(t('common.error'), t('workspaces.nameRequired'));
      return;
    }

    setIsCreating(true);
    try {
      const { workspace } = await client.workspace.createWorkspace({
        name: newWorkspaceName.trim(),
        description: newWorkspaceDescription.trim() || undefined,
      });

      // Add to list
      setWorkspaces((prev) => [workspace as any, ...prev]);

      // Mirror into navbarStore so the sidebar reflects the new workspace
      // immediately. The WS event from backend will arrive shortly after with
      // the same id — addWorkspace is idempotent and absorbs the duplicate.
      useNavbarStore.getState().addWorkspace({
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        role: 'owner',
        volumeId: (workspace as any).volumeId,
        appearance: (workspace as any).appearance,
        type: (workspace as any).type,
      });

      // Reset form
      setNewWorkspaceName('');
      setNewWorkspaceDescription('');
      setShowCreateModal(false);

      toast.success(t('common.created'), t('workspaces.workspaceCreated', { name: workspace.name }));

      // Open the new workspace
      openWindow('workspace', { workspaceId: workspace.workspaceId }, false, windowId);
    } catch (err: any) {
      console.error('Error creating workspace:', err);
      toast.error(t('common.error'), err.message || t('workspaces.createError'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenWorkspace = (workspace: WorkspaceListItem) => {
    openWindow('workspace', { workspaceId: workspace.workspaceId }, false, windowId);
  };

  // Filter workspaces
  const filteredWorkspaces = workspaces
    .filter((ws) => {
      // Status filter
      if (activeTab === 'active' && ws.status !== 'active') return false;
      if (activeTab === 'archived' && ws.status !== 'archived') return false;

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return ws.name.toLowerCase().includes(query) || ws.description?.toLowerCase().includes(query);
      }
      return true;
    })
    .sort((a, b) => {
      if (a.type === 'private') return -1;
      if (b.type === 'private') return 1;
      return 0;
    });

  const activeCount = workspaces.filter((ws) => ws.status === 'active').length;
  const archivedCount = workspaces.filter((ws) => ws.status === 'archived').length;

  // Format date
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    });
  };

  // Render workspace card
  const renderWorkspaceCard = (workspace: WorkspaceListItem) => {
    const isPrivate = workspace.type === 'private';

    return (
      <TouchableOpacity
        key={workspace.workspaceId}
        onPress={() => handleOpenWorkspace(workspace)}
        activeOpacity={0.7}
        style={{
          backgroundColor: c.bgCard,
          borderRadius: 12,
          padding: 16,
          borderWidth: 1,
          borderColor: c.border,
          marginBottom: 8,
        }}
      >
        <XStack alignItems="flex-start" justifyContent="space-between">
          <XStack gap="$3" flex={1}>
            {/* Icon */}
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                backgroundColor: isPrivate ? indicators.risk.bg : semanticColors.indigoGlow,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              {isPrivate ? (
                <Lock size={20} color={semanticColors.amber} />
              ) : (
                <Folder size={22} color={semanticColors.indigo} />
              )}
            </View>

            {/* Content */}
            <YStack flex={1} gap={4}>
              <XStack alignItems="center" gap="$2">
                <Text fontSize={15} fontWeight="600" color={c.text} numberOfLines={1}>
                  {workspace.name}
                </Text>
                {isPrivate && (
                  <XStack
                    backgroundColor={indicators.risk.bg}
                    paddingHorizontal={6}
                    paddingVertical={2}
                    borderRadius={4}
                  >
                    <Text fontSize={10} color={semanticColors.amber} fontWeight="500">{t('workspaces.private')}</Text>
                  </XStack>
                )}
                <XStack
                  alignItems="center"
                  gap="$1"
                  backgroundColor={isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
                  paddingHorizontal={6}
                  paddingVertical={2}
                  borderRadius={4}
                >
                  <Text fontSize={10} color={c.text2}>
                    {t(`workspaces.role.${workspace.role}`)}
                  </Text>
                </XStack>
              </XStack>

              {workspace.description && (
                <Text fontSize={12} color={c.text2} numberOfLines={1}>
                  {workspace.description}
                </Text>
              )}

              {/* Stats row */}
              <XStack gap="$3" marginTop={4}>
                <XStack alignItems="center" gap="$1">
                  <Users size={12} color={c.text3} />
                  <Text fontSize={11} color={c.text3}>
                    {t('workspaces.memberCount', { count: workspace.memberCount })}
                  </Text>
                </XStack>
                <XStack alignItems="center" gap="$1">
                  <HardDrive size={12} color={c.text3} />
                  <Text fontSize={11} color={c.text3}>
                    {t('workspaces.appCount', { count: workspace.appCount })}
                  </Text>
                </XStack>
                <XStack alignItems="center" gap="$1">
                  <Clock size={12} color={c.text3} />
                  <Text fontSize={11} color={c.text3}>
                    {formatDate(workspace.updatedAt)}
                  </Text>
                </XStack>
              </XStack>
            </YStack>
          </XStack>

          {/* Arrow */}
          <ChevronRight size={18} color={c.text3} style={{ marginTop: 12 }} />
        </XStack>
      </TouchableOpacity>
    );
  };

  // Render tab button
  const renderTabButton = (tab: 'active' | 'archived', count: number, icon: any) => {
    const isActive = activeTab === tab;
    const Icon = icon;
    const label = tab === 'active' ? t('workspaces.active') : t('workspaces.archived');
    return (
      <TouchableOpacity
        onPress={() => setActiveTab(tab)}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 6,
          backgroundColor: isActive ? semanticColors.indigoGlow : 'transparent',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon size={14} color={isActive ? semanticColors.indigo : c.text2} />
        <Text
          fontSize={13}
          fontWeight={isActive ? '600' : '400'}
          color={isActive ? semanticColors.indigo : c.text2}
        >
          {label}
        </Text>
        <View
          style={{
            backgroundColor: isActive ? semanticColors.indigoGlow : (isDark ? 'rgba(39,39,42,0.6)' : c.bgInner),
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 10,
            minWidth: 20,
            alignItems: 'center',
          }}
        >
          <Text fontSize={10} color={isActive ? semanticColors.indigo : c.text2} fontWeight="500">
            {count}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header */}
      <YStack borderBottomWidth={1} borderBottomColor={c.border}>
        {/* Title row */}
        <XStack
          paddingHorizontal="$3"
          paddingTop="$2"
          paddingBottom="$2"
          justifyContent="space-between"
          alignItems="center"
        >
          <Text fontSize={16} fontWeight="600" color={c.text}>
            {t('windows.workspaces')}
          </Text>

          <XStack gap="$2" alignItems="center">
            {/* Search */}
            <XStack
              backgroundColor={isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
              borderRadius={6}
              paddingHorizontal="$2"
              paddingVertical="$1"
              alignItems="center"
              gap="$2"
              width={160}
              borderWidth={1}
              borderColor={c.borderStrong}
            >
              <Search size={12} color={c.text2} />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('common.search')}
                placeholderTextColor={c.text3}
                style={{
                  flex: 1,
                  color: c.text,
                  fontSize: 12,
                }}
              />
            </XStack>

            {/* Create button */}
            <TouchableOpacity
              onPress={() => setShowCreateModal(true)}
              style={{
                backgroundColor: semanticColors.indigoGlow,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Plus size={14} color={semanticColors.indigo} />
              <Text color={semanticColors.indigo} fontSize={12} fontWeight="500">
                {t('common.new')}
              </Text>
            </TouchableOpacity>
          </XStack>
        </XStack>

        {/* Tabs */}
        <XStack paddingHorizontal="$2" paddingBottom="$2" gap="$1">
          {renderTabButton('active', activeCount, Folder)}
          {renderTabButton('archived', archivedCount, Archive)}
        </XStack>
      </YStack>

      {/* Content */}
      {isLoading ? (
        <FullscreenLoader variant="default" label={t('common.loading')} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
          {filteredWorkspaces.length > 0 ? (
            filteredWorkspaces.map(renderWorkspaceCard)
          ) : (
            <YStack alignItems="center" padding="$6">
              {activeTab === 'archived' ? (
                <>
                  <Archive size={48} color={c.text3} />
                  <Text color={c.text3} marginTop="$3" textAlign="center" fontSize={13}>
                    {searchQuery
                      ? t('workspaces.noArchivedFound')
                      : t('workspaces.noArchived')}
                  </Text>
                </>
              ) : (
                <>
                  <Folder size={48} color={c.text3} />
                  <Text color={c.text3} marginTop="$3" textAlign="center" fontSize={13}>
                    {searchQuery ? t('workspaces.noWorkspacesFound') : t('workspaces.noWorkspaces')}
                  </Text>
                  {!searchQuery && (
                    <TouchableOpacity
                      onPress={() => setShowCreateModal(true)}
                      style={{ marginTop: 12 }}
                    >
                      <Text color={semanticColors.indigo} fontSize={13}>
                        {t('workspaces.createFirst')}
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </YStack>
          )}
        </ScrollView>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.4)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
        >
          <View
            style={{
              backgroundColor: c.bgCard,
              borderRadius: 12,
              padding: 20,
              width: '100%',
              maxWidth: 400,
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            <Text fontSize={18} fontWeight="600" color={c.text} marginBottom="$4">
              {t('workspaces.newWorkspace')}
            </Text>

            {/* Name input */}
            <YStack marginBottom="$3">
              <Text fontSize={12} color={c.text2} marginBottom="$1">
                {t('common.nameRequired')}
              </Text>
              <TextInput
                value={newWorkspaceName}
                onChangeText={setNewWorkspaceName}
                placeholder={t('workspaces.projectPlaceholder')}
                placeholderTextColor={c.text3}
                style={inputStyle}
                autoFocus
              />
            </YStack>

            {/* Description input */}
            <YStack marginBottom="$4">
              <Text fontSize={12} color={c.text2} marginBottom="$1">
                {t('common.descriptionOptional')}
              </Text>
              <TextInput
                value={newWorkspaceDescription}
                onChangeText={setNewWorkspaceDescription}
                placeholder={t('workspaces.descriptionPlaceholder')}
                placeholderTextColor={c.text3}
                multiline
                numberOfLines={3}
                style={{
                  ...inputStyle,
                  minHeight: 80,
                  textAlignVertical: 'top',
                }}
              />
            </YStack>

            {/* Info text */}
            <XStack
              backgroundColor={semanticColors.indigoGlow}
              padding="$2"
              borderRadius={8}
              marginBottom="$4"
              alignItems="flex-start"
              gap="$2"
            >
              <HardDrive size={14} color={semanticColors.indigo} style={{ marginTop: 2 }} />
              <Text fontSize={11} color={c.text2} flex={1}>
                {t('workspaces.storageVolumeInfo')}
              </Text>
            </XStack>

            {/* Buttons */}
            <XStack gap="$2" justifyContent="flex-end">
              <TouchableOpacity
                onPress={() => {
                  setShowCreateModal(false);
                  setNewWorkspaceName('');
                  setNewWorkspaceDescription('');
                }}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
                }}
              >
                <Text color={c.text2} fontSize={13} fontWeight="500">
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleCreateWorkspace}
                disabled={isCreating || !newWorkspaceName.trim()}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: semanticColors.indigo,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  opacity: newWorkspaceName.trim() ? 1 : 0.4,
                }}
              >
                {isCreating ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <>
                    <Plus size={14} color="#fff" />
                    <Text color="#fff" fontSize={13} fontWeight="500">
                      {t('common.create')}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </XStack>
          </View>
        </View>
      )}
    </YStack>
  );
}
