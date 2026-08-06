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
  ChevronDown,
  Clock,
  Cloud,
  Database,
  FileText,
  Folder,
  Globe,
  Link2,
  Mail,
  MessageSquare,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Trash2,
  Unlink,
  Wrench,
  X,
} from '@tamagui/lucide-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Image,
  Platform,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { colors, controlsBar, indicators } from '../../components/mca/primitives/colors';
import { FONT_MONO, FONT_SANS } from '../../components/mca/primitives/fonts';
import { useColors } from '../../components/mca/primitives/useColors';
import { Avatar } from '../../components/mca/primitives/Avatar';
import { gradientFromColors } from '../../components/mca/heroWash';
import { getTerosClient } from '../../services/terosClientSingleton';
import type { AgentAccess } from '../../services/AppApi';
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
import { useWorkspaceStore } from '../../store/workspaceStore';

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
  context?: string;
  accentColors?: string[];
}

interface BackendAuthExtraField {
  name: string;
  label: string;
  type: 'text' | 'password';
  required: boolean;
  placeholder?: string;
  hint?: string;
  value?: string;
}

interface BackendAuthInfo {
  status: 'ready' | 'needs_system_setup' | 'needs_user_auth' | 'expired' | 'error' | 'not_required';
  authType: 'oauth2' | 'apikey' | 'none' | 'github-app';
  oauth?: {
    provider: string;
    connected: boolean;
    email?: string;
    /** GitHub `login` / Notion `name` etc. — preferred over email when present. */
    userLogin?: string;
    expiresAt?: string;
    scopes?: string[];
    extraFields?: BackendAuthExtraField[];
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
  githubApp?: {
    installed: boolean;
    appSlug: string;
    installationId?: string;
    account?: string;
    repositoryCount?: number;
    manageUrl?: string;
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
  tools: Array<{ name: string; permission: ToolPermission; autoAllowed?: boolean }>;
  summary: {
    allow: number;
    ask: number;
    forbid: number;
  };
}

interface AppWindowContentProps extends AppWindowProps {
  windowId: string;
}

// ─── Presentation helpers (pure — no state/logic) ───────────────────────────
//
// These derive UI-only descriptors from the auth/permissions state that the
// component already holds. They read state; they never mutate it. The backend
// remains the source of truth for the connection status — here we only map it
// to a colour + label for the hero status pill.

type ConnState = 'connected' | 'needs_signin' | 'needs_admin' | 'error' | 'none';

/**
 * Hero status pill descriptor. Derived purely from the backend auth info so the
 * pill colour matches the AuthPanel's own status dot — single source of truth,
 * two surfaces.
 */
function deriveConnection(info: BackendAuthInfo | null): {
  state: ConnState;
  label: string;
  identity?: string;
} {
  if (!info || info.authType === 'none' || info.status === 'not_required') {
    return { state: 'none', label: 'No auth required' };
  }
  // Identity for the "Connected as …" transparency line (HubSpot/Salesforce
  // pattern): prefer the provider handle, fall back to email.
  const identity = info.oauth?.userLogin
    ? `@${info.oauth.userLogin}`
    : info.oauth?.email ?? info.githubApp?.account;
  switch (info.status) {
    case 'ready':
      return { state: 'connected', label: 'Connected', identity };
    case 'needs_system_setup':
      return { state: 'needs_admin', label: 'Needs admin setup' };
    case 'expired':
      return { state: 'error', label: 'Session expired', identity };
    case 'error':
      return { state: 'error', label: 'Connection error' };
    default:
      return { state: 'needs_signin', label: 'Needs sign-in' };
  }
}

/**
 * Access toggle — a 44×24 track with a sliding knob. Indigo when on, the
 * caller's neutral `trackOff` when off. Mirrors the toggle used in the
 * AgentWindow's Apps/Skills tabs so both directions of the relationship feel
 * identical, but reads its accent from the design-system token.
 */
function AgentAccessToggle({
  on,
  busy,
  trackOff,
  onToggle,
}: {
  on: boolean;
  busy: boolean;
  trackOff: string;
  onToggle: () => void;
}) {
  return (
    <XStack
      width={44}
      height={24}
      borderRadius={12}
      backgroundColor={on ? colors.indigo : trackOff}
      alignItems="center"
      paddingHorizontal={3}
      cursor={busy ? 'default' : 'pointer'}
      opacity={busy ? 0.6 : 1}
      onPress={busy ? undefined : onToggle}
      hoverStyle={busy ? undefined : { backgroundColor: on ? colors.indigoLight : trackOff }}
    >
      <YStack
        width={18}
        height={18}
        borderRadius={9}
        backgroundColor="#FFFFFF"
        style={{ transform: [{ translateX: on ? 20 : 0 }] } as object}
      />
    </XStack>
  );
}

/** Section label — uppercase + letter-spacing, matching CatalogDetailWindow. */
function SectionLabel({ text, textColor }: { text: string; textColor: string }) {
  return (
    <Text
      fontFamily={FONT_SANS}
      fontSize={10.5}
      fontWeight="600"
      color={textColor}
      textTransform="uppercase"
      letterSpacing={0.8}
    >
      {text}
    </Text>
  );
}

export function AppWindowContent({ windowId, appId, workspaceId }: AppWindowContentProps) {
  const { t } = useTranslation();
  const c = useColors();
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

  // Agent access state — which of the workspace's agents can use this app.
  const [agentAccess, setAgentAccess] = useState<AgentAccess[]>([]);
  const [agentAccessLoading, setAgentAccessLoading] = useState(false);
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null);

  // Rename state
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Uninstall state
  const [isUninstalling, setIsUninstalling] = useState(false);

  // Progressive disclosure (UI-only): instructions preview is hidden until the
  // user expands it. Drives nothing on the backend — the actual edit still goes
  // through the existing context modal + handleSaveContext.
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

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
    if (!backendAuthInfo) return null;

    const statusMap: Record<BackendAuthInfo['status'], OAuthInfo['status']> = {
      ready: 'connected',
      needs_user_auth: 'disconnected',
      expired: 'expired',
      error: 'error',
      needs_system_setup: 'error',
      not_required: 'disconnected',
    };

    if (backendAuthInfo.authType === 'github-app') {
      // GitHub App with userOAuth: backend populates `oauth` with the user's
      // login, email and expiry. Surface @login as primary identity.
      return {
        provider: 'GitHub',
        status: statusMap[backendAuthInfo.status] || 'disconnected',
        authType: 'github-app',
        installationId: backendAuthInfo.githubApp?.installationId,
        appSlug: backendAuthInfo.githubApp?.appSlug,
        userLogin: backendAuthInfo.oauth?.userLogin,
        email: backendAuthInfo.oauth?.email
          ?? (backendAuthInfo.githubApp?.account
            ? `@${backendAuthInfo.githubApp.account}`
            : undefined),
        expiresAt: backendAuthInfo.oauth?.expiresAt,
        error: backendAuthInfo.error,
      };
    }

    if (backendAuthInfo.authType !== 'oauth2') return null;

    return {
      provider: backendAuthInfo.oauth?.provider || 'OAuth',
      status: statusMap[backendAuthInfo.status] || 'disconnected',
      authType: 'oauth2',
      email: backendAuthInfo.oauth?.email,
      userLogin: backendAuthInfo.oauth?.userLogin,
      expiresAt: backendAuthInfo.oauth?.expiresAt,
      scopes: backendAuthInfo.oauth?.scopes,
      error: backendAuthInfo.error,
    };
  };

  const getCredentialFields = (): CredentialField[] => {
    const fields: CredentialField[] = [];

    // Standard API key fields
    if (backendAuthInfo?.apikey?.fields) {
      fields.push(
        ...backendAuthInfo.apikey.fields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          hint: field.hint,
          value: credentialValues[field.name] || '',
          isSet: !!(backendAuthInfo.apikey?.configured && !credentialValues[field.name]),
        })),
      );
    }

    // Extra fields for OAuth apps (e.g., TEAM_ID for Figma)
    if (backendAuthInfo?.oauth?.extraFields) {
      fields.push(
        ...backendAuthInfo.oauth.extraFields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          hint: field.hint,
          // Local edits take priority; fall back to server-stored value
          value: credentialValues[field.name] !== undefined
            ? credentialValues[field.name]
            : (field.value || ''),
          isSet: !!(field.value && credentialValues[field.name] === undefined),
        })),
      );
    }

    return fields;
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
          error: err instanceof Error ? err.message : t('errors.app.authStatusFailed'),
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

  const loadAgentAccess = useCallback(
    async (targetAppId: string) => {
      setAgentAccessLoading(true);
      try {
        const { agents } = await client.app.listAgentAccess(targetAppId);
        setAgentAccess(agents);
      } catch (err) {
        console.error('Failed to load agent access:', err);
      } finally {
        setAgentAccessLoading(false);
      }
    },
    [client],
  );

  const handleToggleAgent = useCallback(
    async (agentId: string, nextHasAccess: boolean) => {
      if (!app || togglingAgentId) return;
      setTogglingAgentId(agentId);
      // Optimistic flip — revert on error so the switch never lies.
      setAgentAccess((prev) =>
        prev.map((a) => (a.agentId === agentId ? { ...a, hasAccess: nextHasAccess } : a)),
      );
      try {
        if (nextHasAccess) {
          await client.app.grantAccess(agentId, app.appId);
        } else {
          await client.app.revokeAccess(agentId, app.appId);
        }
      } catch (err) {
        console.error('Failed to toggle agent access:', err);
        setAgentAccess((prev) =>
          prev.map((a) => (a.agentId === agentId ? { ...a, hasAccess: !nextHasAccess } : a)),
        );
        toast.error(
          nextHasAccess ? t('apps.errorGrantingAccess', 'Could not grant access') : t('apps.errorRevokingAccess', 'Could not revoke access'),
          err instanceof Error ? err.message : t('common.error', 'Error'),
        );
      } finally {
        setTogglingAgentId(null);
      }
    },
    [app, togglingAgentId, client, toast, t],
  );

  // Auth handlers
  const handleCredentialChange = useCallback((name: string, value: string) => {
    setCredentialValues((prev) => ({ ...prev, [name]: value }));
    setHasCredentialChanges(true);
  }, []);

  const handleSaveCredentials = useCallback(async () => {
    if (!app) return;

    // Collect all configurable fields (apikey + oauth extraFields)
    const allFields = [
      ...(backendAuthInfo?.apikey?.fields || []),
      ...(backendAuthInfo?.oauth?.extraFields || []),
    ];

    if (allFields.length === 0) return;

    // Validate required fields
    const emptyRequiredFields = allFields
      .filter((field) => field.required && !credentialValues[field.name]?.trim())
      .map((field) => field.label || field.name);

    if (emptyRequiredFields.length > 0) {
      toast.error(t('apps.requiredFields'), t('apps.pleaseComplete', { fields: emptyRequiredFields.join(', ') }));
      return;
    }

    // Only send fields that have been locally edited (credentialValues)
    // This ensures we do a minimal merge — never wiping tokens we didn't touch
    const toSave: Record<string, string> = {};
    for (const [key, val] of Object.entries(credentialValues)) {
      if (val !== undefined) toSave[key] = val;
    }

    if (Object.keys(toSave).length === 0) return;

    setSavingCredentials(true);
    try {
      await client.app.configureCredentials(app.appId, toSave);
      toast.success(t('apps.saved'), t('apps.credentialsSaved'));
      setHasCredentialChanges(false);
      await loadAuthStatus(app.appId);
    } catch (err) {
      console.error('Save credentials failed:', err);
      toast.error(t('apps.error'), err instanceof Error ? err.message : t('apps.errorSavingCredentials'));
    } finally {
      setSavingCredentials(false);
    }
  }, [app, backendAuthInfo, credentialValues, client, toast, loadAuthStatus]);

  const handleConnect = useCallback(async () => {
    if (!app) return;

    setConnecting(true);
    try {
      await client.connectAppOAuth(app.appId);
      toast.success(t('apps.connected'), t('apps.accountConnected'));
      await loadAuthStatus(app.appId);
    } catch (err) {
      console.error('OAuth connect failed:', err);
      toast.error(t('apps.error'), err instanceof Error ? err.message : t('apps.errorConnecting'));
    } finally {
      setConnecting(false);
    }
  }, [app, client, toast, loadAuthStatus]);

  const handleDisconnect = useCallback(async () => {
    if (!app) return;

    setDisconnecting(true);
    try {
      await client.app.disconnectAuth(app.appId);
      toast.success(t('apps.disconnected'), t('apps.accountDisconnected'));
      await loadAuthStatus(app.appId);
    } catch (err) {
      console.error('Disconnect failed:', err);
      toast.error(t('apps.error'), err instanceof Error ? err.message : t('apps.errorDisconnecting'));
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

      setPermissionsData((prev) => {
        if (!prev) return prev;
        // Toggling pins the tool explicitly → it is no longer auto-allowed by
        // the read-only policy. Recompute the EFFECTIVE summary from the tools
        // (effective = autoAllowed ? 'allow' : permission) so the header stays
        // consistent with the per-row badges and with the backend.
        const tools = prev.tools.map((t) =>
          t.name === toolName ? { ...t, permission, autoAllowed: false } : t,
        );
        const summary = { allow: 0, ask: 0, forbid: 0 };
        for (const t of tools) summary[t.autoAllowed ? 'allow' : t.permission]++;
        return { ...prev, tools, summary };
      });

      setPermissionsSaving(true);
      try {
        await client.app.updateToolPermission(app.appId, toolName, permission);
      } catch (err) {
        console.error('Failed to update tool permission:', err);
        toast.error(t('apps.error'), t('apps.errorUpdatingPermission'));
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
        toast.success(t('apps.updated'), t('apps.allPermissionsChanged', { permission }));
      } catch (err) {
        console.error('Failed to set all permissions:', err);
        toast.error(t('apps.error'), t('apps.errorUpdatingPermissions'));
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
        toast.error(t('apps.error'), result.error || t('apps.errorUpdatingContext'));
        return;
      }

      toast.success(t('apps.saved'), t('apps.contextUpdated'));
      setEditContextOpen(false);
      setContextText('');
      setIsContextSaving(false);
    } catch (error) {
      console.error('Error saving app context:', error);
      toast.error(t('apps.error'), t('apps.errorUpdatingContext'));
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
      toast.success(t('apps.renamed'), t('apps.appRenamed', { name: trimmedName }));
      cancelEditing();
    } catch (err: any) {
      console.error('Error renaming app:', err);
      toast.error(t('apps.error'), err.message || t('apps.errorRenamingApp'));
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
        toast.success(t('apps.uninstalled'), t('apps.appUninstalled', { name: app.name }));
        // Navigate back to apps list
        router.back();
      } catch (err: any) {
        console.error('Error uninstalling app:', err);
        toast.error(t('apps.error'), err.message || t('apps.errorUninstallingApp'));
        setIsUninstalling(false);
      }
    };

    // Show confirmation - use window.confirm on web, Alert on native
    if (Platform.OS === 'web') {
      const confirmed = window.confirm(
        t('apps.uninstallConfirmMessage', { name: app.name }),
      );
      if (confirmed) {
        await doUninstall();
      }
    } else {
      Alert.alert(
        t('apps.uninstallApp'),
        t('apps.uninstallConfirmMessage', { name: app.name }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('apps.uninstall'),
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
        setError(t('apps.noAppId'));
        setLoading(false);
        return;
      }

      try {
        // Use workspaceId to find apps in the correct scope
        const { apps } = await client.workspace.listWorkspaceApps(workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? '');

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
          loadAgentAccess(found.appId);
        } else {
          setError(t('apps.appNotFound', { appId }));
        }
      } catch (err) {
        console.error('Failed to load app:', err);
        setError(err instanceof Error ? err.message : t('errors.app.loadFailed'));
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
      <FullscreenLoader variant="default" label={t('apps.loadingApp')} />
    );
  }

  if (error) {
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$4"
        backgroundColor={c.bgPage}
      >
        <AlertTriangle size={40} color={colors.red} />
        <Text fontFamily={FONT_SANS} color={colors.red} textAlign="center" marginTop="$3">
          {error}
        </Text>
      </YStack>
    );
  }

  const oauthInfo = getOAuthInfo();
  const credentialFields = getCredentialFields();
  const tools: ToolWithPermission[] = permissionsData?.tools || [];
  const IconComponent = getIcon(app?.icon);

  // Hero presentation values (pure derivations — no logic).
  const accent = app?.color || colors.indigo;
  const conn = deriveConnection(backendAuthInfo);
  const connPill = {
    connected: { fg: colors.green, bg: c.badges.ok.bg, border: c.badges.ok.border },
    needs_signin: { fg: colors.amber, bg: c.badges.warn.bg, border: c.badges.warn.border },
    needs_admin: { fg: colors.amber, bg: c.badges.warn.bg, border: c.badges.warn.border },
    error: { fg: colors.red, bg: c.badges.err.bg, border: c.badges.err.border },
    none: { fg: c.text3, bg: c.badges.gray.bg, border: c.badges.gray.border },
  }[conn.state];
  // Primary hero action mirrors the connection state. The actual work is still
  // done by the existing handlers / the AuthPanel below — this is the prominent
  // shortcut, placed where the eye lands first (hero, top-right).
  const heroAction: { label: string; kind: 'connect' | 'disconnect'; busy: boolean } | null =
    conn.state === 'connected'
      ? { label: 'Disconnect', kind: 'disconnect', busy: disconnecting }
      : conn.state === 'needs_signin'
        ? { label: 'Connect', kind: 'connect', busy: connecting }
        : conn.state === 'error'
          ? { label: 'Reconnect', kind: 'connect', busy: connecting }
          : null;

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 28 }}>
        {app && (
          <YStack>
            {/* ── HERO ───────────────────────────────────────────────────────
                Coherent with CatalogDetailWindow: a colour-wash band keyed to
                the MCA accent, fading into the page surface, with the identity
                (icon + name + mcaId·category) and the connection status pill —
                the single most important fact about an installed app — overlaid
                at the bottom. Primary connection action sits top-right. */}
            <View style={{ position: 'relative', overflow: 'hidden', backgroundColor: accent }}>
              {/* Aurora wash generated from the accent — same look as the
                  catalog hero (TER-538). Web-only backgroundImage; native falls
                  back to the flat accent above. */}
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  // @ts-expect-error web-only gradient
                  backgroundImage: gradientFromColors(app?.accentColors, accent),
                }}
              />
              {/* Uniform darkening over the wash so the white identity text
                  stays legible over ANY accent colour, in both themes. */}
              <View
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  // @ts-expect-error web-only gradient — native ignores it
                  backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.30) 100%)`,
                }}
              />

              <YStack paddingHorizontal={20} paddingTop={22} paddingBottom={18} gap={16}>
                {/* Identity row */}
                <XStack gap={14} alignItems="center">
                  {/* Icon tile (logo, emoji or lucide fallback) */}
                  <View
                    style={{
                      width: 60,
                      height: 60,
                      borderRadius: 16,
                      borderWidth: 2,
                      borderColor: 'rgba(255,255,255,0.18)',
                      backgroundColor: '#FFFFFF',
                      justifyContent: 'center',
                      alignItems: 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {isImageUrl(app?.icon) ? (
                      <Image source={{ uri: app?.icon }} style={{ width: 60, height: 60 }} resizeMode="cover" />
                    ) : isEmoji(app?.icon) ? (
                      <Text fontSize={28}>{app?.icon}</Text>
                    ) : IconComponent && app?.icon ? (
                      <IconComponent size={26} color={accent} />
                    ) : (
                      // Initials fallback in mono — same idiom as CatalogDetailWindow
                      <Text fontFamily={FONT_MONO} fontSize={18} fontWeight="600" color={accent}>
                        {(app?.mcaId || app?.mcaName || '??').replace(/^mca\./, '').slice(0, 2).toUpperCase()}
                      </Text>
                    )}
                  </View>

                  <YStack flex={1} gap={3}>
                    {isEditing ? (
                      <XStack alignItems="center" gap={8}>
                        <TextInput
                          value={editingName}
                          onChangeText={setEditingName}
                          onSubmitEditing={handleRename}
                          autoFocus
                          style={{
                            flex: 1,
                            color: c.text,
                            fontSize: 20,
                            fontWeight: '600',
                            fontFamily: FONT_SANS,
                            backgroundColor: c.bgInner,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: colors.indigo,
                          }}
                        />
                        <TouchableOpacity onPress={handleRename} disabled={isRenaming} style={{ padding: 4 }}>
                          {isRenaming ? <AppSpinner size="sm" variant="default" /> : <Check size={18} color={colors.green} />}
                        </TouchableOpacity>
                        <TouchableOpacity onPress={cancelEditing} style={{ padding: 4 }}>
                          <X size={18} color={c.text2} />
                        </TouchableOpacity>
                      </XStack>
                    ) : (
                      <XStack alignItems="center" gap={8}>
                        <Text
                          fontFamily={FONT_SANS}
                          fontSize={24}
                          fontWeight="600"
                          color="#FFFFFF"
                          numberOfLines={1}
                          style={{ flexShrink: 1 }}
                        >
                          {app?.name || appId}
                        </Text>
                        <TouchableOpacity onPress={startEditing} hitSlop={8} style={{ padding: 4 }}>
                          <Pencil size={15} color="rgba(255,255,255,0.7)" />
                        </TouchableOpacity>
                      </XStack>
                    )}
                    <Text fontFamily={FONT_MONO} fontSize={12} color="rgba(255,255,255,0.72)" numberOfLines={1}>
                      {app?.mcaId}
                      {app?.category ? ` · ${app.category}` : ''}
                    </Text>
                  </YStack>

                  {/* Primary connection action (top-right) */}
                  {heroAction && (
                    <TouchableOpacity
                      onPress={heroAction.kind === 'disconnect' ? handleDisconnect : handleConnect}
                      disabled={heroAction.busy}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 7,
                        paddingHorizontal: 16,
                        height: 36,
                        borderRadius: 9,
                        backgroundColor:
                          heroAction.kind === 'disconnect' ? controlsBar.deny.bg : colors.indigo,
                        borderWidth: heroAction.kind === 'disconnect' ? 1 : 0,
                        borderColor: controlsBar.deny.border,
                        opacity: heroAction.busy ? 0.6 : 1,
                      }}
                    >
                      {heroAction.busy ? (
                        <AppSpinner size="sm" variant={heroAction.kind === 'disconnect' ? 'danger' : 'onDark'} />
                      ) : heroAction.kind === 'disconnect' ? (
                        <>
                          <Unlink size={15} color={colors.red} />
                          <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={colors.red}>
                            {heroAction.label}
                          </Text>
                        </>
                      ) : (
                        <>
                          <Link2 size={15} color="#FFFFFF" />
                          <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color="#FFFFFF">
                            {heroAction.label}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </XStack>

                {/* Status pill + identity — the headline fact about this install */}
                <XStack alignItems="center" gap={10} flexWrap="wrap">
                  {/* On the accent band the pill reads as a translucent white
                      chip with a coloured status dot — legible over any accent,
                      unlike the surface-tinted badge it used before. */}
                  <XStack
                    alignItems="center"
                    gap={7}
                    paddingHorizontal={11}
                    paddingVertical={6}
                    borderRadius={20}
                    backgroundColor="rgba(255,255,255,0.16)"
                    borderWidth={1}
                    borderColor="rgba(255,255,255,0.26)"
                  >
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: connPill.fg }} />
                    <Text fontFamily={FONT_SANS} fontSize={12.5} fontWeight="600" color="#FFFFFF">
                      {conn.label}
                    </Text>
                  </XStack>
                  {/* Connection transparency (HubSpot/Salesforce): show the
                      connected account so the user knows *whose* access this is. */}
                  {conn.identity && (
                    <Text fontFamily={FONT_SANS} fontSize={12.5} color="rgba(255,255,255,0.85)" numberOfLines={1}>
                      as <Text fontFamily={FONT_MONO} color="#FFFFFF">{conn.identity}</Text>
                    </Text>
                  )}
                  {/* Manual refresh of auth status — quiet, secondary */}
                  <TouchableOpacity
                    onPress={() => app && loadAuthStatus(app.appId)}
                    disabled={authLoading}
                    hitSlop={8}
                    style={{ padding: 4, opacity: authLoading ? 0.5 : 1 }}
                  >
                    {authLoading ? <AppSpinner size="sm" variant="default" /> : <RefreshCw size={14} color="rgba(255,255,255,0.7)" />}
                  </TouchableOpacity>
                </XStack>

              </YStack>
            </View>

            <YStack paddingHorizontal={16} paddingTop={20} gap={22}>
              {/* Description lives on the page surface (not over the accent) so
                  it reads with the normal text colour — same as the catalog's
                  About block. */}
              {app.description && (
                <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="300" color={c.text2} lineHeight={20} maxWidth={620}>
                  {app.description}
                </Text>
              )}
              {/* ── CONNECTION (most important — first) ─────────────────────
                  The AuthPanel already renders status, connected account and
                  connect/disconnect/credentials controls. We frame it under a
                  section label so it reads as a sibling of the catalog detail. */}
              <YStack gap={10}>
                <SectionLabel text={t('apps.connection', 'Connection')} textColor={c.text3} />
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
                  systemSetupMessage={
                    backendAuthInfo?.status === 'needs_system_setup' ? backendAuthInfo.message : undefined
                  }
                />
              </YStack>

              {/* ── PERMISSIONS ─────────────────────────────────────────────
                  Default permission + per-tool toggles. The panel surfaces the
                  summary first and the (potentially long) tool list is collapsed
                  by default — progressive disclosure so it never dominates. */}
              {tools.length > 0 && (
                <YStack gap={10}>
                  <SectionLabel text={t('apps.permissions', 'Permissions')} textColor={c.text3} />
                  <Text fontFamily={FONT_SANS} fontSize={12} fontWeight="300" color={c.text3} lineHeight={18}>
                    {t(
                      'apps.permissionsHint',
                      'Per tool: Auto runs without asking · Confirm asks you each time · Block forbids it entirely.',
                    )}
                  </Text>
                  <PermissionsPanel
                    tools={tools}
                    summary={permissionsData?.summary}
                    loading={permissionsLoading}
                    saving={permissionsSaving}
                    onToolPermissionChange={handleToolPermissionChange}
                    onSetAllPermissions={handleSetAllPermissions}
                    defaultExpanded={false}
                  />
                </YStack>
              )}

              {/* ── AGENTS ──────────────────────────────────────────────────
                  Which of the workspace's agents can use this app. The inverse
                  view (an agent's apps) lives in the AgentWindow; toggling here
                  drives the same grant/revoke, so both stay in sync. */}
              {(agentAccessLoading || agentAccess.length > 0) && (
                <YStack gap={10}>
                  <SectionLabel text={t('apps.agents', 'Agents')} textColor={c.text3} />
                  <Text fontFamily={FONT_SANS} fontSize={12} fontWeight="300" color={c.text3} lineHeight={18}>
                    {t('apps.agentsHint', 'Choose which agents in this workspace can use this app.')}
                  </Text>
                  {agentAccessLoading ? (
                    <AppSpinner />
                  ) : (
                    <YStack gap={8}>
                      {agentAccess.map((agent) => (
                        <XStack
                          key={agent.agentId}
                          backgroundColor={c.bgCard}
                          borderRadius={12}
                          borderWidth={1}
                          borderColor={c.border}
                          padding={12}
                          alignItems="center"
                          gap={12}
                        >
                          <Avatar src={agent.avatarUrl} name={agent.name} size={32} />
                          <Text
                            flex={1}
                            fontFamily={FONT_SANS}
                            fontSize={13}
                            fontWeight="500"
                            color={c.text}
                            numberOfLines={1}
                          >
                            {agent.name}
                          </Text>
                          <AgentAccessToggle
                            on={agent.hasAccess}
                            busy={togglingAgentId === agent.agentId}
                            trackOff={c.text3}
                            onToggle={() => handleToggleAgent(agent.agentId, !agent.hasAccess)}
                          />
                        </XStack>
                      ))}
                    </YStack>
                  )}
                </YStack>
              )}

              {/* ── CONFIGURATION ───────────────────────────────────────────
                  Rename lives in the hero (inline pencil). Here: the agent
                  instructions / context, hidden behind progressive disclosure —
                  advanced, optional, so collapsed until requested. */}
              <YStack gap={10}>
                <SectionLabel text={t('apps.configuration', 'Configuration')} textColor={c.text3} />
                <YStack
                  backgroundColor={c.bgCard}
                  borderRadius={12}
                  borderWidth={1}
                  borderColor={c.border}
                  overflow="hidden"
                >
                  <TouchableOpacity
                    onPress={() => {
                      // No instructions yet → jump straight to the editor.
                      // Otherwise toggle the inline preview (progressive disclosure).
                      if (!app?.context) {
                        startEditingContext();
                      } else {
                        setInstructionsExpanded((v) => !v);
                      }
                    }}
                    activeOpacity={0.7}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 14,
                      paddingHorizontal: 16,
                    }}
                  >
                    <FileText size={17} color={colors.violet} />
                    <Text flex={1} fontFamily={FONT_SANS} fontSize={14} fontWeight="500" color={c.text}>
                      {t('apps.instructions', 'Instructions')}
                    </Text>
                    {app?.context ? (
                      <ChevronDown
                        size={16}
                        color={c.text3}
                        style={{
                          transform: [{ rotate: instructionsExpanded ? '180deg' : '0deg' }],
                        }}
                      />
                    ) : (
                      <XStack alignItems="center" gap={5}>
                        <Plus size={13} color={c.text3} />
                        <Text fontFamily={FONT_SANS} fontSize={12} color={c.text3}>
                          {t('apps.addInstructions', 'Add instructions')}
                        </Text>
                      </XStack>
                    )}
                  </TouchableOpacity>

                  {app?.context && instructionsExpanded && (
                    <YStack
                      backgroundColor={c.bgInner}
                      borderTopWidth={1}
                      borderTopColor={c.border}
                      padding={16}
                      gap={12}
                    >
                      <Text fontFamily={FONT_SANS} color={c.text3} fontSize={11.5} lineHeight={17} fontStyle="italic">
                        {t(
                          'apps.instructionsHint',
                          "Added to an agent's prompt whenever it has access to this app.",
                        )}
                      </Text>
                      <Text fontFamily={FONT_SANS} color={c.text2} fontSize={13} lineHeight={20}>
                        {app.context}
                      </Text>
                      <TouchableOpacity
                        onPress={startEditingContext}
                        style={{
                          alignSelf: 'flex-start',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingHorizontal: 12,
                          paddingVertical: 7,
                          borderRadius: 8,
                          backgroundColor: c.bgCardHover,
                          borderWidth: 1,
                          borderColor: c.borderStrong,
                        }}
                      >
                        <Pencil size={13} color={c.text2} />
                        <Text fontFamily={FONT_SANS} fontSize={12.5} fontWeight="500" color={c.text2}>
                          {t('apps.editInstructions', 'Edit')}
                        </Text>
                      </TouchableOpacity>
                    </YStack>
                  )}
                </YStack>
              </YStack>

              {/* ── DANGER ZONE (last, separated, warning-coloured) ─────────
                  GitHub danger-zone pattern: destructive action isolated at the
                  bottom, behind a red-tinted frame, gated by the existing
                  confirmation modal in handleUninstall. */}
              <YStack gap={10} marginTop={6}>
                <SectionLabel text={t('apps.dangerZone', 'Danger zone')} textColor={colors.red} />
                <XStack
                  backgroundColor={indicators.irreversible.bg}
                  borderRadius={12}
                  padding={16}
                  borderWidth={1}
                  borderColor={indicators.irreversible.border}
                  alignItems="center"
                  gap={14}
                  flexWrap="wrap"
                >
                  <AlertTriangle size={20} color={colors.red} />
                  <YStack flex={1} minWidth={180} gap={2}>
                    <Text fontFamily={FONT_SANS} fontSize={13.5} fontWeight="600" color={c.text}>
                      {t('apps.uninstallApp')}
                    </Text>
                    <Text fontFamily={FONT_SANS} fontSize={12} color={c.text3} lineHeight={17}>
                      {t(
                        'apps.uninstallDescription',
                        'Removes the app and all its settings from this workspace. This cannot be undone.',
                      )}
                    </Text>
                  </YStack>
                  <TouchableOpacity
                    onPress={handleUninstall}
                    disabled={isUninstalling}
                    style={{
                      backgroundColor: controlsBar.deny.bg,
                      borderWidth: 1,
                      borderColor: controlsBar.deny.border,
                      paddingHorizontal: 16,
                      paddingVertical: 10,
                      borderRadius: 9,
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
                        <Trash2 size={15} color={colors.red} />
                        <Text fontFamily={FONT_SANS} color={colors.red} fontSize={13} fontWeight="500">
                          {t('apps.uninstall', 'Uninstall')}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </XStack>
              </YStack>
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
              backgroundColor: c.bgCard,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: c.border,
              padding: 20,
              width: '100%',
              maxWidth: 500,
              maxHeight: '80%',
            }}
          >
            <Text fontFamily={FONT_SANS} fontSize={16} fontWeight="600" color={c.text} marginBottom={16}>
              {t('apps.editContext')}
            </Text>

            <TextInput
              value={contextText}
              onChangeText={setContextText}
              multiline
              numberOfLines={8}
              placeholder={t('apps.contextPlaceholder')}
              placeholderTextColor={c.text3}
              style={{
                backgroundColor: c.bgInner,
                color: c.text,
                fontFamily: FONT_SANS,
                borderRadius: 8,
                padding: 12,
                fontSize: 14,
                lineHeight: 20,
                textAlignVertical: 'top',
                minHeight: 120,
                borderWidth: 1,
                borderColor: c.border,
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
                  backgroundColor: c.bgInner,
                  borderWidth: 1,
                  borderColor: c.border,
                }}
              >
                <Text fontFamily={FONT_SANS} color={c.text2} fontSize={14} fontWeight="500">
                  {t('common.cancel')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleSaveContext}
                disabled={isContextSaving || !contextText.trim()}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: contextText.trim() ? colors.indigo : c.bgCardHover,
                  opacity: isContextSaving || !contextText.trim() ? 0.5 : 1,
                }}
              >
                {isContextSaving ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <Text fontFamily={FONT_SANS} color="#FFFFFF" fontSize={14} fontWeight="500">
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
