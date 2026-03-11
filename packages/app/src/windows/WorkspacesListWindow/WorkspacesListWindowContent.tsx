/**
 * Workspaces List Window Content
 *
 * Shows list of user's workspaces with ability to create new ones.
 */

import {
  Archive,
  ChevronRight,
  Clock,
  Crown,
  Edit2,
  Folder,
  HardDrive,
  Plus,
  Search,
  Settings,
  Users,
} from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useToast } from '../../components/Toast';
import { useTilingStore } from '../../store/tilingStore';
import type { WorkspacesListWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

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
}

// Role display info
const roleInfo: Record<string, { label: string; color: string; icon: any }> = {
  owner: { label: 'Propietario', color: '#FFD700', icon: Crown },
  admin: { label: 'Admin', color: '#9B59B6', icon: Settings },
  write: { label: 'Editor', color: '#3498DB', icon: Edit2 },
  read: { label: 'Lector', color: '#95A5A6', icon: Users },
};

type TabType = 'active' | 'archived';

interface WorkspacesListWindowContentProps extends WorkspacesListWindowProps {
  windowId: string;
}

export function WorkspacesListWindowContent({
  windowId,
  status: initialStatus,
  search: initialSearch,
}: WorkspacesListWindowContentProps) {
  const [activeTab, setActiveTab] = useState<TabType>(
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
      const data = await client.listWorkspaces();
      setWorkspaces(data);
    } catch (err: any) {
      console.error('Error loading workspaces:', err);
      toast.error('Error', 'No se pudieron cargar los workspaces');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      toast.error('Error', 'El nombre es requerido');
      return;
    }

    setIsCreating(true);
    try {
      const workspace = await client.createWorkspace(
        newWorkspaceName.trim(),
        newWorkspaceDescription.trim() || undefined,
      );

      // Add to list
      setWorkspaces((prev) => [workspace, ...prev]);

      // Reset form
      setNewWorkspaceName('');
      setNewWorkspaceDescription('');
      setShowCreateModal(false);

      toast.success('Creado', `Workspace "${workspace.name}" creado`);

      // Open the new workspace
      openWindow('workspace', { workspaceId: workspace.workspaceId }, false, windowId);
    } catch (err: any) {
      console.error('Error creating workspace:', err);
      toast.error('Error', err.message || 'No se pudo crear el workspace');
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenWorkspace = (workspace: WorkspaceListItem) => {
    openWindow('workspace', { workspaceId: workspace.workspaceId }, false, windowId);
  };

  // Filter workspaces
  const filteredWorkspaces = workspaces.filter((ws) => {
    // Status filter
    if (activeTab === 'active' && ws.status !== 'active') return false;
    if (activeTab === 'archived' && ws.status !== 'archived') return false;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return ws.name.toLowerCase().includes(query) || ws.description?.toLowerCase().includes(query);
    }
    return true;
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
    const role = roleInfo[workspace.role];
    const RoleIcon = role.icon;

    return (
      <TouchableOpacity
        key={workspace.workspaceId}
        onPress={() => handleOpenWorkspace(workspace)}
        activeOpacity={0.7}
        style={{
          backgroundColor: 'rgba(24, 24, 27, 0.9)',
          borderRadius: 12,
          padding: 16,
          borderWidth: 1,
          borderColor: 'rgba(39, 39, 42, 0.6)',
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
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Folder size={22} color="#3B82F6" />
            </View>

            {/* Content */}
            <YStack flex={1} gap={4}>
              <XStack alignItems="center" gap="$2">
                <Text fontSize={15} fontWeight="600" color="#FAFAFA" numberOfLines={1}>
                  {workspace.name}
                </Text>
                <XStack
                  alignItems="center"
                  gap="$1"
                  backgroundColor="rgba(39, 39, 42, 0.6)"
                  paddingHorizontal={6}
                  paddingVertical={2}
                  borderRadius={4}
                >
                  <RoleIcon size={10} color={role.color} />
                  <Text fontSize={10} color={role.color}>
                    {role.label}
                  </Text>
                </XStack>
              </XStack>

              {workspace.description && (
                <Text fontSize={12} color="#71717A" numberOfLines={1}>
                  {workspace.description}
                </Text>
              )}

              {/* Stats row */}
              <XStack gap="$3" marginTop={4}>
                <XStack alignItems="center" gap="$1">
                  <Users size={12} color="#52525B" />
                  <Text fontSize={11} color="#52525B">
                    {workspace.memberCount} {workspace.memberCount === 1 ? 'miembro' : 'miembros'}
                  </Text>
                </XStack>
                <XStack alignItems="center" gap="$1">
                  <HardDrive size={12} color="#52525B" />
                  <Text fontSize={11} color="#52525B">
                    {workspace.appCount} {workspace.appCount === 1 ? 'app' : 'apps'}
                  </Text>
                </XStack>
                <XStack alignItems="center" gap="$1">
                  <Clock size={12} color="#52525B" />
                  <Text fontSize={11} color="#52525B">
                    {formatDate(workspace.updatedAt)}
                  </Text>
                </XStack>
              </XStack>
            </YStack>
          </XStack>

          {/* Arrow */}
          <ChevronRight size={18} color="#3F3F46" style={{ marginTop: 12 }} />
        </XStack>
      </TouchableOpacity>
    );
  };

  // Render tab button
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
      <YStack borderBottomWidth={1} borderBottomColor="rgba(39, 39, 42, 0.6)">
        {/* Title row */}
        <XStack
          paddingHorizontal="$3"
          paddingTop="$2"
          paddingBottom="$2"
          justifyContent="space-between"
          alignItems="center"
        >
          <Text fontSize={16} fontWeight="600" color="#FAFAFA">
            Workspaces
          </Text>

          <XStack gap="$2" alignItems="center">
            {/* Search */}
            <XStack
              backgroundColor="rgba(39, 39, 42, 0.6)"
              borderRadius={6}
              paddingHorizontal="$2"
              paddingVertical="$1"
              alignItems="center"
              gap="$2"
              width={160}
              borderWidth={1}
              borderColor="rgba(63, 63, 70, 0.5)"
            >
              <Search size={12} color="#71717A" />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Buscar..."
                placeholderTextColor="#52525B"
                style={{
                  flex: 1,
                  color: '#FAFAFA',
                  fontSize: 12,
                }}
              />
            </XStack>

            {/* Create button */}
            <TouchableOpacity
              onPress={() => setShowCreateModal(true)}
              style={{
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Plus size={14} color="#3B82F6" />
              <Text color="#3B82F6" fontSize={12} fontWeight="500">
                Nuevo
              </Text>
            </TouchableOpacity>
          </XStack>
        </XStack>

        {/* Tabs */}
        <XStack paddingHorizontal="$2" paddingBottom="$2" gap="$1">
          {renderTabButton('active', 'Activos', activeCount, Folder)}
          {renderTabButton('archived', 'Archivados', archivedCount, Archive)}
        </XStack>
      </YStack>

      {/* Content */}
      {isLoading ? (
        <FullscreenLoader variant="default" label="Cargando..." />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
          {filteredWorkspaces.length > 0 ? (
            filteredWorkspaces.map(renderWorkspaceCard)
          ) : (
            <YStack alignItems="center" padding="$6">
              {activeTab === 'archived' ? (
                <>
                  <Archive size={48} color="#27272A" />
                  <Text color="#52525B" marginTop="$3" textAlign="center" fontSize={13}>
                    {searchQuery
                      ? 'No se encontraron workspaces archivados'
                      : 'No tienes workspaces archivados'}
                  </Text>
                </>
              ) : (
                <>
                  <Folder size={48} color="#27272A" />
                  <Text color="#52525B" marginTop="$3" textAlign="center" fontSize={13}>
                    {searchQuery ? 'No se encontraron workspaces' : 'No tienes workspaces'}
                  </Text>
                  {!searchQuery && (
                    <TouchableOpacity
                      onPress={() => setShowCreateModal(true)}
                      style={{ marginTop: 12 }}
                    >
                      <Text color="#3B82F6" fontSize={13}>
                        Crear tu primer workspace →
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
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
        >
          <View
            style={{
              backgroundColor: '#18181B',
              borderRadius: 12,
              padding: 20,
              width: '100%',
              maxWidth: 400,
              borderWidth: 1,
              borderColor: 'rgba(39, 39, 42, 0.6)',
            }}
          >
            <Text fontSize={18} fontWeight="600" color="#FAFAFA" marginBottom="$4">
              Nuevo Workspace
            </Text>

            {/* Name input */}
            <YStack marginBottom="$3">
              <Text fontSize={12} color="#A1A1AA" marginBottom="$1">
                Nombre *
              </Text>
              <TextInput
                value={newWorkspaceName}
                onChangeText={setNewWorkspaceName}
                placeholder="Mi proyecto"
                placeholderTextColor="#52525B"
                style={{
                  backgroundColor: 'rgba(39, 39, 42, 0.6)',
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: '#FAFAFA',
                  fontSize: 14,
                  borderWidth: 1,
                  borderColor: 'rgba(63, 63, 70, 0.5)',
                }}
                autoFocus
              />
            </YStack>

            {/* Description input */}
            <YStack marginBottom="$4">
              <Text fontSize={12} color="#A1A1AA" marginBottom="$1">
                Description (optional)
              </Text>
              <TextInput
                value={newWorkspaceDescription}
                onChangeText={setNewWorkspaceDescription}
                placeholder="Workspace description..."
                placeholderTextColor="#52525B"
                multiline
                numberOfLines={3}
                style={{
                  backgroundColor: 'rgba(39, 39, 42, 0.6)',
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: '#FAFAFA',
                  fontSize: 14,
                  borderWidth: 1,
                  borderColor: 'rgba(63, 63, 70, 0.5)',
                  minHeight: 80,
                  textAlignVertical: 'top',
                }}
              />
            </YStack>

            {/* Info text */}
            <XStack
              backgroundColor="rgba(59, 130, 246, 0.1)"
              padding="$2"
              borderRadius={8}
              marginBottom="$4"
              alignItems="flex-start"
              gap="$2"
            >
              <HardDrive size={14} color="#3B82F6" style={{ marginTop: 2 }} />
              <Text fontSize={11} color="#71717A" flex={1}>
                A storage volume will be created for the workspace where apps can
                guardar archivos.
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
                  backgroundColor: 'rgba(39, 39, 42, 0.6)',
                }}
              >
                <Text color="#A1A1AA" fontSize={13} fontWeight="500">
                  Cancelar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleCreateWorkspace}
                disabled={isCreating || !newWorkspaceName.trim()}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: newWorkspaceName.trim() ? '#3B82F6' : 'rgba(59, 130, 246, 0.3)',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {isCreating ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <>
                    <Plus size={14} color="white" />
                    <Text color="white" fontSize={13} fontWeight="500">
                      Crear
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
