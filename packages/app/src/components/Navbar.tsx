import {
  BarChart3,
  Box,
  Cloud,
  Cpu,
  Folder,
  Gift,
  Grid,
  MessageSquare,
  Package,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings,
  Store,
  UserPlus,
  Users,
  X,
} from '@tamagui/lucide-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTerosClient } from '../../app/_layout';
import { useClickModifiers } from '../hooks/useClickModifiers';
import { useInvitations } from '../hooks/useInvitations';
import { useNavbarStore } from '../store/navbarStore';
import { useTilingStore } from '../store/tilingStore';
import { AgentAvatarStack } from './AgentAvatarStack';
import { DesktopIndicator } from './DesktopIndicator';
import { NewConversationModal } from './NewConversationModal';
import { TerosLogo } from './TerosLogo';
import { WorkspaceIcon } from './WorkspaceIcon';

// Breakpoints
const MOBILE_BREAKPOINT = 768;
const COLLAPSED_WIDTH = 56;
const EXPANDED_WIDTH = 260;

interface NavbarProps {
  userName?: string;
  userRole?: string;
  onLogout?: () => void;
  children?: React.ReactNode;
}

export function Navbar({ userName = 'User', userRole = 'user', onLogout, children }: NavbarProps) {
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
  const { shouldOpenInNewTab } = useClickModifiers();

  // Recent conversations state (loaded from backend)
  const [recentConversations, setRecentConversations] = useState<
    Array<{
      channelId: string;
      title: string;
      agentId?: string;
      agentName?: string;
      agentAvatarUrl?: string;
      workspaceName?: string;
      lastMessageAt?: string;
    }>
  >([]);
  const [totalActiveConvs, setTotalActiveConvs] = useState(0);
  const [totalInactiveConvs, setTotalInactiveConvs] = useState(0);
  const [totalArchivedConvs, setTotalArchivedConvs] = useState(0);

  // State for modals
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);

  // Invitations hook
  const { status: invitationStatus } = useInvitations(client);
  const availableInvitations = invitationStatus?.availableInvitations ?? 0;

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
    if (scrollViewRef.current) {
      scrollViewRef.current.measure((x, y, width, height) => {
        const canScrollDown = contentHeight > height;
        setScrollState((prev) => ({ ...prev, canScrollDown }));
      });
    }
  }, []);

  // Sort apps alphabetically
  const sortedApps = useMemo(() => [...apps].sort((a, b) => a.name.localeCompare(b.name)), [apps]);

  // Sort workspaces alphabetically
  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => a.name.localeCompare(b.name)),
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

        // Load apps
        const userApps = (await client.app.listApps()).apps;
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
        const userWorkspaces = await client.listWorkspaces();
        if (mounted) {
          setWorkspaces(
            userWorkspaces.map((ws: any) => ({
              workspaceId: ws.workspaceId,
              name: ws.name,
              role: ws.role,
              volumeId: ws.volumeId,
              appearance: ws.appearance,
            })),
          );
        }

        // Load agents from each workspace (in parallel)
        const workspaceAgentsPromises = userWorkspaces.map((ws: any) =>
          client.agent.listAgents(ws.workspaceId).then((r) => r.agents).catch(() => []),
        );
        const workspaceAgentsResults = await Promise.all(workspaceAgentsPromises);

        // Combine global and workspace agents
        if (mounted) {
          const allAgents = [
            ...globalAgents.map((a) => ({
              agentId: a.agentId,
              name: a.fullName || a.name,
              avatarUrl: a.avatarUrl,
              coreId: a.coreId,
              workspaceId: a.workspaceId,
            })),
            ...workspaceAgentsResults.flat().map((a: any) => ({
              agentId: a.agentId,
              name: a.fullName || a.name,
              avatarUrl: a.avatarUrl,
              coreId: a.coreId,
              workspaceId: a.workspaceId,
            })),
          ];
          setAgents(allAgents);
        }

        // Load recent conversations
        const { channels } = await client.channel.list();
        if (mounted) {
          const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;

          // Filter and categorize
          const archivedChannels = channels.filter((ch: any) => ch.status === 'closed');
          const nonClosedChannels = channels.filter((ch: any) => ch.status !== 'closed');
          const activeChannels = nonClosedChannels.filter((ch: any) => {
            const lastActivity = ch.lastMessage?.timestamp || ch.updatedAt;
            return lastActivity && new Date(lastActivity).getTime() >= threeHoursAgo;
          });
          const inactiveChannels = nonClosedChannels.filter((ch: any) => {
            const lastActivity = ch.lastMessage?.timestamp || ch.updatedAt;
            return !lastActivity || new Date(lastActivity).getTime() < threeHoursAgo;
          });

          setTotalActiveConvs(activeChannels.length);
          setTotalInactiveConvs(inactiveChannels.length);
          setTotalArchivedConvs(archivedChannels.length);

          // Get top 5 most recent (active first, then inactive)
          const sortedChannels = [...activeChannels, ...inactiveChannels]
            .sort((a: any, b: any) => {
              const dateA = a.lastMessage?.timestamp || a.updatedAt || 0;
              const dateB = b.lastMessage?.timestamp || b.updatedAt || 0;
              return new Date(dateB).getTime() - new Date(dateA).getTime();
            })
            .slice(0, 10);

          const allAgentsList = [...globalAgents, ...workspaceAgentsResults.flat()];
          setRecentConversations(
            sortedChannels.map((ch: any) => {
              const agent = allAgentsList.find((a: any) => a.agentId === ch.agentId);
              const workspace = agent?.workspaceId
                ? userWorkspaces.find((ws: any) => ws.workspaceId === agent.workspaceId)
                : null;
              return {
                channelId: ch.channelId,
                title: ch.metadata?.name || 'Chat',
                agentId: ch.agentId,
                agentName: agent?.name || agent?.fullName,
                agentAvatarUrl: agent?.avatarUrl,
                workspaceName: workspace?.name,
                lastMessageAt: ch.lastMessage?.timestamp || ch.updatedAt,
              };
            }),
          );
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
  }, [isLoaded]);

  // Close mobile menu when switching to desktop
  useEffect(() => {
    if (!isMobile && isMobileMenuOpen) {
      setMobileMenuOpen(false);
    }
  }, [isMobile]);

  const sidebarWidth = isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;

  // Handlers
  const handleOpenAgent = (agentId: string, workspaceId?: string, e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('agent', { agentId, workspaceId }, inNewTab);
  };

  const handleOpenConversation = (channelId: string, e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('chat', { channelId }, inNewTab);
  };

  const handleOpenApps = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('apps', {}, inNewTab);
  };

  const handleOpenCatalog = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('catalog', {}, inNewTab);
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

  const handleOpenUsage = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('usage', {}, inNewTab);
  };

  const handleOpenInvitations = (e?: any) => {
    setMobileMenuOpen(false);
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('invitations', {}, inNewTab);
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
    const inNewTab = e && shouldOpenInNewTab(e);
    openWindow('workspace', { workspaceId }, inNewTab);
  };

  // Render sidebar content
  const renderSidebarContent = (collapsed: boolean) => (
    <>
      {/* Header */}
      <View style={[styles.sidebarHeader, collapsed && styles.sidebarHeaderCollapsed]}>
        <TouchableOpacity onPress={() => router.push('/' as any)}>
          <TerosLogo size={20} color="#06B6D4" />
        </TouchableOpacity>
        {!collapsed && <Text style={styles.sidebarTitle}>TEROS</Text>}
        {isMobile && (
          <TouchableOpacity style={styles.closeButton} onPress={() => setMobileMenuOpen(false)}>
            <X size={18} color="#71717A" />
          </TouchableOpacity>
        )}
      </View>

      {/* New Conversation Button - Only when collapsed */}
      {collapsed && (
        <View style={styles.newConversationButtonCollapsedContainer}>
          <TouchableOpacity style={styles.newConversationButton} onPress={handleNewConversation}>
            <Plus size={14} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.sidebarContentWrapper}>
        {/* Top gradient - shows when can scroll up */}
        {scrollState.canScrollUp && (
          <LinearGradient
            colors={['rgba(10, 10, 10, 1)', 'rgba(10, 10, 10, 0)']}
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
          {/* Agents Section */}
          <View style={styles.section}>
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <Users size={16} color="#4A9E5B" />
                {!collapsed && <Text style={styles.sectionTitle}>Agentes</Text>}
              </View>
              {!collapsed && (
                <TouchableOpacity
                  style={styles.sectionAdd}
                  onPress={(e) => {
                    setMobileMenuOpen(false);
                    openWindow('create-agent', {}, shouldOpenInNewTab(e));
                  }}
                >
                  <Plus size={14} color="#4A9E5B" />
                </TouchableOpacity>
              )}
            </View>

            {agents
              .filter((a) => !a.workspaceId)
              .map((agent) => {
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
                      onPress={(e) => handleOpenAgent(agent.agentId, agent.workspaceId, e)}
                    >
                      {agent.avatarUrl ? (
                        <Image source={{ uri: agent.avatarUrl }} style={styles.avatar} />
                      ) : (
                        <View style={[styles.avatar, styles.avatarCyan]}>
                          <Text style={styles.avatarText}>{firstName.charAt(0)}</Text>
                        </View>
                      )}
                      {!collapsed && <Text style={styles.navItemText}>{firstName}</Text>}
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
                            },
                            shouldOpenInNewTab(e),
                          );
                        }}
                      >
                        <Plus size={14} color="#fff" />
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
                  openWindow('create-agent', {});
                }}
              >
                <View style={styles.addIcon}>
                  <Plus size={12} color="#4A9E5B" />
                </View>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.divider} />

          {/* Workspaces Section */}
          <View style={styles.section}>
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <Folder size={16} color="#C4923B" />
                {!collapsed && <Text style={styles.sectionTitle}>Workspaces</Text>}
              </View>
              {!collapsed && (
                <TouchableOpacity
                  style={styles.sectionAdd}
                  onPress={(e) => handleOpenWorkspacesList(e)}
                >
                  <Plus size={14} color="#C4923B" />
                </TouchableOpacity>
              )}
            </View>

            {sortedWorkspaces.slice(0, 5).map((workspace) => {
              const workspaceAgents = agents.filter((a) => a.workspaceId === workspace.workspaceId);
              return (
                <TouchableOpacity
                  key={workspace.workspaceId}
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenWorkspace(workspace.workspaceId, e)}
                >
                  <WorkspaceIcon
                    icon={workspace.appearance?.icon}
                    color={workspace.appearance?.color}
                  />
                  {!collapsed && (
                    <>
                      <Text style={styles.navItemText} numberOfLines={1}>
                        {workspace.name}
                      </Text>
                      {workspaceAgents.length > 0 && (
                        <AgentAvatarStack agents={workspaceAgents} maxVisible={3} size={18} />
                      )}
                    </>
                  )}
                </TouchableOpacity>
              );
            })}

            {sortedWorkspaces.length > 5 && !collapsed && (
              <TouchableOpacity style={styles.navItem} onPress={(e) => handleOpenWorkspacesList(e)}>
                <Text style={styles.moreText}>+{sortedWorkspaces.length - 5} more</Text>
              </TouchableOpacity>
            )}

            {/* Add button - only when collapsed */}
            {collapsed && (
              <TouchableOpacity
                style={[styles.navItem, styles.navItemCollapsed]}
                onPress={(e) => handleOpenWorkspacesList(e)}
              >
                <View style={styles.addIcon}>
                  <Plus size={12} color="#C4923B" />
                </View>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.divider} />

          {/* Conversations Section */}
          <View
            style={styles.section}
            onMouseEnter={() => setHoveredSection('conversations')}
            onMouseLeave={() => setHoveredSection(null)}
          >
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <MessageSquare size={16} color="#4A9BA8" />
                {!collapsed && <Text style={styles.sectionTitle}>Conversations</Text>}
              </View>
              {!collapsed && (
                <TouchableOpacity
                  style={styles.sectionAdd}
                  onPress={(e) => {
                    setMobileMenuOpen(false);
                    openWindow('conversations', {}, shouldOpenInNewTab(e));
                  }}
                >
                  <Plus size={14} color="#4A9BA8" />
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
                      {conv.title || 'New conversation'}
                    </Text>
                    {conv.workspaceName && (
                      <Text style={styles.workspaceLabel} numberOfLines={1}>
                        {conv.workspaceName}
                      </Text>
                    )}
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
                      openWindow('conversations', {});
                    } else {
                      openWindow('archived-conversations', {});
                    }
                  }}
                >
                  <Text style={styles.moreText}>
                    {totalActiveConvs > 10
                      ? `+${totalActiveConvs - 10} more...`
                      : totalInactiveConvs > 0
                        ? `+${totalInactiveConvs} inactivas...`
                        : 'Ver archivadas'}
                  </Text>
                </TouchableOpacity>
              )}
          </View>

          <View style={styles.divider} />

          {/* Apps Section */}
          <View style={styles.section}>
            <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
              <View style={styles.sectionHeaderLeft}>
                <Grid size={16} color="#7A54A6" />
                {!collapsed && <Text style={styles.sectionTitle}>Apps</Text>}
              </View>
            </View>

            {/* Mis Apps Button */}
            <TouchableOpacity
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenApps(e)}
            >
              <View style={styles.appIcon}>
                <Package size={14} color="#a1a1aa" />
              </View>
              {!collapsed && <Text style={styles.navItemText}>Mis Apps</Text>}
            </TouchableOpacity>

            {/* Catalog Button */}
            <TouchableOpacity
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenCatalog(e)}
            >
              <View style={styles.appIcon}>
                <Store size={14} color="#a1a1aa" />
              </View>
              {!collapsed && <Text style={styles.navItemText}>Catalog</Text>}
            </TouchableOpacity>

            {/* Mis Providers Button */}
            <TouchableOpacity
              style={[styles.navItem, collapsed && styles.navItemCollapsed]}
              onPress={(e) => handleOpenProviders(e)}
            >
              <View style={styles.appIcon}>
                <Cloud size={14} color="#a1a1aa" />
              </View>
              {!collapsed && <Text style={styles.navItemText}>Mis Providers</Text>}
            </TouchableOpacity>
          </View>

          {/* Admin Section */}
          {isAdmin && (
            <>
              <View style={styles.divider} />
              <View style={styles.section}>
                <View style={[styles.sectionHeader, collapsed && styles.sectionHeaderCollapsed]}>
                  <View style={styles.sectionHeaderLeft}>
                    <Settings size={16} color="#C75450" />
                    {!collapsed && <Text style={styles.sectionTitle}>Admin</Text>}
                  </View>
                </View>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenAgentCores(e)}
                >
                  <View style={styles.appIcon}>
                    <Cpu size={14} color="#a1a1aa" />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>Agent Cores</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenMcas(e)}
                >
                  <View style={styles.appIcon}>
                    <Package size={14} color="#a1a1aa" />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>MCAs</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenUsers(e)}
                >
                  <View style={styles.appIcon}>
                    <Users size={14} color="#a1a1aa" />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>Users</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.navItem, collapsed && styles.navItemCollapsed]}
                  onPress={(e) => handleOpenUsage(e)}
                >
                  <View style={styles.appIcon}>
                    <BarChart3 size={14} color="#22C55E" />
                  </View>
                  {!collapsed && <Text style={styles.navItemText}>Usage & Costs</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
        </ScrollView>

        {/* Bottom gradient - shows when can scroll down */}
        {scrollState.canScrollDown && (
          <LinearGradient
            colors={['rgba(10, 10, 10, 0)', 'rgba(10, 10, 10, 1)']}
            style={styles.scrollGradientBottom}
            pointerEvents="none"
          />
        )}
      </View>

      {/* Footer */}
      <View style={[styles.sidebarFooter, collapsed && styles.sidebarFooterCollapsed]}>
        {/* When collapsed: profile first (top), then collapse button (bottom) */}
        {collapsed ? (
          <>
            <TouchableOpacity style={styles.userAvatar} onPress={(e) => handleOpenProfile(e)}>
              <Text style={styles.userInitial}>{userName.charAt(0).toUpperCase()}</Text>
            </TouchableOpacity>

            <DesktopIndicator collapsed />

            <TouchableOpacity
              style={[
                styles.invitationsButton,
                availableInvitations === 0 && styles.invitationsButtonDisabled,
              ]}
              onPress={handleOpenInvitations}
            >
              <Gift size={14} color={availableInvitations > 0 ? '#06B6D4' : '#52525B'} />
              {availableInvitations > 0 && (
                <View style={styles.invitationsBadge}>
                  <Text style={styles.invitationsBadgeText}>{availableInvitations}</Text>
                </View>
              )}
            </TouchableOpacity>

            {!isMobile && (
              <TouchableOpacity
                style={styles.collapseButton}
                onPress={() => setExpanded(!isExpanded)}
              >
                <PanelLeft size={14} color="#52525b" />
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
                <PanelLeftClose size={14} color="#52525b" />
              </TouchableOpacity>
            )}

            <View style={{ flex: 1 }} />

            <DesktopIndicator />

            <TouchableOpacity
              style={[
                styles.invitationsButton,
                availableInvitations === 0 && styles.invitationsButtonDisabled,
              ]}
              onPress={handleOpenInvitations}
            >
              <Gift size={14} color={availableInvitations > 0 ? '#06B6D4' : '#52525B'} />
              {availableInvitations > 0 && (
                <View style={styles.invitationsBadge}>
                  <Text style={styles.invitationsBadgeText}>{availableInvitations}</Text>
                </View>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.userAvatar} onPress={(e) => handleOpenProfile(e)}>
              <Text style={styles.userInitial}>{userName.charAt(0).toUpperCase()}</Text>
            </TouchableOpacity>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    ...(Platform.OS === 'web' && {
      display: 'flex' as any,
    }),
  },

  // Sidebar
  sidebar: {
    backgroundColor: '#0a0a0a',
    borderRightWidth: 1,
    borderRightColor: '#1a1a1a',
    ...(Platform.OS === 'web' && {
      overflow: 'visible' as any,
    }),
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    gap: 10,
  },
  sidebarHeaderCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
  },
  sidebarTitle: {
    color: '#a1a1aa',
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
    borderTopColor: '#1a1a1a',
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
    color: '#52525b',
    fontSize: 11,
    fontWeight: '500',
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
    backgroundColor: '#1a1a1a',
  },
  divider: {
    height: 1,
    backgroundColor: '#1a1a1a',
    marginHorizontal: 12,
    marginVertical: 8,
  },
  newConversationButton: {
    width: 22,
    height: 22,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#4A9BA8',
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
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '400',
    flex: 1,
  },
  conversationInfo: {
    flex: 1,
    gap: 2,
  },
  conversationTitle: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '400',
  },
  workspaceLabel: {
    color: '#52525b',
    fontSize: 10,
    fontWeight: '400',
  },
  moreText: {
    color: '#52525b',
    fontSize: 12,
    paddingLeft: 34,
  },

  // Avatars
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: '#27272a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarCyan: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
  },
  avatarText: {
    color: '#06B6D4',
    fontSize: 11,
    fontWeight: '500',
  },
  avatarTextGray: {
    color: '#71717a',
    fontSize: 11,
    fontWeight: '500',
  },
  addIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  appIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: '#27272a',
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
    backgroundColor: '#27272a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  userInitial: {
    color: '#a1a1aa',
    fontSize: 11,
    fontWeight: '500',
  },
  invitationsButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  invitationsButtonDisabled: {
    backgroundColor: 'rgba(82, 82, 91, 0.1)',
  },
  invitationsBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#06B6D4',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  invitationsBadgeText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '700',
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
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 8,
    zIndex: 9999,
    elevation: 8,
    shadowColor: '#000',
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
    color: '#e4e4e7',
    fontSize: 13,
    fontWeight: '500',
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: '#27272a',
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  logoutText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '500',
  },

  // Mobile Modal
  modalOverlay: {
    flex: 1,
    flexDirection: 'row',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  mobileSidebar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: EXPANDED_WIDTH,
    backgroundColor: '#0a0a0a',
    borderRightWidth: 1,
    borderRightColor: '#1a1a1a',
  },
});
