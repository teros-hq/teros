/**
 * Agent Window Content
 *
 * Configure an agent: view conversations, edit info, manage context, apps, and model.
 */

import * as LucideIcons from '@tamagui/lucide-icons';
import {
  Archive,
  Bot,
  Camera,
  Check,
  Edit3,
  Folder,
  MessageSquare,
  Mic,
  Package,
  Palette,
  Plus,
  Save,
  Search,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Trash2,
  User,
  X,
} from '@tamagui/lucide-icons';
import {
  COLOR_PALETTE,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  type WorkspaceColor,
  resolveRetention,
} from '@teros/shared';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, TextInput, TouchableOpacity, View } from 'react-native';
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
import { useToast } from '../../components/Toast';
import { getTerosClient } from '../../services/terosClientSingleton';
import { useNavbarStore } from '../../store/navbarStore';
import { useTilingStore } from '../../store/tilingStore';
import { WorkspaceIcon } from '../../components/WorkspaceIcon';
import { useImageWithFallback } from '../../hooks/useImageWithFallback';
import { useWorkspaceStore } from '../../store/workspaceStore';
import type { AgentWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';
import { ContextEditor } from '../../components/ContextEditor';
import { RetentionBadge, RetentionConfirmModal, useRetentionGuard } from '../../components/dataRetention';
import { useColors, useMcaTheme } from '../../components/mca/primitives/useColors';
import { colors as semanticColors } from '../../components/mca/primitives/colors';

// Semantic accents — theme-agnostic (same hex in light and dark)
const INDIGO = semanticColors.indigo;
const INDIGO_LIGHT = semanticColors.indigoLight;
const INDIGO_DARK = semanticColors.indigoDark;
const INDIGO_GLOW = semanticColors.indigoGlow;
const INDIGO_BORDER = 'rgba(94,106,210,0.30)';
const RED = semanticColors.red;
const GREEN = semanticColors.green;
const GREEN_GLOW = 'rgba(34,197,94,0.15)';
const VIOLET = semanticColors.violet;
const VIOLET_LIGHT = '#9F7AEA';
const VIOLET_DARK = '#7C3AED';
const ORANGE = semanticColors.orange;

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
  avatarUrl?: string;
  maxSteps?: number;
  availableProviders?: string[];
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
  appearance?: { color?: string; icon?: string };
  coreId?: string;
  workspaceId?: string;
}

interface UserProvider {
  providerId: string;
  providerType: string;
  displayName: string;
  /** Provider config (e.g. zhipu `useChina`) — needed to resolve the retention
   * tier accurately, same as the backend does for AgentCoresWindow. */
  config?: Record<string, unknown>;
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

type TabId = 'conversations' | 'general' | 'context' | 'apps' | 'model' | 'skills';

interface Skill {
  skillId: string;
  name: string;
  description?: string;
  icon?: string;
}

interface SkillWithAccess extends Skill {
  hasAccess: boolean;
  enabled: boolean;
}

/**
 * Avatar del editor de agente. Si la imagen falla al cargar (404) cae al fallback
 * (icono de apariencia / Bot) en vez del glifo de imagen rota. Componente propio
 * para no alterar el orden de hooks del editor (grande). Reusa useImageWithFallback.
 */
function EditorAvatar({
  src,
  alt,
  title,
  fallback,
}: {
  src?: string;
  alt: string;
  title?: string;
  fallback: React.ReactNode;
}) {
  const { showImage, onError } = useImageWithFallback(src);
  if (showImage) {
    return (
      <img
        src={src}
        alt={alt}
        title={title}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        onError={onError}
      />
    );
  }
  return <>{fallback}</>;
}

export function AgentWindowContent({ windowId, agentId, workspaceId }: AgentWindowContentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const client = getTerosClient();
  const toast = useToast();
  const { closeWindow, openWindow, findWindow, focusWindow } = useTilingStore();
  const { removeAgent } = useNavbarStore();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const c = useColors();
  const isDark = useMcaTheme() === 'dark';
  const { guard: retentionGuard, modalProps: retentionModalProps } = useRetentionGuard();
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
  const [contextValue, setContextValue] = useState('');
  const [savingContext, setSavingContext] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Appearance modal state
  const [showAppearanceModal, setShowAppearanceModal] = useState(false);
  const [selectedColor, setSelectedColor] = useState<string>('cyan');
  const [selectedIcon, setSelectedIcon] = useState<string>('bot');
  const [iconSearch, setIconSearch] = useState<string>('');
  const [savingAppearance, setSavingAppearance] = useState(false);

  // Skills tab state
  const [skills, setSkills] = useState<SkillWithAccess[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [togglingSkill, setTogglingSkill] = useState<string | null>(null);

  // Appearance modal helpers
  const pascalToKebab = (name: string): string =>
    name.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

  const getFilteredIcons = (): string[] => {
    const query = iconSearch.trim().toLowerCase();
    if (!query) return [...WORKSPACE_ICONS];
    return Object.keys(LucideIcons)
      .map(pascalToKebab)
      .filter((name) => /^[a-z][a-z0-9-]+$/.test(name) && name.includes(query));
  };

  const openAppearanceModal = () => {
    if (!agent) return;
    setSelectedColor(agent.appearance?.color || 'cyan');
    setSelectedIcon(agent.appearance?.icon || 'bot');
    setIconSearch('');
    setShowAppearanceModal(true);
  };

  const handleSaveAppearance = async () => {
    if (!agent) return;
    setSavingAppearance(true);
    try {
      const updated = await client.updateAgent({
        agentId: agent.agentId,
        appearance: { color: selectedColor, icon: selectedIcon },
      });
      setAgent((prev) => (prev ? { ...prev, appearance: (updated as any).appearance ?? { color: selectedColor, icon: selectedIcon } } : null));
      setShowAppearanceModal(false);
    } catch (err: any) {
      alert(t("agent.failedSaveAppearance", { error: err?.message || t("agent.unknownError") }));
    } finally {
      setSavingAppearance(false);
    }
  };

  // Handle avatar upload
  const handleAvatarUpload = async (file: File) => {
    if (!agent) return;

    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const backendUrl = client.getBackendBaseUrl();
      // The avatar endpoint requires auth (Bearer token); without it the backend
      // responds 401 "Authentication required". Mirror the chat upload + client.ts.
      const token = client.getSessionToken();
      const response = await fetch(`${backendUrl}/api/upload/avatar/${agent.agentId}`, {
        method: 'POST',
        body: formData,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });

      const result = await response.json();

      if (result.success && result.url) {
        setAgent((prev) => (prev ? { ...prev, avatarUrl: result.url } : null));
      } else {
        alert(result.error || t("agent.failedUploadAvatar"));
      }
    } catch (err) {
      console.error('Upload error:', err);
      alert(t("agent.failedUploadAvatar"));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        alert(t("agent.selectImageFile"));
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert(t("agent.fileTooLarge"));
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
      setContextValue(updated.context || '');
      setIsEditing(false);
    } catch (err: any) {
      alert(t("agent.failedUpdateAgent", { error: err?.message || t("agent.unknownError") }));
    } finally {
      setSaving(false);
    }
  };

  const saveAgentContext = async () => {
    if (!agent) return;
    setSavingContext(true);
    try {
      const updated = await client.updateAgent({
        agentId: agent.agentId,
        context: contextValue,
      });
      setAgent((prev) => (prev ? { ...prev, context: updated.context } : null));
    } catch (err: any) {
      alert(`Failed to update context: ${err?.message || 'Unknown error'}`);
    } finally {
      setSavingContext(false);
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
      alert(t("agent.failedDeleteAgent", { error: err?.message || t("agent.unknownError") }));
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

  const loadSkills = async () => {
    if (!agent || !workspaceId) return;

    setLoadingSkills(true);
    try {
      const [allSkills, agentSkills] = await Promise.all([
        client.skillRequest('skill.list', { workspaceId }),
        client.skillRequest('skill.get-agent-skills', { agentId }),
      ]);

      const agentSkillMap = new Map<string, { enabled: boolean }>(
        ((agentSkills as any)?.skills ?? []).map((s: any) => [s.skillId, { enabled: s.enabled ?? true }]),
      );

      const combined: SkillWithAccess[] = ((allSkills as any)?.skills ?? []).map((s: Skill) => ({
        ...s,
        hasAccess: agentSkillMap.has(s.skillId),
        enabled: agentSkillMap.get(s.skillId)?.enabled ?? false,
      }));

      setSkills(combined);
      setSkillsLoaded(true);
    } catch (err) {
      console.error('[AgentWindow] Error loading skills:', err);
      toast.error('Skills', err instanceof Error ? err.message : 'No se pudieron cargar las skills');
      setSkillsLoaded(true);
    } finally {
      setLoadingSkills(false);
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
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      }, false, windowId);
    }
  };

  const handleNewConversation = () => {
    if (!agent) return;
    
    openWindow('chat', {
      agentId: agent.agentId,
      agentName: agent.name || agent.fullName,
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
    }, false, windowId);
  };

  const handleVoiceConversation = () => {
    if (!agent) return;
    // Open a chat window — voice mode is activated inline from the chat header mic button
    openWindow('chat', {
      agentId: agent.agentId,
      agentName: agent.name || agent.fullName,
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
    }, false, windowId);
  };

  useEffect(() => {
    const loadAgent = async () => {
      if (!agentId) {
        setError(t('errors.agent.noId'));
        setLoading(false);
        return;
      }

      const effectiveWorkspaceId = workspaceId ?? activeWorkspaceId ?? undefined;

      // Wait until the workspace store has hydrated before attempting to load
      if (effectiveWorkspaceId === undefined) {
        return;
      }

      try {
        // Search in parallel: global agents + workspace agents (to support superagents with workspaceId: null)
        const [globalAgents, workspaceAgents] = await Promise.all([
          client.agent.listAgents().then((r) => r.agents).catch(() => []),
          effectiveWorkspaceId
            ? client.agent.listAgents(effectiveWorkspaceId).then((r) => r.agents).catch(() => [])
            : Promise.resolve([]),
        ]);
        const allAgents = [...globalAgents, ...workspaceAgents];
        const found = allAgents.find((a) => a.agentId === agentId);

        if (found) {
          setAgent(found);
          setContextValue(found.context || '');

          try {
            const [appsList, agentApps, providersList] = await Promise.all([
              client.workspace.listWorkspaceApps(effectiveWorkspaceId ?? activeWorkspaceId ?? '').then(r => r.apps),
              client.getAgentApps(found.agentId, effectiveWorkspaceId),
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
          setError(t('errors.agent.notFound', { agentId }));
        }
      } catch (err) {
        console.error('Failed to load agent:', err);
        setError(err instanceof Error ? err.message : t('errors.agent.loadFailed'));
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
  }, [agentId, workspaceId, activeWorkspaceId, client]);

  // Load conversations when switching to conversations tab
  useEffect(() => {
    if (activeTab === 'conversations' && agent && conversations.length === 0) {
      loadConversations();
    }
  }, [activeTab, agent]);

  // Lazy-load skills when switching to skills tab
  useEffect(() => {
    if (activeTab === 'skills' && agent && !skillsLoaded) {
      loadSkills();
    }
  }, [activeTab, agent]);

  if (loading) {
    return (
      <FullscreenLoader label={t("agent.loadingAgent")} />
    );
  }

  if (error) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" padding={16}>
        <Text color={RED} textAlign="center">
          {error}
        </Text>
      </YStack>
    );
  }

  const renderAppCard = (app: AppWithAccess) => (
    <XStack
      key={app.appId}
      backgroundColor={c.bgCard}
      borderRadius={8}
      padding={12}
      borderWidth={1}
      borderColor={c.border}
      alignItems="center"
      gap={12}
      hoverStyle={{
        backgroundColor: c.bgCardHover,
        borderColor: c.borderStrong,
      }}
    >
      <YStack
        width={32}
        height={32}
        borderRadius={6}
        backgroundColor={app.color || c.bgCardHover}
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
        <Text fontSize={12} fontWeight="500" color={c.text} numberOfLines={1}>
          {app.name}
        </Text>
        <Text fontSize={11} color={c.text2} numberOfLines={1}>
          {app.description}
        </Text>
      </YStack>
      <Button
        size="$2"
        circular
        backgroundColor="transparent"
        disabled={removingApp === app.appId}
        opacity={removingApp === app.appId ? 0.5 : 1}
        icon={<X size={16} color={RED} />}
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
        hoverStyle={{ backgroundColor: c.bgCardHover }}
        pressStyle={{ backgroundColor: c.bgCard }}
        onPress={() => handleSelectConversation(conv)}
      >
        <YStack flex={1} gap={2}>
          <Text fontSize={12} fontWeight="500" color={c.text} numberOfLines={1}>
            {conv.title}
          </Text>
          {conv.lastMessageContent && (
            <Text fontSize={11} color={c.text3} numberOfLines={1}>
              {conv.lastMessageContent}
            </Text>
          )}
          {conv.lastMessageAt && (
            <Text fontSize={9} color={c.text3}>
              {new Date(conv.lastMessageAt).toLocaleDateString()}
            </Text>
          )}
        </YStack>
        
        {/* Status indicators */}
        <XStack gap={6} alignItems="center">
          {/* Red dot: external action requested (awaiting human or other agent) */}
          {externalActionRequested && (
            <Circle size={8} backgroundColor={RED} />
          )}
          
          {/* Blue dot: has unread content */}
          {!externalActionRequested && hasUnread && (
            <Circle size={8} backgroundColor={INDIGO} />
          )}
        </XStack>
      </XStack>
    );
  };

  const tabs: Array<{ id: TabId; label: string; icon: any }> = [
    { id: 'conversations', label: t("agent.tabConversations"), icon: MessageSquare },
    { id: 'general', label: t("agent.tabGeneral"), icon: User },
    { id: 'context', label: t("agent.tabContext"), icon: Settings },
    { id: 'apps', label: t("agent.tabApps"), icon: Package },
    { id: 'skills', label: t("agent.tabSkills"), icon: Sparkles },
    { id: 'model', label: t("agent.tabModel"), icon: Bot },
  ];

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {agent && (
        <>
          {/* Header */}
          <YStack
            backgroundColor={c.bgCard}
            borderBottomWidth={1}
            borderBottomColor={c.border}
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
                backgroundColor={c.bgCardHover}
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
                <EditorAvatar
                  src={agent.avatarUrl}
                  alt={agent.name}
                  title={t("agent.avatarUploadHint")}
                  fallback={
                    agent.appearance?.icon ? (
                      <WorkspaceIcon
                        icon={agent.appearance.icon}
                        color={agent.appearance.color || 'cyan'}
                        size={24}
                        containerSize={48}
                      />
                    ) : (
                      <Bot size={24} color={INDIGO} />
                    )
                  }
                />
                <YStack
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  backgroundColor={isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)'}
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
                <Text fontSize={16} fontWeight="700" color={c.text}>
                  {agent.fullName || agent.name}
                </Text>
                <Text fontSize={12} color={c.text2} fontWeight="500">
                  {agent.role}
                </Text>
              </YStack>

              {/* Appearance button */}
              <TouchableOpacity
                onPress={openAppearanceModal}
                style={{
                  padding: 8,
                  borderRadius: 6,
                  backgroundColor: c.borderStrong,
                }}
              >
                <Palette size={16} color={c.text3} />
              </TouchableOpacity>

              <XStack gap={8}>
                <Button
                  size="$3"
                  backgroundColor={INDIGO}
                  color="white"
                  paddingHorizontal={16}
                  paddingVertical={8}
                  borderRadius={6}
                  icon={<MessageSquare size={16} />}
                  onPress={handleNewConversation}
                  hoverStyle={{ backgroundColor: INDIGO_LIGHT }}
                  pressStyle={{ backgroundColor: INDIGO_DARK }}
                >
                  <Text color="white" fontSize={13} fontWeight="600">
                    {t("agent.chat")}
                  </Text>
                </Button>

                <Button
                  size="$3"
                  backgroundColor={VIOLET}
                  color="white"
                  paddingHorizontal={16}
                  paddingVertical={8}
                  borderRadius={6}
                  icon={<Mic size={16} />}
                  onPress={handleVoiceConversation}
                  hoverStyle={{ backgroundColor: VIOLET_LIGHT }}
                  pressStyle={{ backgroundColor: VIOLET_DARK }}
                >
                  <Text color="white" fontSize={13} fontWeight="600">
                    {t("agent.voice")}
                  </Text>
                </Button>
              </XStack>
            </XStack>

            {/* Info Banner */}
            <YStack
              backgroundColor={INDIGO_GLOW}
              borderRadius={6}
              padding={10}
              borderWidth={1}
              borderColor={INDIGO_BORDER}
            >
              <Text fontSize={12} color={INDIGO}>
                {t("agent.configureSettingsBanner")}
              </Text>
            </YStack>
          </YStack>

          {/* Tabs */}
          <YStack
            backgroundColor={c.bgPage}
            borderBottomWidth={1}
            borderBottomColor={c.border}
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
                      borderBottomColor={isActive ? INDIGO : 'transparent'}
                      opacity={isActive ? 1 : 0.6}
                      hoverStyle={{ opacity: 1, backgroundColor: c.bgCard }}
                      onPress={() => setActiveTab(tab.id)}
                    >
                      <Icon size={14} color={isActive ? INDIGO : c.text2} />
                      <Text
                        fontSize={12}
                        fontWeight={isActive ? '600' : '500'}
                        color={isActive ? INDIGO : c.text2}
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
                    <Text fontSize={14} fontWeight="600" color={c.text}>
                      {t("agent.recentConversations")}
                    </Text>
                    {totalActiveCount > 0 && (
                      <Text fontSize={11} color={c.text2}>
                        {t("agent.showingCount", { shown: conversations.length, total: totalActiveCount })}
                      </Text>
                    )}
                  </XStack>

                  {loadingConversations ? (
                    <YStack padding={32} alignItems="center">
                      <AppSpinner size="lg" variant="brand" />
                      <Text color={c.text2} marginTop={12}>
                        {t("agent.loadingConversations")}
                      </Text>
                    </YStack>
                  ) : conversations.length === 0 ? (
                    <YStack
                      padding={32}
                      alignItems="center"
                      backgroundColor={c.bgCard}
                      borderRadius={8}
                      borderWidth={1}
                      borderColor={c.border}
                      gap={12}
                    >
                      <MessageSquare size={48} color={c.text3} />
                      <Text fontSize={14} fontWeight="600" color={c.text2}>
                        {t("agent.noConversationsYet")}
                      </Text>
                      <Text fontSize={12} color={c.text3} textAlign="center">
                        {t("agent.noConversationsHint")}
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
                          backgroundColor={c.bgCard}
                          borderRadius={6}
                          borderWidth={1}
                          borderColor={c.border}
                          cursor="pointer"
                          hoverStyle={{ backgroundColor: c.bgCardHover, borderColor: c.borderStrong }}
                          onPress={() => {
                            openWindow('conversations', {}, false, windowId);
                          }}
                        >
                          <Text fontSize={12} color={INDIGO} fontWeight="500">
                            {t("agent.viewMoreActive", { count: totalActiveCount - 10 })}
                          </Text>
                        </XStack>
                      )}
                      
                      {/* Show inactive count if there are any */}
                      {totalInactiveCount > 0 && (
                        <XStack
                          padding={12}
                          alignItems="center"
                          justifyContent="center"
                          backgroundColor={c.bgCard}
                          borderRadius={6}
                          borderWidth={1}
                          borderColor={c.border}
                          cursor="pointer"
                          hoverStyle={{ backgroundColor: c.bgCardHover, borderColor: c.borderStrong }}
                          onPress={() => {
                            openWindow('conversations', {}, false, windowId);
                          }}
                        >
                          <Text fontSize={12} color={c.text2} fontWeight="500">
                            {t("agent.inactiveConversationsCount", { count: totalInactiveCount })}
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
                    <Text fontSize={14} fontWeight="600" color={c.text}>
                      {t("agent.generalInformation")}
                    </Text>
                    {!isEditing ? (
                      <XStack gap={8}>
                        <Button
                          size="$2"
                          backgroundColor={INDIGO}
                          color="white"
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          icon={<Edit3 size={14} />}
                          onPress={startEditing}
                          hoverStyle={{ backgroundColor: INDIGO_LIGHT }}
                        >
                          <Text color="white" fontSize={12} fontWeight="600">
                            {t("common.edit")}
                          </Text>
                        </Button>
                        <Button
                          size="$2"
                          backgroundColor={RED}
                          color="white"
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          icon={<Trash2 size={14} />}
                          onPress={() => setShowDeleteConfirm(true)}
                          hoverStyle={{ backgroundColor: RED }}
                        >
                          <Text color="white" fontSize={12} fontWeight="600">
                            {t("common.delete")}
                          </Text>
                        </Button>
                      </XStack>
                    ) : (
                      <XStack gap={8}>
                        <Button
                          size="$2"
                          backgroundColor={c.bgCardHover}
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          onPress={cancelEditing}
                          disabled={saving}
                          hoverStyle={{ backgroundColor: c.borderStrong }}
                        >
                          <Text color={c.text} fontSize={12} fontWeight="600">
                            {t("common.cancel")}
                          </Text>
                        </Button>
                        <Button
                          size="$2"
                          backgroundColor={GREEN}
                          color="white"
                          paddingHorizontal={12}
                          paddingVertical={6}
                          borderRadius={6}
                          onPress={saveAgent}
                          disabled={saving}
                          icon={saving ? <AppSpinner size="sm" /> : <Save size={14} />}
                          hoverStyle={{ backgroundColor: GREEN }}
                        >
                          <Text color="white" fontSize={12} fontWeight="600">
                            {saving ? t("common.saving") : t("common.save")}
                          </Text>
                        </Button>
                      </XStack>
                    )}
                  </XStack>

                  {isEditing ? (
                    <YStack gap={12}>
                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text2} fontWeight="600">
                          {t("agent.fieldName")}
                        </Text>
                        <Input
                          placeholder={t("agent.placeholderAgentName")}
                          value={editForm.name}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, name: text }))
                          }
                          backgroundColor={c.bgCard}
                          borderColor={c.border}
                          color={c.text}
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text2} fontWeight="600">
                          {t("agent.fieldFullName")}
                        </Text>
                        <Input
                          placeholder={t("agent.placeholderAgentFullName")}
                          value={editForm.fullName}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, fullName: text }))
                          }
                          backgroundColor={c.bgCard}
                          borderColor={c.border}
                          color={c.text}
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text2} fontWeight="600">
                          {t("agent.fieldRole")}
                        </Text>
                        <Input
                          placeholder={t("agent.placeholderAgentRole")}
                          value={editForm.role}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, role: text }))
                          }
                          backgroundColor={c.bgCard}
                          borderColor={c.border}
                          color={c.text}
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text2} fontWeight="600">
                          {t("agent.fieldIntroduction")}
                        </Text>
                        <TextArea
                          placeholder={t("agent.placeholderAgentIntro")}
                          value={editForm.intro}
                          onChangeText={(text: string) =>
                            setEditForm((prev) => ({ ...prev, intro: text }))
                          }
                          numberOfLines={4}
                          minHeight={100}
                          backgroundColor={c.bgCard}
                          borderColor={c.border}
                          color={c.text}
                          fontSize={13}
                        />
                      </YStack>

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text2} fontWeight="600">
                          {t("agent.fieldMaxSteps")}
                        </Text>
                        <Input
                          placeholder={t("agent.placeholderMaxSteps")}
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
                          backgroundColor={c.bgCard}
                          borderColor={c.border}
                          color={c.text}
                          fontSize={13}
                        />
                      </YStack>
                    </YStack>
                  ) : (
                    <YStack gap={12}>
                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text3} fontWeight="600">
                          {t("agent.fieldName")}
                        </Text>
                        <Text fontSize={13} color={c.text}>
                          {agent.name}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor={c.border} />

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text3} fontWeight="600">
                          {t("agent.fieldFullName")}
                        </Text>
                        <Text fontSize={13} color={c.text}>
                          {agent.fullName}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor={c.border} />

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text3} fontWeight="600">
                          {t("agent.fieldRole")}
                        </Text>
                        <Text fontSize={13} color={c.text}>
                          {agent.role}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor={c.border} />

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text3} fontWeight="600">
                          {t("agent.fieldIntroduction")}
                        </Text>
                        <Text fontSize={13} color={c.text} lineHeight={20}>
                          {agent.intro}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor={c.border} />

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text3} fontWeight="600">
                          {t("agent.fieldMaxSteps")}
                        </Text>
                        <Text fontSize={13} color={c.text}>
                          {agent.maxSteps === 0 ? `∞ (${t("agent.maxStepsUnlimited")})` : agent.maxSteps || 20}
                        </Text>
                      </YStack>

                      <YStack height={1} backgroundColor={c.border} />

                      <YStack gap={6}>
                        <Text fontSize={11} color={c.text3} fontWeight="600">
                          {t("agent.fieldAgentId")}
                        </Text>
                        <Text fontSize={11} color={c.text3} fontFamily="$mono">
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
                    <H2 fontSize={14} color={c.text}>
                      {t("agent.systemContext")}
                    </H2>
                    {!isEditing ? (
                      <Button
                        size="$3"
                        backgroundColor={INDIGO}
                        color="white"
                        icon={<Edit3 size={16} />}
                        onPress={startEditing}
                      >
                        {t("common.edit")}
                      </Button>
                    ) : (
                      <XStack gap={8}>
                        <Button
                          size="$3"
                          backgroundColor={c.bgCardHover}
                          onPress={cancelEditing}
                          disabled={saving}
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          size="$3"
                          backgroundColor={GREEN}
                          color="white"
                          onPress={saveAgent}
                          disabled={saving}
                          icon={saving ? <AppSpinner size="sm" /> : <Save size={16} />}
                        >
                          {saving ? t("common.saving") : t("common.save")}
                        </Button>
                      </XStack>
                    )}
                  </XStack>

                  <YStack
                    backgroundColor={INDIGO_GLOW}
                    borderRadius={6}
                    padding={12}
                    borderWidth={1}
                    borderColor={INDIGO_BORDER}
                  >
                    <Text fontSize={11} color={INDIGO}>
                      {t("agent.systemContextHint")}
                    </Text>
                  </YStack>

                  {isEditing ? (
                    <YStack gap={8}>
                      <TextArea
                        placeholder={t("agent.placeholderContext")}
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
                      backgroundColor={c.bgCard}
                      borderRadius={8}
                      padding={16}
                      borderWidth={1}
                      borderColor={c.border}
                      minHeight={300}
                    >
                      {agent.context ? (
                        <Text
                          fontSize={12}
                          color={c.text}
                          lineHeight="$4"
                          fontFamily="$mono"
                          whiteSpace="pre-wrap"
                        >
                          {agent.context}
                        </Text>
                      ) : (
                        <Text fontSize={12} color={c.text3} fontStyle="italic">
                          {t("agent.noContextConfigured")}
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
                      <H2 fontSize={14} color={c.text}>
                        {t("agent.tabApps")}
                      </H2>
                      {apps.filter((a) => a.hasAccess).length > 0 && (
                        <YStack
                          backgroundColor={INDIGO}
                          paddingHorizontal={8}
                          paddingVertical={4}
                          borderRadius={6}
                        >
                          <Text color={INDIGO} fontSize={11} fontWeight="600">
                            {apps.filter((a) => a.hasAccess).length}
                          </Text>
                        </YStack>
                      )}
                    </XStack>
                    <Button
                      size="$3"
                      backgroundColor={INDIGO}
                      color="white"
                      icon={<Plus size={16} />}
                      onPress={() => setShowAddApp(true)}
                    >
                      {t("agent.addApp")}
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
                          backgroundColor={c.bgCard}
                          borderRadius={8}
                          borderWidth={1}
                          borderColor={c.border}
                          gap={12}
                        >
                          <Package size={48} color={c.text3} />
                          <Text fontSize={13} fontWeight="600" color={c.text2}>
                            {t("agent.noAppsAssigned")}
                          </Text>
                          <Text fontSize={12} color={c.text3} textAlign="center">
                            {t("agent.noAppsHint")}
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

              {/* Skills Tab */}
              {activeTab === 'skills' && (
                <YStack gap={12}>
                  <XStack justifyContent="space-between" alignItems="center">
                    <XStack alignItems="center" gap={8}>
                      <Text fontSize={14} fontWeight="600" color={c.text}>
                        {t("agent.skillsTitle")}
                      </Text>
                      {skills.filter((s) => s.hasAccess).length > 0 && (
                        <YStack
                          backgroundColor={INDIGO}
                          paddingHorizontal={8}
                          paddingVertical={4}
                          borderRadius={6}
                        >
                          <Text color={INDIGO} fontSize={11} fontWeight="600">
                            {skills.filter((s) => s.hasAccess).length}
                          </Text>
                        </YStack>
                      )}
                    </XStack>
                  </XStack>

                  <YStack
                    backgroundColor={INDIGO_GLOW}
                    borderRadius={6}
                    padding={10}
                    borderWidth={1}
                    borderColor={INDIGO_BORDER}
                  >
                    <Text fontSize={11} color={INDIGO}>
                      {t("agent.skillsHint")}
                    </Text>
                  </YStack>

                  {loadingSkills ? (
                    <YStack padding={32} alignItems="center">
                      <AppSpinner size="lg" variant="brand" />
                      <Text color={c.text2} marginTop={12}>
                        {t("agent.loadingSkills")}
                      </Text>
                    </YStack>
                  ) : skills.length === 0 ? (
                    <YStack
                      padding={32}
                      alignItems="center"
                      backgroundColor={c.bgCard}
                      borderRadius={8}
                      borderWidth={1}
                      borderColor={c.border}
                      gap={12}
                    >
                      <Sparkles size={48} color={c.text3} />
                      <Text fontSize={14} fontWeight="600" color={c.text2}>
                        {t("agent.noSkillsAvailable")}
                      </Text>
                      <Text fontSize={12} color={c.text3} textAlign="center">
                        {t("agent.noSkillsHint")}
                      </Text>
                    </YStack>
                  ) : (
                    <YStack gap={8}>
                      {skills.map((skill) => (
                        <XStack
                          key={skill.skillId}
                          backgroundColor={skill.hasAccess ? INDIGO_GLOW : c.bgCard}
                          borderRadius={8}
                          padding={12}
                          borderWidth={1}
                          borderColor={skill.hasAccess ? INDIGO : c.border}
                          alignItems="center"
                          gap={12}
                          hoverStyle={{
                            backgroundColor: skill.hasAccess ? INDIGO_GLOW : c.bgCardHover,
                            borderColor: skill.hasAccess ? INDIGO : c.borderStrong,
                          }}
                        >
                          <YStack
                            width={36}
                            height={36}
                            borderRadius={8}
                            backgroundColor={skill.hasAccess ? INDIGO_GLOW : c.border}
                            justifyContent="center"
                            alignItems="center"
                          >
                            <Sparkles size={18} color={skill.hasAccess ? INDIGO : c.text3} />
                          </YStack>

                          <YStack flex={1} minWidth={0}>
                            <Text fontSize={13} fontWeight="600" color={skill.hasAccess ? c.text : c.text2} numberOfLines={1}>
                              {skill.name}
                            </Text>
                            {skill.description && (
                              <Text fontSize={11} color={c.text3} numberOfLines={2}>
                                {skill.description}
                              </Text>
                            )}
                          </YStack>

                          {/* Toggle switch */}
                          <XStack
                            width={44}
                            height={24}
                            borderRadius={12}
                            backgroundColor={skill.hasAccess ? INDIGO : c.borderStrong}
                            alignItems="center"
                            paddingHorizontal={3}
                            cursor={togglingSkill === skill.skillId ? 'not-allowed' : 'pointer'}
                            opacity={togglingSkill === skill.skillId ? 0.6 : 1}
                            onPress={async () => {
                              if (!agent || togglingSkill === skill.skillId) return;
                              setTogglingSkill(skill.skillId);
                              try {
                                if (skill.hasAccess) {
                                  await client.skillRequest('skill.revoke-access', {
                                    agentId: agent.agentId,
                                    skillId: skill.skillId,
                                  });
                                  setSkills((prev) =>
                                    prev.map((s) =>
                                      s.skillId === skill.skillId
                                        ? { ...s, hasAccess: false, enabled: false }
                                        : s,
                                    ),
                                  );
                                } else {
                                  await client.skillRequest('skill.grant-access', {
                                    agentId: agent.agentId,
                                    skillId: skill.skillId,
                                  });
                                  setSkills((prev) =>
                                    prev.map((s) =>
                                      s.skillId === skill.skillId
                                        ? { ...s, hasAccess: true, enabled: true }
                                        : s,
                                    ),
                                  );
                                }
                              } catch (err) {
                                console.error('[AgentWindow] Failed to toggle skill:', err);
                                toast.error(
                                  skill.hasAccess ? 'No se pudo desactivar la skill' : 'No se pudo activar la skill',
                                  err instanceof Error ? err.message : 'Error desconocido',
                                );
                              } finally {
                                setTogglingSkill(null);
                              }
                            }}
                          >
                            <YStack
                              width={18}
                              height={18}
                              borderRadius={9}
                              backgroundColor="white"
                              style={{
                                transform: [{ translateX: skill.hasAccess ? 20 : 0 }],
                              } as any}
                            />
                          </XStack>
                        </XStack>
                      ))}
                    </YStack>
                  )}
                </YStack>
              )}

              {/* Model Tab */}
              {activeTab === 'model' && (
                <YStack gap={16}>
                  <H2 fontSize={14} color={c.text}>
                    {t("agent.llmModel")}
                  </H2>

                  <Text fontSize={12} color={c.text2}>
                    {t("agent.modelSelectHint")}
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
                      <Text fontSize={13} fontWeight="600" color={RED}>
                        {t("agent.noProvidersConfigured")}
                      </Text>
                      <Text fontSize={12} color={c.text2}>
                        {t("agent.noProvidersHint")}
                      </Text>
                      <Text fontSize={12} color={c.text2}>
                        {t("agent.noProvidersAction")}
                      </Text>
                    </YStack>
                  ) : (
                    <>
                      <YStack gap={12}>
                        {/* System default option */}
                        <XStack
                          padding={12}
                          backgroundColor={!agent.selectedModelId ? INDIGO_GLOW : c.bgCard}
                          borderRadius={6}
                          borderWidth={1}
                          borderColor={!agent.selectedModelId ? INDIGO : c.border}
                          alignItems="center"
                          gap={12}
                          cursor="pointer"
                          hoverStyle={{ backgroundColor: !agent.selectedModelId ? INDIGO_GLOW : c.bgCardHover }}
                          pressStyle={{ opacity: 0.8 }}
                          onPress={async () => {
                            if (!agent.selectedModelId) return;
                            setSavingProvider(true);
                            try {
                              await client.updateAgent({
                                agentId: agent.agentId,
                                availableProviders: [],
                                selectedProviderId: null,
                                selectedModelId: null,
                              });
                              setAgent({
                                ...agent,
                                availableProviders: [],
                                selectedProviderId: null,
                                selectedModelId: null,
                              });
                            } catch (err) {
                              console.error('Failed to clear model:', err);
                            } finally {
                              setSavingProvider(false);
                            }
                          }}
                        >
                          <YStack
                            width={8}
                            height={8}
                            borderRadius={4}
                            backgroundColor={INDIGO}
                          />
                          <YStack flex={1}>
                            <Text fontSize={12} fontWeight="500" color={!agent.selectedModelId ? INDIGO_LIGHT : c.text2}>
                              {t("agent.systemDefault")}
                            </Text>
                            <Text fontSize={11} color={c.text3}>
                              {t("agent.systemDefaultHint")}
                            </Text>
                          </YStack>
                          {!agent.selectedModelId && (
                            <YStack
                              backgroundColor={INDIGO}
                              paddingHorizontal={8}
                              paddingVertical={4}
                              borderRadius={4}
                            >
                              <Text fontSize={11} color="white" fontWeight="600">
                                {t("agent.active")}
                              </Text>
                            </YStack>
                          )}
                          {savingProvider && !agent.selectedModelId && (
                            <AppSpinner size="sm" variant="brand" />
                          )}
                        </XStack>

                        {/* Provider models */}
                        {providers.map((provider) => (
                          <YStack key={provider.providerId} gap={8}>
                            <Text fontSize={12} fontWeight="600" color={c.text2} marginTop={8}>
                              {provider.displayName}
                            </Text>
                            {provider.models.map((model) => {
                              const isSelected = agent.selectedModelId === model.modelId;
                              const providerColor =
                                provider.providerType === 'anthropic-oauth' ||
                                provider.providerType === 'anthropic'
                                  ? ORANGE
                                  : provider.providerType === 'openai'
                                    ? GREEN
                                    : VIOLET;
                              return (
                                <XStack
                                  key={model.modelId}
                                  padding={12}
                                  backgroundColor={isSelected ? GREEN_GLOW : c.bgCard}
                                  borderRadius={6}
                                  borderWidth={1}
                                  borderColor={isSelected ? GREEN : c.border}
                                  alignItems="center"
                                  gap={12}
                                  cursor="pointer"
                                  hoverStyle={{ backgroundColor: isSelected ? GREEN_GLOW : c.bgCardHover }}
                                  pressStyle={{ opacity: 0.8 }}
                                  onPress={() => {
                                    if (isSelected) return;
                                    retentionGuard(
                                      resolveRetention(provider.providerType, provider.config),
                                      model.modelId,
                                      model.modelId,
                                      async () => {
                                        setSavingProvider(true);
                                        try {
                                          await client.updateAgent({
                                            agentId: agent.agentId,
                                            availableProviders: [provider.providerId],
                                            selectedProviderId: provider.providerId,
                                            selectedModelId: model.modelId,
                                          });
                                          setAgent((prev) =>
                                            prev
                                              ? {
                                                  ...prev,
                                                  availableProviders: [provider.providerId],
                                                  selectedProviderId: provider.providerId,
                                                  selectedModelId: model.modelId,
                                                }
                                              : prev,
                                          );
                                        } catch (err) {
                                          console.error('Failed to update model:', err);
                                        } finally {
                                          setSavingProvider(false);
                                        }
                                      },
                                    );
                                  }}
                                >
                                  <YStack
                                    width={8}
                                    height={8}
                                    borderRadius={4}
                                    backgroundColor={providerColor}
                                  />
                                  <YStack flex={1} gap={4}>
                                    <Text fontSize={12} fontWeight="500" color={c.text}>
                                      {model.modelId}
                                    </Text>
                                    <Text fontSize={11} color={c.text2} fontFamily="$mono">
                                      {model.modelString}
                                    </Text>
                                    <XStack>
                                      <RetentionBadge
                                        info={resolveRetention(provider.providerType)}
                                        compact
                                      />
                                    </XStack>
                                  </YStack>
                                  {isSelected && (
                                    <YStack
                                      backgroundColor={GREEN}
                                      paddingHorizontal={8}
                                      paddingVertical={4}
                                      borderRadius={4}
                                    >
                                      <Text fontSize={11} color="white" fontWeight="600">
                                        {t("agent.active")}
                                      </Text>
                                    </YStack>
                                  )}
                                  {savingProvider && isSelected && (
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

          {/* Data-retention confirmation when switching to a 🔴 model */}
          <RetentionConfirmModal {...retentionModalProps} />

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
              animation={"lazy" as any}
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
              backgroundColor={isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)'}
            />
            <Sheet.Frame backgroundColor="$background" padding={16} gap={16}>
              <Sheet.Handle />

              <XStack justifyContent="space-between" alignItems="center">
                <Text fontSize={14} fontWeight="600" color={c.text}>
                  {t("agent.addApp")}
                </Text>
                <Button
                  size="$2"
                  circular
                  backgroundColor="transparent"
                  icon={<X size={18} color={c.text2} />}
                  onPress={() => setShowAddApp(false)}
                />
              </XStack>

              <XStack
                backgroundColor={c.bgCard}
                borderRadius={6}
                paddingHorizontal={12}
                paddingVertical={8}
                alignItems="center"
                gap={8}
                borderWidth={1}
                borderColor={c.border}
              >
                <Search size={18} color={c.text3} />
                <Input
                  flex={1}
                  placeholder={t("agent.searchApps")}
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
                        backgroundColor={c.bgCard}
                        borderRadius={6}
                        padding={12}
                        borderWidth={1}
                        borderColor={c.border}
                        alignItems="center"
                        gap={12}
                        cursor="pointer"
                        hoverStyle={{
                          backgroundColor: c.bgCardHover,
                          borderColor: INDIGO,
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
                          backgroundColor={app.color || c.bgCardHover}
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
                          <Text fontSize={12} fontWeight="500" color={c.text}>
                            {app.name}
                          </Text>
                          <Text fontSize={11} color={c.text2} numberOfLines={1}>
                            {app.description}
                          </Text>
                        </YStack>
                        <Plus size={18} color={INDIGO} />
                      </XStack>
                    ))}
                  {apps
                    .filter((a) => !a.hasAccess)
                    .filter(
                      (a) =>
                        searchQuery === '' || a.name.toLowerCase().includes(searchQuery.toLowerCase()),
                    ).length === 0 && (
                    <Text color={c.text3} textAlign="center" padding={16}>
                      {searchQuery ? t("agent.noAppsFound") : t("agent.allAppsAssigned")}
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
              animation={"lazy" as any}
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
              backgroundColor={isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)'}
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
                  <Trash2 size={30} color={RED} />
                </YStack>

                <Text fontSize={14} fontWeight="600" color={c.text} textAlign="center">
                  {t("agent.deleteAgent")}
                </Text>

                <Text fontSize={12} color={c.text2} textAlign="center">
                  {t("agent.deleteAgentConfirm", { name: agent.fullName || agent.name })}
                </Text>

                <XStack gap={12} marginTop={8}>
                  <Button
                    flex={1}
                    size="$4"
                    onPress={() => setShowDeleteConfirm(false)}
                    disabled={deleting}
                    backgroundColor={c.bgCardHover}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    flex={1}
                    size="$4"
                    onPress={deleteAgent}
                    disabled={deleting}
                    backgroundColor={RED}
                    color="white"
                    icon={deleting ? <AppSpinner size="sm" /> : undefined}
                  >
                    {deleting ? t("agent.deleting") : t("common.delete")}
                  </Button>
                </XStack>
              </YStack>
            </Sheet.Frame>
          </Sheet>
        </>
      )}

      {/* Appearance Modal */}
      {showAppearanceModal && (
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
            zIndex: 100,
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
              borderColor: c.borderStrong,
            }}
          >
            {/* Header */}
            <XStack
              padding="$3"
              borderBottomWidth={1}
              borderBottomColor={c.borderStrong}
              justifyContent="space-between"
              alignItems="center"
            >
              <Text fontSize={16} fontWeight="600" color={c.text}>
                {t("agent.customizeAppearance")}
              </Text>
              <TouchableOpacity onPress={() => setShowAppearanceModal(false)}>
                <X size={20} color={c.text3} />
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
                <Text color={c.text3} fontSize={12} marginTop="$2">
                  {t("agent.preview")}
                </Text>
              </YStack>

              {/* Color Picker */}
              <YStack gap="$2" marginBottom="$4">
                <Text color={c.text2} fontSize={12} fontWeight="500">
                  {t("agent.labelColor")}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {WORKSPACE_COLORS.map((color) => {
                    const isSelected = selectedColor === color;
                    const palette = COLOR_PALETTE[color as WorkspaceColor];
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
                </View>
              </YStack>

              {/* Icon Picker */}
              <YStack gap="$2">
                <Text color={c.text2} fontSize={12} fontWeight="500">
                  {t("agent.labelIcon")}
                </Text>

                {/* Search input */}
                <TextInput
                  value={iconSearch}
                  onChangeText={setIconSearch}
                  placeholder={t("agent.searchIconPlaceholder")}
                  placeholderTextColor={c.text3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{
                    backgroundColor: c.bgCardHover,
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
                  const palette = COLOR_PALETTE[selectedColor as WorkspaceColor] || COLOR_PALETTE.cyan;

                  if (icons.length === 0) {
                    return (
                      <Text color={c.text3} fontSize={12} textAlign="center" paddingVertical="$3">
                        {t("agent.noIconsFound", { query: iconSearch })}
                      </Text>
                    );
                  }

                  return (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {icons.map((icon) => {
                        const isSelected = selectedIcon === icon;
                        const iconName = icon
                          .split('-')
                          .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
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
                                : c.border,
                              justifyContent: 'center',
                              alignItems: 'center',
                              borderWidth: 1,
                              borderColor: isSelected ? palette['500'] : 'transparent',
                            }}
                          >
                            <IconComponent
                              size={16}
                              color={isSelected ? palette['500'] : '#71717A'}
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
              borderTopColor={c.borderStrong}
              justifyContent="flex-end"
              gap="$2"
            >
              <TouchableOpacity
                onPress={() => setShowAppearanceModal(false)}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: c.border,
                }}
              >
                <Text color={c.text2} fontSize={13}>
                  {t("common.cancel")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSaveAppearance}
                disabled={savingAppearance}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: INDIGO,
                  opacity: savingAppearance ? 0.5 : 1,
                  minWidth: 100,
                  alignItems: 'center',
                }}
              >
                {savingAppearance ? (
                  <AppSpinner size="sm" variant="onDark" />
                ) : (
                  <Text color={c.text} fontSize={13} fontWeight="500">
                    {t("common.save")}
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
