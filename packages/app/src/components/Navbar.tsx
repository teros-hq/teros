import {
  BookOpen,
  Building2,
  ChevronDown,
  Cloud,
  Cpu,
  CreditCard,
  Flag,
  FolderKanban,
  Gauge,
  Grid,
  Moon,
  MessageSquare,
  Sun,
  Package,
  PanelLeft,
  PanelLeftClose,
  ChevronRight,
  Plus,
  Settings,
  Sparkles,
  Store,
  User,
  UserCircle,
  Users,
  X,
  Zap,
} from '@tamagui/lucide-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from "react-i18next"
import { getTerosClient } from '../services/terosClientSingleton';
import { useClickModifiers } from '../hooks/useClickModifiers';
import { useImageWithFallback } from '../hooks/useImageWithFallback';
import {
  useNavbarRealtimeSync,
  type NavbarRealtimeConversation,
  type NavbarRealtimeProject,
} from '../hooks/navbar/useNavbarRealtimeSync';
import { useBillingStore } from '../store/billingStore';
import { useNavbarStore } from '../store/navbarStore';
import { useTilingStore } from '../store/tilingStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useUiPreferencesStore } from '../store/uiPreferencesStore';
import { AgentAvatarStack } from './AgentAvatarStack';
import { DesktopIndicator } from './DesktopIndicator';
import { NewConversationModal } from './NewConversationModal';
// TODO: GettingStartedWidget disabled — needs redesign before re-enabling
// import { GettingStartedWidget } from './onboarding/GettingStartedWidget';
import { TerosLogo } from './TerosLogo';
import { WorkspaceIcon } from './WorkspaceIcon';
import { PermissionIndicator } from './navbar/PermissionIndicator';
import { useColors } from './mca/primitives/useColors';
import { colors as semanticColors, controlsBar, indicators, surface } from './mca/primitives/colors';

// Breakpoints
const MOBILE_BREAKPOINT = 768;
const COLLAPSED_WIDTH = 56;
const EXPANDED_WIDTH = 260;

interface NavbarProps {
  userName?: string;
  userRole?: string;
  onLogout?: () => void;
  onWhatsNew?: () => void;
  children?: React.ReactNode;
}

/**
 * Agent avatar used across the navbar. Owns its own error state so a 404 falls
 * back to the initial instead of the broken-image glyph. `imageStyle` is the
 * shared style for both the <Image> and the initial placeholder so sizing stays
 * identical across the collapsed/expanded/list variants.
 */
function NavbarAvatar({
  avatarUrl,
  initial,
  imageStyle,
}: {
  avatarUrl?: string;
  initial: string;
  imageStyle: object;
}) {
  const styles = useNavbarStyles();
  const { showImage, onError } = useImageWithFallback(avatarUrl);

  if (showImage) {
    return <Image source={{ uri: avatarUrl }} style={imageStyle} onError={onError} />;
  }
  return (
    <View style={[imageStyle, styles.avatarCyan]}>
      <Text style={styles.avatarText}>{initial}</Text>
    </View>
  );
}

export function Navbar({ userName = 'User', userRole = 'user', onLogout, onWhatsNew, children }: NavbarProps) {
  const { t } = useTranslation()
  const c = useColors()
  const styles = useNavbarStyles()
  const [hoveredSection, setHoveredSection] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = getTerosClient();

  // Stores
  const {
    agents,
    apps,
    workspaces,
    isLoaded,
    isExpanded,
    isMobileMenuOpen,
    setAgents,
    addAgent,
    setApps,
    setWorkspaces,
    setLoaded,
    setExpanded,
    setMobileMenuOpen,
    loadExpandedState,
  } = useNavbarStore();

  const { openWindow } = useTilingStore();
  const pendingBillingRequests = useBillingStore((s) => s.pendingAdminRequests);
  const { shouldOpenInNewTab } = useClickModifiers();

  // Active workspace
  const { activeWorkspaceId, setActiveWorkspace, hydrateActiveWorkspace } = useWorkspaceStore();

  // Recent conversations state (loaded from backend)
  const [recentConversations, setRecentConversations] = useState<
    Array<{
      channelId: string;
      title: string;
      agentId?: string;
      agentName?: string;
      agentAvatarUrl?: string;
      lastMessageAt?: string;
    }>
  >([]);
  const [totalActiveConvs, setTotalActiveConvs] = useState(0);
  const [totalInactiveConvs, setTotalInactiveConvs] = useState(0);
  const [totalArchivedConvs, setTotalArchivedConvs] = useState(0);

  // Loads the conversation list (top-10 recent + per-bucket totals) from the
  // backend and recomputes the derived state. Called on initial load AND after
  // structural channel mutations (create/archive) so the totals that feed the
  // "N more" button stay in sync with the list instead of drifting until the
  // next full reload. Reads the agents cache from the navbar store (hydrated by
  // loadData) so it needs no agent args.
  const refreshConversations = useCallback(async () => {
    const currentWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const { channels } = await client.channel.list(currentWorkspaceId ?? undefined);
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;

    // Exclude headless and sub-conversations (delegated); split into buckets.
    const parentChannels = channels.filter((ch: any) => !ch.headless && !ch.originChannelId);
    const archivedChannels = parentChannels.filter((ch: any) => ch.status === 'closed');
    const nonClosedChannels = parentChannels.filter((ch: any) => ch.status !== 'closed');
    const isActive = (ch: any) => {
      const lastActivity = ch.lastMessage?.timestamp || ch.updatedAt;
      return !!lastActivity && new Date(lastActivity).getTime() >= threeHoursAgo;
    };
    const activeChannels = nonClosedChannels.filter(isActive);
    const inactiveChannels = nonClosedChannels.filter((ch: any) => !isActive(ch));

    setTotalActiveConvs(activeChannels.length);
    setTotalInactiveConvs(inactiveChannels.length);
    setTotalArchivedConvs(archivedChannels.length);

    // Top-10 most recent (active first, then inactive), resolved against the
    // navbar agents cache.
    const agents = useNavbarStore.getState().agents;
    const sortedChannels = [...activeChannels, ...inactiveChannels]
      .sort((a: any, b: any) => {
        const dateA = a.lastMessage?.timestamp || a.updatedAt || 0;
        const dateB = b.lastMessage?.timestamp || b.updatedAt || 0;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      })
      .slice(0, 10);

    setRecentConversations(
      sortedChannels.map((ch: any) => {
        const agent = agents.find((a) => a.agentId === ch.agentId);
        if (!ch.workspaceId) {
          // Superagents (workspaceId: null on the agent) are valid — no workspace.
          const isSuperagent = agent && !agent.workspaceId;
          if (!isSuperagent) {
            console.warn(
              `[Navbar] Channel ${ch.channelId} has no workspaceId and agent is not a superagent — possible data integrity issue`,
            );
          }
        }
        return {
          channelId: ch.channelId,
          title: ch.metadata?.name || t("nav.chat"),
          agentId: ch.agentId,
          agentName: agent?.name,
          agentAvatarUrl: agent?.avatarUrl,
          lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
        };
      }),
    );
  }, [client, t]);

  // Projects state
  const [projects, setProjects] = useState<Array<{ projectId: string; name: string }>>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');

  // State for modals
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const workspaceSelectorRef = useRef<View>(null);
  const [dropdownTop, setDropdownTop] = useState(48);

  // Measure selector position when dropdown opens
  useLayoutEffect(() => {
    if (showWorkspaceDropdown && workspaceSelectorRef.current && Platform.OS === 'web') {
      workspaceSelectorRef.current.measureInWindow((x, y, width, height) => {
        setDropdownTop(y + height + 4);
      });
    }
  }, [showWorkspaceDropdown]);

  // Scroll state for gradient indicators
  const [scrollState, setScrollState] = useState({ canScrollUp: false, canScrollDown: false });
  const scrollViewRef = useRef<ScrollView>(null);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const canScrollUp = contentOffset.y > 5;
    const canScrollDown = contentOffset.y < contentSize.height - layoutMeasurement.height - 5;
    setScrollState({ canScrollUp, canScrollDown });
  }, []);

  const handleContentSizeChange = useCallback((contentWidth: number, contentHeight: number) => {
    // Check initial scroll state when content size changes
    const current = scrollViewRef.current;
    if (current && 'measure' in current) {
      (current as any).measure((_x: number, _y: number, _width: number, height: number) => {
        const canScrollDown = contentHeight > height;
        setScrollState((prev) => ({ ...prev, canScrollDown }));
      });
    }
  }, []);

  // Superagents: agents without a workspaceId
  const superAgents = useMemo(
    () => agents.filter((agent) => !agent.workspaceId),
    [agents],
  );

  // Workspace agents: agents belonging to the active workspace
  const workspaceAgents = useMemo(
    () => agents.filter((agent) => agent.workspaceId && agent.workspaceId === activeWorkspaceId),
    [agents, activeWorkspaceId],
  );

  // Sort apps alphabetically
  const sortedApps = useMemo(() => [...apps].sort((a, b) => a.name.localeCompare(b.name)), [apps]);

  // Sort workspaces: private first, then rest alphabetically
  const sortedWorkspaces = useMemo(
    () => [
      ...workspaces.filter((ws) => ws.type === 'private'),
      ...[...workspaces.filter((ws) => ws.type !== 'private')].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ],
    [workspaces],
  );

  const isMobile = width < MOBILE_BREAKPOINT;
  const isAdmin = userRole === 'admin' || userRole === 'super';

  // Load navbar expanded state from storage
  useEffect(() => {
    loadExpandedState();
  }, []);

  // Load agents and apps data
  useEffect(() => {
    let mounted = true;

    const loadData = async () => {
      if (isLoaded) return;

      try {
        // Load global agents
        const globalAgents = await client.agent.listAgents().then((r) => r.agents);

        // Load apps (filtered by active workspace)
        const appsWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
        let userApps: any[] = [];
        if (appsWorkspaceId) {
          try {
            const { apps: wsApps } = await client.workspace.listWorkspaceApps(appsWorkspaceId);
            userApps = wsApps ?? [];
          } catch {
            userApps = [];
          }
        }
        if (mounted) {
          setApps(
            userApps.map((app) => ({
              ...app,
              mcaName: app.mcpName ?? app.mcaId,
              icon: app.icon,
              color: app.color,
            })),
          );
        }

        // Load workspaces
        const { workspaces: userWorkspaces } = await client.workspace.listWorkspaces();
        const mappedWorkspaces = userWorkspaces.map((ws: any) => ({
          workspaceId: ws.workspaceId,
          name: ws.name,
          role: ws.role,
          volumeId: ws.volumeId,
          appearance: ws.appearance,
          type: ws.type,
        }));
        if (mounted) {
          setWorkspaces(mappedWorkspaces);

          // Hydrate active workspace from storage (sessionStorage first, then localStorage fallback)
          await hydrateActiveWorkspace();

          // If still no active workspace, default to Private Workspace
          const currentActiveId = useWorkspaceStore.getState().activeWorkspaceId;
          if (!currentActiveId) {
            const privateWs = mappedWorkspaces.find((ws: any) => ws.type === 'private');
            if (privateWs) {
              setActiveWorkspace(privateWs.workspaceId);
            }
          }
        }

        // Load projects from active workspace board
        const activeWsId = useWorkspaceStore.getState().activeWorkspaceId;
        if (activeWsId) {
          try {
            const { projects: boardProjects } = await client.board.listProjects(activeWsId);
            if (mounted) {
              setProjects(boardProjects.map((p: any) => ({ projectId: p.projectId, name: p.name })));
            }
          } catch (err) {
            console.warn('[Navbar] Failed to load projects:', err);
            if (mounted) setProjects([]);
          }
        }

        // Load agents from each workspace (in parallel)
        const workspaceAgentsPromises = userWorkspaces.map((ws: any) =>
          client.agent.listAgents(ws.workspaceId).then((r) => r.agents).catch(() => []),
        );
        const workspaceAgentsResults = await Promise.all(workspaceAgentsPromises);

        // Combine global and workspace agents (deduplicate by agentId)
        if (mounted) {
          const seenIds = new Set<string>();
          const allAgents = [
            ...globalAgents.map((a) => ({
              agentId: a.agentId,
              name: a.fullName || a.name,
              role: a.role,
              avatarUrl: a.avatarUrl,
              coreId: a.coreId,
              workspaceId: a.workspaceId,
            })),
            ...workspaceAgentsResults.flat().map((a: any) => ({
              agentId: a.agentId,
              name: a.fullName || a.name,
              role: a.role,
              avatarUrl: a.avatarUrl,
              coreId: a.coreId,
              workspaceId: a.workspaceId,
            })),
          ].filter((a) => {
            if (seenIds.has(a.agentId)) return false;
            seenIds.add(a.agentId);
            return true;
          });
          setAgents(allAgents);
        }

        // Load recent conversations + bucket totals (agents were just hydrated above).
        if (mounted) {
          await refreshConversations();
        }

        if (mounted) {
          setLoaded(true);
        }
      } catch (err) {
        console.error('Failed to load navbar data:', err);
      }
    };

    const handleConnected = () => {
      setLoaded(false);
      loadData();
    };

    if (client.isConnected() && !isLoaded) {
      loadData();
    }

    client.on('connected', handleConnected);
    client.on('authenticated', handleConnected);

    return () => {
      mounted = false;
      client.off('connected', handleConnected);
      client.off('authenticated', handleConnected);
    };
  }, [isLoaded, refreshConversations]);

  // Reload navbar data when active workspace changes
  useEffect(() => {
    if (activeWorkspaceId !== undefined) {
      // Force a reload by resetting isLoaded
      setLoaded(false);
    }
  }, [activeWorkspaceId]);

  // Realtime NavBar sync (TER-304) — agents/workspaces/apps update the store
  // directly; conversations/projects flow through these callbacks because they
  // are local component state with NavBar-specific logic (top-10, buckets).
  const handleConversationChange = useCallback(
    (action: 'created' | 'updated' | 'deleted', payload: NavbarRealtimeConversation) => {
      if (action === 'deleted') {
        setRecentConversations((prev) => prev.filter((c) => c.channelId !== payload.channelId));
        // Reconcile the bucket totals ("N more" button) with the backend — the
        // optimistic removal above only touches the visible top-10 list.
        void refreshConversations();
        return;
      }
      // Resolve missing fields from (1) the previous entry (preserve agentName/
      // avatar across partial `updated` payloads like rename) and (2) the
      // navbar agents cache as final fallback. Defense-in-depth: even if a
      // backend handler emits a partial payload, the conversation keeps its
      // identity instead of regressing to a generic "Chat" without avatar.
      const navAgents = useNavbarStore.getState().agents;

      setRecentConversations((prev) => {
        const prevEntry = prev.find((c) => c.channelId === payload.channelId);
        const next = prev.filter((c) => c.channelId !== payload.channelId);

        const agentId = payload.agentId ?? prevEntry?.agentId;
        const agent = agentId ? navAgents.find((a) => a.agentId === agentId) : undefined;
        const merged = [
          {
            channelId: payload.channelId,
            title:
              payload.title && payload.title !== "Chat"
                ? payload.title
                : prevEntry?.title || agent?.name || payload.title || t("nav.chat"),
            agentId,
            agentName: payload.agentName ?? prevEntry?.agentName ?? agent?.name,
            agentAvatarUrl:
              payload.agentAvatarUrl ?? prevEntry?.agentAvatarUrl ?? agent?.avatarUrl,
            lastMessageAt: payload.lastMessageAt ?? prevEntry?.lastMessageAt,
          },
          ...next,
        ];
        return merged
          .sort((a, b) => {
            const da = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
            const db = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
            return db - da;
          })
          .slice(0, 10);
      });

      // A newly created channel changes the active total; reconcile it (an
      // `updated` event only mutates an existing row, so totals don't move).
      if (action === 'created') {
        void refreshConversations();
      }
    },
    [refreshConversations, t],
  );

  const handleProjectChange = useCallback(
    (action: 'created' | 'updated' | 'deleted', payload: NavbarRealtimeProject) => {
      if (action === 'deleted') {
        setProjects((prev) => prev.filter((p) => p.projectId !== payload.projectId));
        return;
      }
      setProjects((prev) => {
        const exists = prev.some((p) => p.projectId === payload.projectId);
        if (action === 'created' && exists) return prev;
        if (action === 'updated' && !exists) return prev;
        if (action === 'created') {
          return [...prev, { projectId: payload.projectId, name: payload.name ?? '' }];
        }
        return prev.map((p) =>
          p.projectId === payload.projectId
            ? { ...p, name: payload.name ?? p.name }
            : p,
        );
      });
    },
    [],
  );

  useNavbarRealtimeSync({
    onConversationChange: handleConversationChange,
    onProjectChange: handleProjectChange,
  });

  // Close mobile menu when switching to desktop
  useEffect(() => {
    if (!isMobile && isMobileMenuOpen) {
      setMobileMenuOpen(false);
    }
  }, [isMobile]);

  const sidebarWidth = isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;

  // Handlers
  const handleOpenAgent = (agentId: string, e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('agent', { agentId, workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined }, inNewTab);
  };

  const handleOpenConversation = (channelId: string, e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('chat', { channelId }, inNewTab);
  };

  const handleOpenApps = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('apps', { workspaceId: activeWorkspaceId ?? undefined }, inNewTab);
  };

  const handleOpenCatalog = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('catalog', { workspaceId: activeWorkspaceId ?? undefined }, inNewTab);
  };

  const handleOpenSkills = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('skills', { workspaceId: activeWorkspaceId ?? undefined }, inNewTab);
  };

  const handleNewConversation = () => {
    console.log('[Navbar] handleNewConversation called');
    setMobileMenuOpen(false);
    setShowNewConversationModal(true);
  };

  const handleSelectAgentForConversation = (
    agent: { agentId: string; name: string; fullName: string },
    e?: any,
  ) => {
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow(
      'chat',
      {
        agentId: agent.agentId,
        agentName: agent.name || agent.fullName,
        workspaceId: activeWorkspaceId ?? undefined,
      },
      inNewTab,
    );
  };

  const handleOpenAgentCores = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('agent-cores', {}, inNewTab);
  };

  const handleOpenMcas = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('mcas', {}, inNewTab);
  };

  const handleOpenUsers = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('users', {}, inNewTab);
  };

  // Monitoring suite is one entry now — Usage & Costs, Agent Activity, Model
  // Health and Session Trace are reached by drilling from the hub / its shared
  // MonitoringHeader, not from four separate Navbar items.
  const handleOpenMonitoring = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('monitoring', {}, inNewTab);
  };

  const handleOpenLatitudeSignals = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('latitude-signals', {}, inNewTab);
  };

  const handleOpenFeatureFlags = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('feature-flags', {}, inNewTab);
  };

  const handleOpenBillingRequests = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('billing-requests', {}, inNewTab);
  };

  const handleOpenBillingTeams = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('billing-teams', {}, inNewTab);
  };

  const handleOpenProviders = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('providers', {}, inNewTab);
  };

  const handleOpenProfile = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('profile', { onLogout }, inNewTab);
  };

  const handleOpenWorkspacesList = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('workspaces', {}, inNewTab);
  };

  const handleOpenWorkspace = (workspaceId: string, e?: any) => {
    setMobileMenuOpen(false);
    setActiveWorkspace(workspaceId);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('workspace', { workspaceId }, inNewTab);
  };

  const handleOpenWorkspaceWindow = (workspaceId: string, e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('workspace', { workspaceId }, inNewTab);
  };

  // Render sidebar content
  const renderSidebarContent = (collapsed: boolean) => (
    <>
      {/* Header — fused Teros logo + first superagent pill */}
      {(() => {
        const firstSuperAgent = superAgents[0];
        const extraCount = superAgents.length - 1;
        const firstName = firstSuperAgent ? firstSuperAgent.name.split(' ')[0] : null;
        return (
          <>
            {collapsed ? (
              /* Collapsed: logo on top, superagent avatar below */
              <View style={styles.sidebarHeaderCollapsedStack}>
                <TouchableOpacity onPress={() => router.push('/' as any)} style={styles.collapsedLogoBtn}>
                  <TerosLogo size={20} color={semanticColors.indigo} />
                </TouchableOpacity>
                {firstSuperAgent && (
                  <TouchableOpacity
                    style={styles.collapsedSuperAgentBtn}
                    onPress={(e) => handleOpenAgent(firstSuperAgent.agentId, e)}
                  >
                    <NavbarAvatar
                      avatarUrl={firstSuperAgent.avatarUrl}
                      initial={firstName!.charAt(0)}
                      imageStyle={styles.headerAvatar}
                    />
                  </TouchableOpacity>
                )}
              </View>
            ) : (
              /* Expanded: fused pill */
              <View style={styles.fusedHeaderPill}>
                <TouchableOpacity onPress={() => router.push('/' as any)}>
                  <TerosLogo size={20} color={semanticColors.indigo} />
                </TouchableOpacity>
                {firstSuperAgent && (
                  <>
                    <View style={styles.fusedHeaderSeparator} />
                    <TouchableOpacity
                      style={styles.fusedHeaderAgent}
                      onPress={(e) => handleOpenAgent(firstSuperAgent.agentId, e)}
                    >
                      <NavbarAvatar
                        avatarUrl={firstSuperAgent.avatarUrl}
                        initial={firstName!.charAt(0)}
                        imageStyle={styles.headerAvatar}
                      />
                      <View style={styles.agentInfo}>
                        <Text style={styles.fusedHeaderAgentName} numberOfLines={1}>{firstName}</Text>
                        {firstSuperAgent.role ? (
                          <Text style={styles.agentRole} numberOfLines={1}>{firstSuperAgent.role}</Text>
                        ) : null}
                      </View>
                      {extraCount > 0 && (
                        <Text style={styles.fusedHeaderExtra}>+{extraCount}</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.newConversationButton}
                      onPress={(e) => {
                        openWindow(
                          'chat',
                          {
                            agentId: firstSuperAgent.agentId,
                            agentName: firstSuperAgent.name,
                            workspaceId: activeWorkspaceId ?? undefined,
                          },
                          shouldOpenInNewTab(e),
                        );
                      }}
                    >
                      <Plus size={14} color={surface.dark.text} />
                    </TouchableOpacity>
                  </>
                )}
                {isMobile && (
                  <TouchableOpacity style={styles.closeButton} onPress={() => setMobileMenuOpen(false)}>
                    <X size={18} color={c.text3} />
                  </TouchableOpacity>
                )}
              </View>
            )}
            {/* Workspace Dropdown backdrop — rendered outside header so it covers the full screen */}
            {showWorkspaceDropdown && (
              <Pressable
                style={styles.workspaceDropdownBackdrop}
                onPress={() => setShowWorkspaceDropdown(false)}
              />
            )}
            {/* Workspace Dropdown — rendered outside sidebarHeader, positioned fixed in web */}
            {showWorkspaceDropdown && (
              <View style={[styles.workspaceDropdown, collapsed && styles.workspaceDropdownCollapsed, { top: dropdownTop }]}>
                {sortedWorkspaces.map(ws => {
                  // Mark as active if it matches activeWorkspaceId, or — when no workspace is
                  // selected yet — default-highlight the private workspace.
                  const isActive =
                    activeWorkspaceId !== null
                      ? ws.workspaceId === activeWorkspaceId
                      : ws.type === 'private';
                  return (
                  <TouchableOpacity
                    key={ws.workspaceId}
                    style={[styles.workspaceDropdownItem, isActive && styles.workspaceDropdownItemActive]}
                    onPress={() => {
                      setActiveWorkspace(ws.workspaceId);
                      setShowWorkspaceDropdown(false);
                    }}
                  >
                    {ws.type === 'private' ? (
                      <WorkspaceIcon icon="lock" color="amber" size={12} containerSize={20} />
                    ) : (
                      <WorkspaceIcon icon={ws.appearance?.icon} color={ws.appearance?.color} size={12} containerSize={20} />
                    )}
                    <Text style={styles.workspaceDropdownItemText}>{ws.name}</Text>
                    {isActive && (
                      <View style={styles.workspaceDropdownItemCheck} />
                    )}
                  </TouchableOpacity>
                  );
                })}
                <View style={styles.workspaceDropdownSeparator} />
                <TouchableOpacity
                  style={styles.workspaceDropdownItem}
                  onPress={() => {
                    setShowWorkspaceDropdown(false);
                    handleOpenWorkspacesList();
                  }}
                >
                  <Settings size={12} color={c.text3} />
                  <Text style={[styles.workspaceDropdownItemText, { color: c.text3 }]}>
                    {t("nav.manageWorkspaces")}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        );
      })()}

      {/* New Conversation Button - Only when collapsed */}
      {collapsed && (
        <View style={styles.newConversationButtonCollapsedContainer}>
          <TouchableOpacity style={styles.newConversationButton} onPress={handleNewConversation}>
            <Plus size={14} color={surface.dark.text} />
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.sidebarContentWrapper}>
        {/* Top gradient - shows when can scroll up */}
        {scrollState.canScrollUp && (
          <LinearGradient
            colors={[c.bgPage, 'transparent']}
            style={styles.scrollGradientTop}
            pointerEvents="none"
          />
        )}

        <ScrollView
          ref={scrollViewRef}
          style={styles.sidebarContent}
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          onContentSizeChange={handleContentSizeChange}
          scrollEventThrottle={16}
        >
          {/* Workspace Zone — selector + agents grouped with subtle background */}
          <View style={[styles.workspaceZone, collapsed && styles.workspaceZoneCollapsed]}>

            {/* Workspace Selector Section */}
            {(() => {
              const activeWs = workspaces.find((ws) => ws.workspaceId === activeWorkspaceId);
              return (
                <View
                  ref={workspaceSelectorRef}
                  style={[styles.section, styles.workspaceSelectorSection, !collapsed && styles.workspaceSelectorSectionRow]}
                >
                  {!collapsed ? (
                    <TouchableOpacity
                      style={[styles.workspaceSelector, showWorkspaceDropdown && { borderColor: 'rgba(139,92,246,0.3)' } as any]}
                      onPress={() => setShowWorkspaceDropdown(!showWorkspaceDropdown)}
                    >
                      {activeWs?.type === 'private' ? (
                        <WorkspaceIcon icon="lock" color="amber" size={13} containerSize={20} />
                      ) : (
                        <WorkspaceIcon icon={activeWs?.appearance?.icon} color={activeWs?.appearance?.color} size={13} />
                      )}
                      <Text style={styles.workspaceSelectorName} numberOfLines={1}>
                        {activeWs?.name ?? t("nav.workspace")}
                      </Text>
                      <ChevronDown size={11} color={c.text3} />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.navItem, styles.navItemCollapsed]}
                      onPress={() => setShowWorkspaceDropdown(!showWorkspaceDropdown)}
                    >
                      {activeWs?.type === 'private' ? (
                        <WorkspaceIcon icon="lock" color="amber" size={16} containerSize={24} />
                      ) : (
                        <WorkspaceIcon icon={activeWs?.appearance?.icon} color={activeWs?.appearance?.color} size={16} />
                      )}
                    </TouchableOpacity>
                  )}
                  {!collapsed && activeWorkspaceId && (
                    <TouchableOpacity
                      style={styles.workspaceSettingsBtn}
                      onPress={(e) => handleOpenWorkspaceWindow(activeWorkspaceId, e)}
                    >
                      <Settings size={12} color={c.text3} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })()}

            {/* Permission Indicator — global pending permissions badge */}
            <View style={styles.section}>
              <PermissionIndicator collapsed={!isExpanded} />
            </View>

            <View style={styles.workspaceZoneDivider} />

            {/* Agents Section */}
            <View style={styles.section}>
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <Users size={16} color={semanticColors.green} />
                {!collapsed && <Text style={styles.sectionTitle}>{t("nav.agents")}</Text>}
              </View>
              {!collapsed && (
                <TouchableOpacity
                  style={styles.sectionAdd}
                  onPress={(e) => {
                    setMobileMenuOpen(false);
                    openWindow('create-agent', { workspaceId: activeWorkspaceId }, shouldOpenInNewTab(e));
                  }}
                >
                  <ChevronRight size={14} color={semanticColors.green} />
                </TouchableOpacity>
              )}
            </View>

            {workspaceAgents.map((agent) => {
              const firstName = agent.name.split(' ')[0];
              return (
                <View
                  key={agent.agentId}
                  style={[styles.navItemRow, collapsed && styles.navItemRowCollapsed]}
                >
                  <TouchableOpacity
                    style={[
                      styles.navItem,
                      styles.navItemFlex,
                      collapsed && styles.navItemCollapsed,
                    ]}
                    onPress={(e) => handleOpenAgent(agent.agentId, e)}
                  >
                    <NavbarAvatar
                      avatarUrl={agent.avatarUrl}
                      initial={firstName.charAt(0)}
                      imageStyle={styles.avatar}
                    />
                    {!collapsed && (
                      <View style={styles.agentInfo}>
                        <Text style={styles.navItemText}>{firstName}</Text>
                        {agent.role ? (
                          <Text style={styles.agentRole} numberOfLines={1}>{agent.role}</Text>
                        ) : null}
                      </View>
                    )}
                  </TouchableOpacity>
                  {!collapsed && (
                    <TouchableOpacity
                      style={styles.newConversationButton}
                      onPress={(e) => {
                        setMobileMenuOpen(false);
                        openWindow(
                          'chat',
                          {
                            agentId: agent.agentId,
                            agentName: agent.name,
                            workspaceId: activeWorkspaceId ?? undefined,
                          },
                          shouldOpenInNewTab(e),
                        );
                      }}
                    >
                      <Plus size={14} color={surface.dark.text} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}

            {/* Add button - only when collapsed */}
            {collapsed && (
              <TouchableOpacity
                style={[styles.navItem, styles.navItemCollapsed]}
                onPress={() => {
                  setMobileMenuOpen(false);
                  openWindow('create-agent', { workspaceId: activeWorkspaceId });
                }}
              >
                <View style={styles.addIcon}>
                  <ChevronRight size={12} color={semanticColors.green} />
                </View>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.workspaceZoneDivider} />

          {/* Projects Section */}
          <View style={styles.section}>
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <FolderKanban size={16} color={semanticColors.amber} />
                {!collapsed && <Text style={styles.sectionTitle}>{t("nav.projects")}</Text>}
              </View>
              {!collapsed && (
                <TouchableOpacity
                  style={styles.sectionAdd}
                  onPress={() => {
                    setCreatingProject(true);
                    setNewProjectName('');
                  }}
                >
                  <ChevronRight size={14} color={semanticColors.amber} />
                </TouchableOpacity>
              )}
            </View>
            {/* Create project modal */}
            <Modal
              visible={creatingProject}
              transparent
              animationType="fade"
              onRequestClose={() => {
                setCreatingProject(false);
                setNewProjectName('');
                setNewProjectDescription('');
              }}
            >
              <Pressable
                style={styles.createProjectBackdrop}
                onPress={() => {
                  setCreatingProject(false);
                  setNewProjectName('');
                  setNewProjectDescription('');
                }}
              >
                <Pressable style={styles.createProjectCard} onPress={(e) => e.stopPropagation()}>
                  {/* Header */}
                  <View style={styles.createProjectHeader}>
                    <Text style={styles.createProjectTitle}>{t("nav.newProject")}</Text>
                    <TouchableOpacity
                      onPress={() => {
                        setCreatingProject(false);
                        setNewProjectName('');
                        setNewProjectDescription('');
                      }}
                      style={{ padding: 4 }}
                    >
                      <X size={18} color={c.text3} />
                    </TouchableOpacity>
                  </View>

                  {/* Nombre */}
                  <View style={styles.createProjectField}>
                    <Text style={styles.createProjectLabel}>
                      {t("nav.nameLabel")} <Text style={{ color: semanticColors.red }}>*</Text>
                    </Text>
                    <TextInput
                      autoFocus
                      style={[
                        styles.createProjectInput,
                        newProjectName.trim() && styles.createProjectInputActive,
                      ]}
                      placeholder={t("nav.projectNamePlaceholder")}
                      placeholderTextColor={c.text3}
                      value={newProjectName}
                      onChangeText={setNewProjectName}
                    />
                  </View>

                  {/* Descripción */}
                  <View style={styles.createProjectField}>
                    <Text style={styles.createProjectLabel}>{t("nav.descriptionLabel")}</Text>
                    <TextInput
                      style={[
                        styles.createProjectInput,
                        styles.createProjectTextarea,
                        newProjectDescription.trim() && styles.createProjectInputActive,
                      ]}
                      placeholder={t("nav.projectDescriptionPlaceholder")}
                      placeholderTextColor={c.text3}
                      value={newProjectDescription}
                      onChangeText={setNewProjectDescription}
                      multiline
                      numberOfLines={3}
                      textAlignVertical="top"
                    />
                  </View>

                  {/* Actions */}
                  <View style={styles.createProjectActions}>
                    <TouchableOpacity
                      style={styles.createProjectCancel}
                      onPress={() => {
                        setCreatingProject(false);
                        setNewProjectName('');
                        setNewProjectDescription('');
                      }}
                    >
                      <Text style={styles.createProjectCancelText}>{t("common.cancel")}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.createProjectConfirm,
                        !newProjectName.trim() && styles.createProjectConfirmDisabled,
                      ]}
                      disabled={!newProjectName.trim()}
                      onPress={async () => {
                        const name = newProjectName.trim();
                        const description = newProjectDescription.trim() || undefined;
                        if (!name) return;
                        try {
                          const client = getTerosClient();
                          const { project } = await client.board.createProject(
                            activeWorkspaceId!,
                            name,
                            description,
                          );
                          const newProject = { projectId: project.projectId, name: project.name };
                          // Idempotent: the WS event `project.created` may already have
                          // added this project via useNavbarRealtimeSync.
                          setProjects((prev) =>
                            prev.some((p) => p.projectId === newProject.projectId)
                              ? prev
                              : [...prev, newProject],
                          );
                          openWindow(
                            'project',
                            { projectId: newProject.projectId, projectName: newProject.name },
                            false,
                          );
                        } catch (err) {
                          console.warn('[Navbar] Failed to create project:', err);
                        } finally {
                          setCreatingProject(false);
                          setNewProjectName('');
                          setNewProjectDescription('');
                        }
                      }}
                    >
                      <Text
                        style={[
                          styles.createProjectConfirmText,
                          !newProjectName.trim() && styles.createProjectConfirmTextDisabled,
                        ]}
                      >
                        {t("nav.createProject")}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </Pressable>
              </Pressable>
            </Modal>
            {!creatingProject && projects.length === 0 && !collapsed && (
              <Text style={styles.emptyText}>{t("nav.noProjects")}</Text>
            )}
            {projects.map((project) => (
              <TouchableOpacity
                key={project.projectId}
                style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                onPress={(e) =>
                  openWindow(
                    'project',
                    { projectId: project.projectId, projectName: project.name },
                    shouldOpenInNewTab(e),
                  )
                }
              >
                <View style={[styles.appIcon, { backgroundColor: indicators.risk.bg }]}>
                  <FolderKanban size={14} color={semanticColors.amber} />
                </View>
                {!collapsed && (
                  <Text style={styles.navItemText} numberOfLines={1}>
                    {project.name}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.workspaceZoneDivider} />

          {/* Conversations Section */}
          <View
            style={styles.section}
            {...(Platform.OS === 'web' ? {
              onMouseEnter: () => setHoveredSection('conversations'),
              onMouseLeave: () => setHoveredSection(null),
            } : {})}
          >
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <MessageSquare size={16} color={semanticColors.indigo} />
                {!collapsed && <Text style={styles.sectionTitle}>{t("nav.conversations")}</Text>}
              </View>
              {!collapsed && (
                <TouchableOpacity
                  style={styles.sectionAdd}
                  onPress={(e) => {
                    setMobileMenuOpen(false);
                    openWindow('conversations', { workspaceId: activeWorkspaceId ?? undefined }, shouldOpenInNewTab(e));
                  }}
                >
                  <ChevronRight size={14} color={semanticColors.indigo} />
                </TouchableOpacity>
              )}
            </View>

            {recentConversations.map((conv) => (
              <TouchableOpacity
                key={conv.channelId}
                style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                onPress={(e) => handleOpenConversation(conv.channelId, e)}
              >
                {conv.agentAvatarUrl ? (
                  <Image source={{ uri: conv.agentAvatarUrl }} style={styles.avatar} />
                ) : (
                  <View style={styles.avatar}>
                    <Text style={styles.avatarTextGray}>
                      {(conv.agentName || conv.title || 'C').charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                {!collapsed && (
                  <View style={styles.conversationInfo}>
                    <Text style={styles.conversationTitle} numberOfLines={1}>
                      {conv.title || t("nav.newConversation")}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}

            {/* View more conversations button */}
            {!collapsed &&
              (totalActiveConvs > 10 || totalInactiveConvs > 0 || totalArchivedConvs > 0) && (
                <TouchableOpacity
                  style={styles.navItem}
                  onPress={() => {
                    setMobileMenuOpen(false);
                    if (totalActiveConvs > 10 || totalInactiveConvs > 0) {
                      openWindow('conversations', { workspaceId: activeWorkspaceId ?? undefined });
                    } else {
                      openWindow('archived-conversations', { workspaceId: activeWorkspaceId ?? undefined });
                    }
                  }}
                >
                  <Text style={styles.moreText}>
                    {totalActiveConvs > 10
                      ? t("nav.moreConversations", { count: totalActiveConvs - 10 })
                      : totalInactiveConvs > 0
                        ? t("nav.inactiveConversations", { count: totalInactiveConvs })
                        : t("nav.viewArchived")}
                  </Text>
                </TouchableOpacity>
              )}
          </View>

          <View style={styles.workspaceZoneDivider} />

          {/* Apps Section */}
          <View style={styles.section}>
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <Grid size={16} color={semanticColors.violet} />
                {!collapsed && <Text style={styles.sectionTitle}>{t("nav.apps")}</Text>}
              </View>
            </View>

            {/* Mis Apps Button */}
            <TouchableOpacity
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenApps(e)}
            >
              <View style={styles.appIcon}>
                <Package size={14} color={c.text2} />
              </View>
              {!collapsed && <Text style={styles.navItemText}>{t("nav.apps")}</Text>}
            </TouchableOpacity>

            {/* Catalog Button */}
            <TouchableOpacity
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenCatalog(e)}
            >
              <View style={styles.appIcon}>
                <Store size={14} color={c.text2} />
              </View>
              {!collapsed && <Text style={styles.navItemText}>{t("nav.catalog")}</Text>}
            </TouchableOpacity>

            {/* Skills Button */}
            <TouchableOpacity
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenSkills(e)}
            >
              <View style={styles.appIcon}>
                <BookOpen size={14} color={c.text2} />
              </View>
              {!collapsed && <Text style={styles.navItemText}>{t("nav.skills")}</Text>}
            </TouchableOpacity>

          </View>

          </View>{/* end workspaceZone */}

          <View style={styles.divider} />

          {/* Account Section — Profile + Providers */}
          <View style={styles.section}>
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <User size={16} color={c.text2} />
                {!collapsed && <Text style={styles.sectionTitle}>{t("nav.account")}</Text>}
              </View>
            </View>

            <TouchableOpacity
              testID="nav-profile"
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenProfile(e)}
            >
              <View style={styles.appIcon}>
                <UserCircle size={14} color={c.text2} />
              </View>
              {!collapsed && <Text style={styles.navItemText}>{t("nav.profile")}</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenProviders(e)}
            >
              <View style={styles.appIcon}>
                <Cloud size={14} color={c.text2} />
              </View>
              {!collapsed && <Text style={styles.navItemText}>{t("nav.providers")}</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              testID="nav-whats-new"
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={() => onWhatsNew?.()}
            >
              <View style={styles.appIcon}>
                <Sparkles size={14} color={c.text2} />
              </View>
              {!collapsed && <Text style={styles.navItemText}>{t('nav.whatsNew')}</Text>}
            </TouchableOpacity>
          </View>

          {/* Admin Section */}
          {isAdmin && (
            <>
              <View style={styles.divider} />
              <View style={styles.section}>
                <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
                  <View style={styles.sectionHeaderLeft}>
                    <Settings size={16} color={semanticColors.red} />
                    {!collapsed && <Text style={styles.sectionTitle}>{t("nav.admin")}</Text>}
                  </View>
                </View>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenAgentCores(e)}
                >
                  <View style={styles.appIcon}>
                    <Cpu size={14} color={c.text2} />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>{t("nav.agentCores")}</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenMcas(e)}
                >
                  <View style={styles.appIcon}>
                    <Package size={14} color={c.text2} />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>{t("nav.mcas")}</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  testID="nav-users"
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenUsers(e)}
                >
                  <View style={styles.appIcon}>
                    <Users size={14} color={c.text2} />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>{t("nav.users")}</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenMonitoring(e)}
                >
                  <View style={styles.appIcon}>
                    <Gauge size={14} color={semanticColors.indigo} />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>Monitoring</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenLatitudeSignals(e)}
                >
                  <View style={styles.appIcon}>
                    <Zap size={14} color="#F59E0B" />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>Latitude Signals</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenFeatureFlags(e)}
                >
                  <View style={styles.appIcon}>
                    <Flag size={14} color={semanticColors.amber} />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>{t("nav.featureFlags")}</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  testID="nav-billing-requests"
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenBillingRequests(e)}
                >
                  <View style={styles.appIcon}>
                    <CreditCard size={14} color={semanticColors.indigo} />
                  </View>
                  {!collapsed && (
                    <Text style={styles.navItemText}>{t("nav.billingRequests")}</Text>
                  )}
                  {pendingBillingRequests > 0 && (
                    <View style={styles.navBadge}>
                      <Text style={styles.navBadgeText}>
                        {pendingBillingRequests > 99 ? '99+' : pendingBillingRequests}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  testID="nav-billing-teams"
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenBillingTeams(e)}
                >
                  <View style={styles.appIcon}>
                    <Building2 size={14} color={semanticColors.indigo} />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>{t("nav.billingTeams")}</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
        </ScrollView>

        {/* Bottom gradient - shows when can scroll down */}
        {scrollState.canScrollDown && (
          <LinearGradient
            colors={['transparent', c.bgPage]}
            style={styles.scrollGradientBottom}
            pointerEvents="none"
          />
        )}
      </View>

      {/* Footer — Getting Started widget + collapse button + DesktopIndicator */}
      <View style={[styles.sidebarFooter, collapsed && styles.sidebarFooterCollapsed]}>
        {collapsed ? (
          <>
            {/* <GettingStartedWidget onOpenWindow={() => setMobileMenuOpen(false)} /> */}

            <DesktopIndicator collapsed />

            <ThemeToggleButton collapsed />

            {!isMobile && (
              <TouchableOpacity
                style={styles.collapseButton}
                onPress={() => setExpanded(!isExpanded)}
              >
                <PanelLeft size={14} color={c.text3} />
              </TouchableOpacity>
            )}
          </>
        ) : (
          <>
            {!isMobile && (
              <TouchableOpacity
                style={styles.collapseButton}
                onPress={() => setExpanded(!isExpanded)}
              >
                <PanelLeftClose size={14} color={c.text3} />
              </TouchableOpacity>
            )}

            {/* <GettingStartedWidget onOpenWindow={() => setMobileMenuOpen(false)} /> */}

            <DesktopIndicator />

            <ThemeToggleButton />
          </>
        )}
      </View>
    </>
  );

  return (
    <View style={styles.container}>
      {/* Desktop Sidebar */}
      {!isMobile && (
        <View
          style={[
            styles.sidebar,
            { width: sidebarWidth, paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
        >
          {renderSidebarContent(!isExpanded)}
        </View>
      )}

      {/* Main Content Area */}
      <View style={styles.mainContent}>
        <View style={[styles.pageContent, !isMobile && { paddingTop: insets.top }]}>
          {children}
        </View>
      </View>

      {/* Mobile Sidebar Modal */}
      {isMobile && (
        <Modal
          visible={isMobileMenuOpen}
          transparent
          animationType="none"
          onRequestClose={() => setMobileMenuOpen(false)}
        >
          <View style={styles.modalOverlay}>
            <TouchableOpacity
              style={styles.modalBackdrop}
              onPress={() => setMobileMenuOpen(false)}
              activeOpacity={1}
            />
            <View
              style={[
                styles.mobileSidebar,
                { paddingTop: insets.top, paddingBottom: insets.bottom },
              ]}
            >
              {renderSidebarContent(false)}
            </View>
          </View>
        </Modal>
      )}

      {/* New Conversation Modal */}
      <NewConversationModal
        visible={showNewConversationModal}
        onClose={() => setShowNewConversationModal(false)}
        onSelectAgent={handleSelectAgentForConversation}
      />
    </View>
  );
}

const buildStyles = (c: ReturnType<typeof useColors>) => {
  const isDark = c.bgPage === surface.dark.bgPage;
  return StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    ...(Platform.OS === 'web' && {
      display: 'flex' as any,
    }),
  },

  // Sidebar
  sidebar: {
    backgroundColor: c.bgPage,
    borderRightWidth: 1,
    borderRightColor: c.bgCardHover,
    ...(Platform.OS === 'web' && {
      overflow: 'visible' as any,
    }),
  },
  // Fused header pill (expanded)
  fusedHeaderPill: {
    backgroundColor: c.bgCard,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 8,
    marginVertical: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap: 8,
  },
  fusedHeaderSeparator: {
    width: 1,
    height: 20,
    backgroundColor: c.borderStrong,
    marginHorizontal: 4,
  },
  fusedHeaderAgent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  fusedHeaderAgentName: {
    color: c.text2,
    fontSize: 12,
    fontWeight: "400",
  },
  fusedHeaderExtra: {
    color: c.text3,
    fontSize: 10,
    fontWeight: "400",
  },
  // Collapsed header stack
  sidebarHeaderCollapsedStack: {
    alignItems: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  collapsedLogoBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  collapsedSuperAgentBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  headerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: c.bgCardHover,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.bgCardHover,
    gap: 10,
  },
  sidebarHeaderCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
  },
  sidebarTitle: {
    color: c.text2,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.5,
    flex: 1,
  },
  sidebarContentWrapper: {
    flex: 1,
    position: 'relative',
  },
  sidebarContent: {
    flex: 1,
  },
  scrollGradientTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 24,
    zIndex: 10,
  },
  scrollGradientBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 24,
    zIndex: 10,
  },
  sidebarFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: c.bgCardHover,
    gap: 8,
    ...(Platform.OS === 'web' && {
      overflow: 'visible' as any,
    }),
  },
  sidebarFooterCollapsed: {
    flexDirection: 'column',
    justifyContent: 'center',
    paddingHorizontal: 8,
    gap: 10,
  },
  collapseButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Sections
  section: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  workspaceSelectorSection: {
    paddingVertical: 2,
  },
  workspaceSelectorSectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  workspaceSettingsBtn: {
    width: 22,
    height: 22,
    borderRadius: 5,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  workspaceZone: {
    marginHorizontal: 6,
    marginVertical: 4,
    backgroundColor: c.bgCard,
    borderRadius: 8,
    paddingVertical: 4,
  },
  workspaceZoneCollapsed: {
    marginHorizontal: 4,
  },
  workspaceZoneDivider: {
    height: 1,
    backgroundColor: c.bgInner,
    marginHorizontal: 8,
    marginVertical: 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 2,
  },
  sectionHeaderCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    color: c.text3,
    fontSize: 11,
    fontWeight: "400",
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionAdd: {
    width: 18,
    height: 18,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionAddButton: {
    width: 22,
    height: 22,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.bgCardHover,
  },
  divider: {
    height: 1,
    backgroundColor: c.bgCardHover,
    marginHorizontal: 12,
    marginVertical: 8,
  },
  // Workspace Selector (header dropdown)
  workspaceSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: c.bgInner,
    borderWidth: 1,
    borderColor: c.border,
  },
  workspaceSelectorName: {
    color: c.text2,
    fontSize: 12,
    fontWeight: "400",
    flex: 1,
  },
  workspaceDropdownBackdrop: {
    position: 'fixed' as any,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Must sit above all sidebar content (scroll gradients use zIndex 10,
    // floating windows start at 100) but below the dropdown itself.
    zIndex: 19998,
  },
  workspaceDropdown: {
    position: 'absolute',
    top: 48,
    left: 8,
    right: 8,
    backgroundColor: c.bgCard,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 8,
    // High enough to float above all sidebar sections and floating windows.
    zIndex: 19999,
    elevation: 8,
    shadowColor: isDark ? surface.dark.bgPage : surface.light.bgPage,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    ...(Platform.OS === 'web' && {
      position: 'fixed' as any,
      // top is set dynamically via style prop — see render
      left: 14,
      width: EXPANDED_WIDTH - 28,
      right: undefined,
      // Frosted glass — blur only, no background color
      backdropFilter: 'blur(12px)' as any,
      WebkitBackdropFilter: 'blur(12px)' as any,
      backgroundColor: 'transparent' as any,
    }),
  },
  workspaceDropdownCollapsed: {
    ...(Platform.OS === 'web' && {
      left: COLLAPSED_WIDTH + 8,
    }),
  },
  workspaceDropdownSeparator: {
    height: 1,
    backgroundColor: c.bgCardHover,
    marginVertical: 4,
  },
  workspaceDropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  workspaceDropdownItemActive: {
    backgroundColor: semanticColors.indigoGlow,
  },
  workspaceDropdownItemText: {
    color: c.text2,
    fontSize: 13,
    flex: 1,
  },
  workspaceDropdownItemCheck: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: semanticColors.indigo,
  },

  newConversationButton: {
    width: 22,
    height: 22,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: semanticColors.indigo,
  },
  newConversationButtonCollapsedContainer: {
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 4,
  },

  // Nav Items
  navItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
    gap: 6,
  },
  navItemRowCollapsed: {
    paddingRight: 0,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    marginVertical: 1,
    gap: 10,
  },
  navItemFlex: {
    flex: 1,
  },
  navItemCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
    marginHorizontal: 8,
  },
  navItemText: {
    color: c.text2,
    fontSize: 13,
    fontWeight: '400',
    flex: 1,
  },
  navBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: semanticColors.indigo,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBadgeText: {
    color: surface.dark.text,
    fontSize: 10,
    fontWeight: '700',
  },
  agentInfo: {
    flex: 1,
    gap: 1,
  },
  agentRole: {
    color: c.text3,
    fontSize: 10,
    fontWeight: '400',
  },
  conversationInfo: {
    flex: 1,
    gap: 2,
  },
  conversationTitle: {
    color: c.text2,
    fontSize: 13,
    fontWeight: "400",
  },
  workspaceLabel: {
    color: c.text3,
    fontSize: 10,
    fontWeight: '400',
  },
  moreText: {
    color: c.text3,
    fontSize: 12,
    paddingLeft: 34,
  },
  emptyText: {
    fontSize: 11,
    color: c.text3,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  inlineInput: {
    fontSize: 12,
    color: c.text,
    backgroundColor: c.bgCardHover,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginHorizontal: 8,
    marginBottom: 4,
    outlineStyle: 'none',
  } as any,

  // Avatars
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: c.bgCardHover,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarCyan: {
    backgroundColor: semanticColors.indigoGlow,
  },
  avatarText: {
    color: semanticColors.indigo,
    fontSize: 11,
    fontWeight: "400",
  },
  avatarTextGray: {
    color: c.text3,
    fontSize: 11,
    fontWeight: "400",
  },
  addIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  appIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: c.bgCardHover,
    justifyContent: 'center',
    alignItems: 'center',
  },
  appIconImage: {
    width: 16,
    height: 16,
    resizeMode: 'contain',
  },

  // Main Content
  mainContent: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  pageContent: {
    flex: 1,
  },

  // Shared
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userAvatar: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: c.bgCardHover,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userInitial: {
    color: c.text2,
    fontSize: 11,
    fontWeight: "400",
  },
  userDropdownContainer: {
    position: 'relative',
    zIndex: 10000,
    ...(Platform.OS === 'web' && {
      overflow: 'visible' as any,
    }),
  },

  // Dropdown
  dropdown: {
    position: 'absolute',
    minWidth: 160,
    backgroundColor: c.bgCard,
    borderWidth: 1,
    borderColor: c.bgCardHover,
    borderRadius: 8,
    zIndex: 9999,
    elevation: 8,
    shadowColor: isDark ? surface.dark.bgPage : surface.light.bgPage,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  dropdownBottom: {
    bottom: 36,
    left: 0,
  },
  dropdownHeader: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dropdownUserName: {
    color: c.text,
    fontSize: 13,
    fontWeight: "400",
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: c.bgCardHover,
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  logoutText: {
    color: semanticColors.red,
    fontSize: 13,
    fontWeight: "400",
  },

  // Mobile Modal
  modalOverlay: {
    flex: 1,
    flexDirection: 'row',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: isDark ? surface.dark.bgInner : surface.light.bgInner,
  },
  mobileSidebar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: EXPANDED_WIDTH,
    backgroundColor: c.bgPage,
    borderRightWidth: 1,
    borderRightColor: c.bgCardHover,
  },

  // Create project modal
  createProjectBackdrop: {
    flex: 1,
    backgroundColor: isDark ? surface.dark.bgInner : surface.light.bgInner,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createProjectCard: {
    backgroundColor: c.bgCard,
    borderRadius: 12,
    padding: 24,
    width: 400,
    maxWidth: '90%',
    borderWidth: 1,
    borderColor: controlsBar.permission.modalBorder,
    shadowColor: isDark ? surface.dark.bgPage : surface.light.bgPage,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
  },
  createProjectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  createProjectTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.text,
  },
  createProjectField: {
    marginBottom: 16,
    gap: 6,
  },
  createProjectLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.text3,
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  createProjectInput: {
    backgroundColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: c.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: c.borderStrong,
    outlineStyle: 'none',
  } as any,
  createProjectInputActive: {
    borderColor: controlsBar.permission.modalBorder,
  },
  createProjectTextarea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  createProjectActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 8,
  },
  createProjectCancel: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: c.border,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  createProjectCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text2,
  },
  createProjectConfirm: {
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: semanticColors.violet,
  },
  createProjectConfirmDisabled: {
    backgroundColor: semanticColors.violetGlow,
  },
  createProjectConfirmText: {
    fontSize: 13,
    fontWeight: '600',
    color: 'white',
  },
  createProjectConfirmTextDisabled: {
    color: c.text3,
  },
  themeToggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.bgInner,
  },
  themeToggleButtonCollapsed: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
});
};


// Hook: memoized styles that adapt to theme
function useNavbarStyles() {
  const c = useColors();
  return useMemo(() => buildStyles(c), [c]);
}
// ========================================
// THEME TOGGLE BUTTON
// ========================================

function ThemeToggleButton({ collapsed = false }: { collapsed?: boolean }) {
  const c = useColors();
  const styles = useNavbarStyles();
  const theme = useUiPreferencesStore((s) => s.theme);
  const toggleTheme = useUiPreferencesStore((s) => s.toggleTheme);
  const isDark = theme === 'dark';

  return (
    <TouchableOpacity
      style={[
        styles.themeToggleButton,
        collapsed && styles.themeToggleButtonCollapsed,
      ]}
      onPress={toggleTheme}
      activeOpacity={0.7}
      accessibilityLabel={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {isDark ? (
        <Sun size={collapsed ? 16 : 14} color={c.text3} />
      ) : (
        <Moon size={collapsed ? 16 : 14} color={c.text3} />
      )}
    </TouchableOpacity>
  );
}
