/**
 * App Window Content
 *
 * Configure an app instance: auth, permissions, rename, uninstall.
 */

import {
  AlertTriangle,
  Bot,
  Bug,
  Calendar,
  Check,
  CheckSquare,
  Clock,
  Cloud,
  Database,
  FileText,
  Folder,
  Globe,
  Mail,
  MessageSquare,
  Package,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from '@tamagui/lucide-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Image,
  Platform,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Separator, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import {
  AuthPanel,
  type CredentialField,
  type OAuthInfo,
  PermissionsPanel,
  type ToolPermission,
  type ToolWithPermission,
} from '../../components/apps';
import { useToast } from '../../components/Toast';
import type { AppWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

// Extended icon map matching AppsWindowContent
const iconMap: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  terminal: Terminal,
  folder: Folder,
  globe: Globe,
  package: Package,
  wrench: Wrench,
  message: MessageSquare,
  'message-square': MessageSquare,
  mail: Mail,
  calendar: Calendar,
  clock: Clock,
  database: Database,
  cloud: Cloud,
  settings: Settings,
  'check-square': CheckSquare,
  search: Search,
  bot: Bot,
  file: FileText,
  shield: Shield,
  bug: Bug,
  sparkles: Sparkles,
};

interface App {
  appId: string;
  name: string;
  mcaId: string;
  mcaName: string;
  description: string;
  category: string;
  status: string;
  icon?: string;
  color?: string;
}

interface BackendAuthInfo {
  status: 'ready' | 'needs_system_setup' | 'needs_user_auth' | 'expired' | 'error' | 'not_required';
  authType: 'oauth2' | 'apikey' | 'none';
  oauth?: {
    provider: string;
    connected: boolean;
    email?: string;
    expiresAt?: string;
    scopes?: string[];
  };
  apikey?: {
    configured: boolean;
    fields: Array<{
      name: string;
      label: string;
      type: 'text' | 'password';
      required: boolean;
      placeholder?: string;
      hint?: string;
    }>;
  };
  message?: string;
  error?: string;
}

interface BackendPermissionsData {
  appId: string;
  appName?: string;
  mcaName?: string;
  agentId?: string;
  defaultPermission: ToolPermission;
  tools: Array<{ name: string; permission: ToolPermission }>;
  summary: {
    allow: number;
    ask: number;
    forbid: number;
  };
}

interface AppWindowContentProps extends AppWindowProps {
  windowId: string;
}

export function AppWindowContent({ windowId, appId, workspaceId }: AppWindowContentProps) {
  const client = getTerosClient();
  const toast = useToast();
  const router = useRouter();

  const [app, setApp] = useState<App | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Auth state
  const [backendAuthInfo, setBackendAuthInfo] = useState<BackendAuthInfo | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Credentials state
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [hasCredentialChanges, setHasCredentialChanges] = useState(false);

  // Edit Context State
  const [editContextOpen, setEditContextOpen] = useState(false);
  const [contextText, setContextText] = useState('');
  const [isContextSaving, setIsContextSaving] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);

  // Permissions state
  const [permissionsData, setPermissionsData] = useState<BackendPermissionsData | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionsSaving, setPermissionsSaving] = useState(false);

  // Rename state
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Uninstall state
  const [isUninstalling, setIsUninstalling] = useState(false);

  // Helper functions
  const isImageUrl = (str?: string): boolean => {
    if (!str) return false;
    return str.startsWith('http://') || str.startsWith('https://');
  };

  const isEmoji = (str?: string): boolean => {
    if (!str) return false;
    return str.length <= 2 && /\p{Emoji}/u.test(str);
  };

  const getIcon = (
    iconName?: string,
  ): React.ComponentType<{ size?: number; color?: string }> | null => {
    if (!iconName) return Package;
    if (isImageUrl(iconName) || isEmoji(iconName)) {
      return null;
    }
    return iconMap[iconName.toLowerCase()] || Package;
  };

  const getOAuthInfo = (): OAuthInfo | null => {
    if (!backendAuthInfo || backendAuthInfo.authType !== 'oauth2') return null;

    const statusMap: Record<BackendAuthInfo['status'], OAuthInfo['status']> = {
      ready: 'connected',
      needs_user_auth: 'disconnected',
      expired: 'expired',
      error: 'error',
      needs_system_setup: 'error',
      not_required: 'disconnected',
    };

    return {
      provider: backendAuthInfo.oauth?.provider || 'OAuth',
      status: statusMap[backendAuthInfo.status] || 'disconnected',
      email: backendAuthInfo.oauth?.email,
      expiresAt: backendAuthInfo.oauth?.expiresAt,
      scopes: backendAuthInfo.oauth?.scopes,
      error: backendAuthInfo.error,
    };
  };

  const getCredentialFields = (): CredentialField[] => {
    if (!backendAuthInfo?.apikey?.fields) return [];

    return backendAuthInfo.apikey.fields.map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      required: field.required,
      placeholder: field.placeholder,
      hint: field.hint,
      value: credentialValues[field.name] || '',
      isSet: backendAuthInfo.apikey?.configured && !credentialValues[field.name],
    }));
  };

  // Load functions
  const loadAuthStatus = useCallback(
    async (targetAppId: string) => {
      setAuthLoading(true);
      try {
        const info = (await client.app.getAuthStatus(targetAppId)).auth;
        setBackendAuthInfo(info as any);
        setCredentialValues({});
        setHasCredentialChanges(false);
      } catch (err) {
        console.error('Failed to load auth status:', err);
        setBackendAuthInfo({
          status: 'error',
          authType: 'none',
          error: err instanceof Error ? err.message : 'Failed to load auth status',
        });
      } finally {
        setAuthLoading(false);
      }
    },
    [client],
  );

  const loadPermissions = useCallback(
    async (targetAppId: string) => {
      setPermissionsLoading(true);
      try {
        const data = await client.app.getTools(targetAppId) as BackendPermissionsData;
        setPermissionsData(data);
      } catch (err) {
        console.error('Failed to load permissions:', err);
      } finally {
        setPermissionsLoading(false);
      }
    },
    [client],
  );

  // Auth handlers
  const handleCredentialChange = useCallback((name: string, value: string) => {
    setCredentialValues((prev) => ({ ...prev, [name]: value }));
    setHasCredentialChanges(true);
  }, []);

  const handleSaveCredentials = useCallback(async () => {
    if (!app || !backendAuthInfo?.apikey?.fields) return;

    const emptyRequiredFields = backendAuthInfo.apikey.fields
      .filter((field) => field.required && !credentialValues[field.name]?.trim())
      .map((field) => field.label || field.name);

    if (emptyRequiredFields.length > 0) {
      toast.error('Campos requeridos', `Por favor completa: ${emptyRequiredFields.join(', ')}`);
      return;
    }

    setSavingCredentials(true);
    try {
      await client.app.configureCredentials(app.appId, credentialValues);
      toast.success('Guardado', 'Credenciales guardadas correctamente');
      setHasCredentialChanges(false);
      await loadAuthStatus(app.appId);
    } catch (err) {
      console.error('Save credentials failed:', err);
      toast.error('Error', err instanceof Error ? err.message : 'Error al guardar credenciales');
    } finally {
      setSavingCredentials(false);
    }
  }, [app, backendAuthInfo, credentialValues, client, toast, loadAuthStatus]);

  const handleConnect = useCallback(async () => {
    if (!app) return;

    setConnecting(true);
    try {
      await client.connectAppOAuth(app.appId);
      toast.success('Conectado', 'Cuenta conectada correctamente');
      await loadAuthStatus(app.appId);
    } catch (err) {
      console.error('OAuth connect failed:', err);
      toast.error('Error', err instanceof Error ? err.message : 'Error al conectar');
    } finally {
      setConnecting(false);
    }
  }, [app, client, toast, loadAuthStatus]);

  const handleDisconnect = useCallback(async () => {
    if (!app) return;

    setDisconnecting(true);
    try {
      await client.app.disconnectAuth(app.appId);
      toast.success('Desconectado', 'Cuenta desconectada correctamente');
      await loadAuthStatus(app.appId);
    } catch (err) {
      console.error('Disconnect failed:', err);
      toast.error('Error', err instanceof Error ? err.message : 'Error al desconectar');
    } finally {
      setDisconnecting(false);
    }
  }, [app, client, toast, loadAuthStatus]);

  const handleRefresh = useCallback(async () => {
    if (!app) return;
    await loadAuthStatus(app.appId);
  }, [app, loadAuthStatus]);

  // Permission handlers
  const handleToolPermissionChange = useCallback(
    async (toolName: string, permission: ToolPermission) => {
      if (!app || !permissionsData) return;

      const oldPermission =
        permissionsData.tools.find((t) => t.name === toolName)?.permission || 'ask';
      setPermissionsData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tools: prev.tools.map((t) => (t.name === toolName ? { ...t, permission } : t)),
          summary: {
            ...prev.summary,
            [oldPermission]: prev.summary[oldPermission] - 1,
            [permission]: prev.summary[permission] + 1,
          },
        };
      });

      setPermissionsSaving(true);
      try {
        await client.app.updateToolPermission(app.appId, toolName, permission);
      } catch (err) {
        console.error('Failed to update tool permission:', err);
        toast.error('Error', 'No se pudo actualizar el permiso');
        await loadPermissions(app.appId);
      } finally {
        setPermissionsSaving(false);
      }
    },
    [app, permissionsData, client, toast, loadPermissions],
  );

  const handleSetAllPermissions = useCallback(
    async (permission: ToolPermission) => {
      if (!app) return;

      setPermissionsSaving(true);
      try {
        await client.setAllToolPermissions(app.appId, permission);
        await loadPermissions(app.appId);
        toast.success('Actualizado', `Todos los permisos cambiados a "${permission}"`);
      } catch (err) {
        console.error('Failed to set all permissions:', err);
        toast.error('Error', 'No se pudieron actualizar los permisos');
      } finally {
        setPermissionsSaving(false);
      }
    },
    [app, client, toast, loadPermissions],
  );

  // Context handlers
  const startEditingContext = () => {
    if (app) {
      setContextText(app.context || '');
      setEditContextOpen(true);
    }
  };

  const handleSaveContext = async () => {
    if (!app || !contextText.trim()) return;

    setIsContextSaving(true);
    try {
      const result = await client.updateApp(app.appId, { context: contextText.trim() });

      if (result.error) {
        toast.error('Error', result.error || 'Failed to update app context');
        return;
      }

      toast.success('Guardado', 'Contexto actualizado');
      setEditContextOpen(false);
      setContextText('');
      setIsContextSaving(false);
    } catch (error) {
      console.error('Error saving app context:', error);
      toast.error('Error', 'Failed to update app context');
    } finally {
      setIsContextSaving(false);
    }
  };

  // Rename handlers
  const startEditing = () => {
    if (app) {
      setEditingName(app.name);
      setIsEditing(true);
    }
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditingName('');
  };

  const handleRename = useCallback(async () => {
    if (!app) return;

    const trimmedName = editingName.trim();
    if (!trimmedName || trimmedName === app.name) {
      cancelEditing();
      return;
    }

    setIsRenaming(true);
    try {
      await client.app.renameApp(app.appId, trimmedName);
      setApp((prev) => (prev ? { ...prev, name: trimmedName } : prev));
      toast.success('Renombrada', `App renombrada a "${trimmedName}"`);
      cancelEditing();
    } catch (err: any) {
      console.error('Error renaming app:', err);
      toast.error('Error', err.message || 'No se pudo renombrar la app');
    } finally {
      setIsRenaming(false);
    }
  }, [app, editingName, client, toast]);

  // Uninstall handler
  const handleUninstall = useCallback(async () => {
    if (!app) return;

    const doUninstall = async () => {
      setIsUninstalling(true);
      try {
        await client.app.uninstallApp(app.appId);
        toast.success('Desinstalada', `${app.name} desinstalada correctamente`);
        // Navigate back to apps list
        router.back();
      } catch (err: any) {
        console.error('Error uninstalling app:', err);
        toast.error('Error', err.message || 'No se pudo desinstalar la app');
        setIsUninstalling(false);
      }
    };

    // Show confirmation - use window.confirm on web, Alert on native
    if (Platform.OS === 'web') {
      const confirmed = window.confirm(
        `Are you sure you want to uninstall "${app.name}"? This action cannot be undone.`,
      );
      if (confirmed) {
        await doUninstall();
      }
    } else {
      Alert.alert(
        'Uninstall app',
        `Are you sure you want to uninstall "${app.name}"? This action cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Uninstall',
            style: 'destructive',
            onPress: doUninstall,
          },
        ],
      );
    }
  }, [app, client, toast, router]);

  // Load app on mount
  useEffect(() => {
    const loadApp = async () => {
      if (!appId) {
        setError('No app ID provided');
        setLoading(false);
        return;
      }

      try {
        // Use workspaceId to find apps in the correct scope
        const apps = workspaceId
          ? await client.listWorkspaceApps(workspaceId)
          : (await client.app.listApps()).apps;

        const found = apps.find(
          (a) =>
            a.appId === appId ||
            a.appId === `app:${appId}` ||
            a.appId.replace('app:', '') === appId,
        );

        if (found) {
          setApp(found as any);
          loadAuthStatus(found.appId);
          loadPermissions(found.appId);
        } else {
          setError(`App not found: ${appId}`);
        }
      } catch (err) {
        console.error('Failed to load app:', err);
        setError(err instanceof Error ? err.message : 'Failed to load app');
      } finally {
        setLoading(false);
      }
    };

    if (client.isConnected()) {
      loadApp();
    } else {
      const onConnected = () => {
        loadApp();
        client.off('connected', onConnected);
      };
      client.on('connected', onConnected);
      return () => {
        client.off('connected', onConnected);
      };
    }
  }, [appId, workspaceId, client, loadAuthStatus, loadPermissions]);

  if (loading) {
    return (
      <FullscreenLoader variant="default" label="Cargando app..." />
    );
  }

  if (error) {
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$4"
        backgroundColor="#09090B"
      >
        <AlertTriangle size={40} color="#EF4444" />
        <Text color="#EF4444" textAlign="center" marginTop="$3">
          {error}
        </Text>
      </YStack>
    );
  }

  const oauthInfo = getOAuthInfo();
  const credentialFields = getCredentialFields();
  const tools: ToolWithPermission[] = permissionsData?.tools || [];
  const IconComponent = getIcon(app?.icon);

  return (
    <YStack flex={1} backgroundColor="#09090B">
      {/* Header */}
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        alignItems="center"
        gap="$3"
        borderBottomWidth={1}
        borderBottomColor="rgba(39, 39, 42, 0.6)"
      >
        {/* Icon */}
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            backgroundColor: app?.color || 'rgba(168, 85, 247, 0.15)',
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'hidden',
          }}
        >
          {isImageUrl(app?.icon) ? (
            <Image
              source={{ uri: app?.icon }}
              style={{ width: 20, height: 20 }}
              resizeMode="contain"
            />
          ) : isEmoji(app?.icon) ? (
            <Text fontSize={18}>{app?.icon}</Text>
          ) : IconComponent ? (
            <IconComponent size={18} color="#FAFAFA" />
          ) : (
            <Package size={18} color="#FAFAFA" />
          )}
        </View>

        {/* Title / Edit */}
        <YStack flex={1}>
          {isEditing ? (
            <XStack alignItems="center" gap="$2">
              <TextInput
                value={editingName}
                onChangeText={setEditingName}
                onSubmitEditing={handleRename}
                autoFocus
                style={{
                  flex: 1,
                  color: '#FAFAFA',
                  fontSize: 14,
                  fontWeight: '600',
                  backgroundColor: 'rgba(39, 39, 42, 0.6)',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor: 'rgba(59, 130, 246, 0.5)',
                }}
              />
              <TouchableOpacity onPress={handleRename} disabled={isRenaming} style={{ padding: 4 }}>
                {isRenaming ? (
                  <AppSpinner size="sm" variant="default" />
                ) : (
                  <Check size={16} color="#10B981" />
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={cancelEditing} style={{ padding: 4 }}>
                <X size={16} color="#71717A" />
              </TouchableOpacity>
            </XStack>
          ) : (
            <>
              <Text fontSize={15} fontWeight="600" color="#FAFAFA" numberOfLines={1}>
                {app?.name || appId}
              </Text>
              <Text fontSize={11} color="#71717A">
                {app?.mcaName || app?.mcaId}
              </Text>
            </>
          )}
        </YStack>

        {/* Actions */}
        {!isEditing && (
          <XStack gap="$1">
            <TouchableOpacity
              onPress={() => app && loadAuthStatus(app.appId)}
              disabled={authLoading}
              style={{ padding: 8 }}
            >
              {authLoading ? (
                <AppSpinner size="sm" variant="default" />
              ) : (
                <RefreshCw size={16} color="#71717A" />
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={startEditing} style={{ padding: 8 }}>
              <Pencil size={16} color="#71717A" />
            </TouchableOpacity>
          </XStack>
        )}
      </XStack>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
        {app && (
          <YStack gap="$3">
            {/* Description Card */}
            {app.description && (
              <YStack
                backgroundColor="rgba(24, 24, 27, 0.9)"
                borderRadius={12}
                padding="$3"
                borderWidth={1}
                borderColor="rgba(39, 39, 42, 0.6)"
              >
                <Text color="#A1A1AA" fontSize={13} lineHeight={20}>
                  {app.description}
                </Text>
                <XStack marginTop="$2" gap="$2" flexWrap="wrap">
                  <View
                    style={{
                      backgroundColor: 'rgba(39, 39, 42, 0.6)',
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 4,
                    }}
                  >
                    <Text fontSize={11} color="#71717A">
                      {app.category}
                    </Text>
                  </View>
                  <View
                    style={{
                      backgroundColor:
                        app.status === 'active'
                          ? 'rgba(16, 185, 129, 0.15)'
                          : 'rgba(113, 113, 122, 0.15)',
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 4,
                    }}
                  >
                    <Text fontSize={11} color={app.status === 'active' ? '#10B981' : '#71717A'}>
                      {app.status}
                    </Text>
                  </View>
                </XStack>
              </YStack>
            )}

            {/* Context Card */}
            <YStack
              backgroundColor="rgba(24, 24, 27, 0.9)"
              borderRadius={12}
              padding="$3"
              borderWidth={1}
              borderColor="rgba(39, 39, 42, 0.6)"
              gap="$2"
            >
              <XStack justifyContent="space-between" alignItems="center">
                <Text fontSize={13} fontWeight="600" color="#FAFAFA">
                  Contexto
                </Text>
                <TouchableOpacity onPress={startEditingContext} style={{ padding: 4 }}>
                  <Pencil size={14} color="#71717A" />
                </TouchableOpacity>
              </XStack>
              {app?.context ? (
                <Text
                  color="#A1A1AA"
                  fontSize={12}
                  lineHeight={18}
                  style={{ maxHeight: 120, overflow: 'hidden' }}
                >
                  {app.context}
                </Text>
              ) : (
                <Text color="#52525B" fontSize={12} fontStyle="italic">
                  No context configured. Tap the pencil icon to add context.
                </Text>
              )}
            </YStack>

            {/* Auth Panel */}
            <AuthPanel
              oauth={oauthInfo}
              credentials={credentialFields}
              loading={authLoading}
              hasChanges={hasCredentialChanges}
              saving={savingCredentials}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onRefresh={handleRefresh}
              connecting={connecting}
              disconnecting={disconnecting}
              onCredentialChange={handleCredentialChange}
              onSaveCredentials={handleSaveCredentials}
              defaultExpanded={true}
            />

            {/* Permissions Panel */}
            {tools.length > 0 && (
              <PermissionsPanel
                tools={tools}
                summary={permissionsData?.summary}
                loading={permissionsLoading}
                saving={permissionsSaving}
                onToolPermissionChange={handleToolPermissionChange}
                onSetAllPermissions={handleSetAllPermissions}
                defaultExpanded={false}
              />
            )}

            <Separator marginVertical="$2" backgroundColor="rgba(39, 39, 42, 0.6)" />

            {/* Danger Zone */}
            <YStack
              backgroundColor="rgba(239, 68, 68, 0.05)"
              borderRadius={12}
              padding="$3"
              borderWidth={1}
              borderColor="rgba(239, 68, 68, 0.2)"
              gap="$3"
            >
              <Text fontSize={13} fontWeight="600" color="#EF4444">
                Zona de peligro
              </Text>

              <TouchableOpacity
                onPress={handleUninstall}
                disabled={isUninstalling}
                style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  opacity: isUninstalling ? 0.5 : 1,
                }}
              >
                {isUninstalling ? (
                  <AppSpinner size="sm" variant="danger" />
                ) : (
                  <>
                    <Trash2 size={16} color="#EF4444" />
                    <Text color="#EF4444" fontSize={13} fontWeight="500">
                      Desinstalar app
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <Text fontSize={11} color="#71717A">
                This action will remove the app and all its settings. This cannot be undone.
              </Text>
            </YStack>
          </YStack>
        )}
      </ScrollView>

      {/* Context Edit Modal */}
      {editContextOpen && (
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
            padding: 20,
            zIndex: 1000,
          }}
        >
          <View
            style={{
              backgroundColor: '#18181B',
              borderRadius: 12,
              padding: 20,
              width: '100%',
              maxWidth: 500,
              maxHeight: '80%',
            }}
          >
            <Text fontSize={16} fontWeight="600" color="#FAFAFA" marginBottom={16}>
              Editar Contexto
            </Text>

            <TextInput
              value={contextText}
              onChangeText={setContextText}
              multiline
              numberOfLines={8}
              placeholder="Add context about this app..."
              placeholderTextColor="#52525B"
              style={{
                backgroundColor: '#27272A',
                color: '#FAFAFA',
                borderRadius: 8,
                padding: 12,
                fontSize: 14,
                lineHeight: 20,
                textAlignVertical: 'top',
                minHeight: 120,
                borderWidth: 1,
                borderColor: 'rgba(39, 39, 42, 0.6)',
              }}
            />

            <XStack gap={12} marginTop={20} justifyContent="flex-end">
              <TouchableOpacity
                onPress={() => {
                  setEditContextOpen(false);
                  setContextText('');
                  setIsContextSaving(false);
                }}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: '#27272A',
                }}
              >
                <Text color="#71717A" fontSize={14} fontWeight="500">
                  Cancelar
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleSaveContext}
                disabled={isContextSaving || !contextText.trim()}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: contextText.trim() ? '#3B82F6' : '#374151',
                  opacity: isContextSaving || !contextText.trim() ? 0.5 : 1,
                }}
              >
                {isContextSaving ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <Text color="#FFFFFF" fontSize={14} fontWeight="500">
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
