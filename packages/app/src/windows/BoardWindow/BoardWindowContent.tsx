/**
 * Board Window Content
 *
 * Kanban board UI with columns and task cards.
 * Supports:
 * - Project selector (dropdown)
 * - Columns with task cards
 * - Create task inline
 * - Task detail panel
 * - Click to move between columns
 */

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Eye,
  Filter,
  Folder,
  MessageSquare,
  Minus,
  Pause,
  Play,
  Plus,
  Search,
  Square,
  SquareKanban,
  X,
} from '@tamagui/lucide-icons';
import type { AgentRelationship, BoardAgentInfo } from '../../services/BoardApi';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { useToast } from '../../components/Toast';
import {
  type Board,
  destroyBoardStore,
  getTasksByColumn,
  type Project,
  type Task,
  useBoardStore,
} from '../../store/boardStore';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import type { BoardWindowProps } from './definition';
import { KanbanColumn } from './KanbanColumn';
import { TaskDetailPanel } from './TaskDetailPanel';
import { AppSpinner } from '../../components/ui';
import { computeDependencyHighlights, type DependencyHighlight } from './board-utils';
import { colors } from '../../components/mca/primitives/colors';
import { useColors } from '../../components/mca/primitives/useColors';

// ============================================================================
// HELPERS
// ============================================================================

/** Small circular agent avatar: image if available, else initials fallback. */
function AgentAvatar({
  name,
  avatarUrl,
  size = 14,
  color = colors.violet,
  bgColor = colors.violetGlow,
}: {
  name: string;
  avatarUrl?: string;
  size?: number;
  color?: string;
  bgColor?: string;
}) {
  const radius = size / 2;
  if (avatarUrl) {
    return (
      <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden' }}>
        <img src={avatarUrl} style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover' }} />
      </View>
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: bgColor,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text fontSize={size * 0.57} color={color} fontWeight="700">
        {name[0] || '?'}
      </Text>
    </View>
  );
}

// ============================================================================
// AUTOPLAY TYPES & PANEL
// ============================================================================

/** Local UI state for one agent's autoplay config in this project */
interface AgentRelationshipState {
  agentId: string;
  agentName: string;
  avatarUrl?: string;
  slots: number;
  playEnabled: boolean;
  activeSlots: number;
}

/**
 * AgentPlayPanel — horizontal row: [label] [agent chips...] [+ Add runner]
 * Each chip: avatar + name | slots −/+ | ▶/⏹ | active/total.
 * "+ Add runner" button is the last item in the row; opens a dropdown below it.
 */
function AgentPlayPanel({
  relationships,
  availableAgents,
  onSetSlots,
  onSetPlay,
  onAddRunner,
  onRemoveRunner,
}: {
  relationships: AgentRelationshipState[];
  availableAgents: BoardAgentInfo[];
  onSetSlots: (agentId: string, slots: number) => void;
  onSetPlay: (agentId: string, enabled: boolean) => void;
  onAddRunner: (agentId: string) => void;
  onRemoveRunner: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const [dropdownAnchor, setDropdownAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const addButtonRef = useRef<View>(null);

  const addedIds = new Set(relationships.map((r) => r.agentId));
  const candidates = availableAgents.filter((a) => !addedIds.has(a.agentId));

  const openDropdown = () => {
    if (addButtonRef.current) {
      addButtonRef.current.measure((_fx, _fy, width, height, px, py) => {
        setDropdownAnchor({ x: px, y: py, width, height });
        setShowAddDropdown(true);
      });
    } else {
      setShowAddDropdown(true);
    }
  };

  return (
    <YStack gap="$1">
      {/* Label row */}
      <Text fontSize={11} color={c.text3} fontWeight="600">
        {t("board.autoplay")}
      </Text>

      {/* Single horizontal row: agent chips + "+ Add runner" button */}
      <XStack gap="$1" alignItems="center" flexWrap="wrap">
        {relationships.map((rel) => (
          <XStack
            key={rel.agentId}
            alignItems="center"
            gap="$2"
            backgroundColor={c.bgInner}
            borderRadius={6}
            paddingHorizontal={8}
            paddingVertical={5}
            borderWidth={1}
            borderColor={rel.playEnabled ? 'rgba(34,197,94,0.35)' : c.border}
          >
            {/* Avatar + name */}
            <AgentAvatar
              name={rel.agentName}
              avatarUrl={rel.avatarUrl}
              size={18}
              color={rel.playEnabled ? colors.green : colors.violet}
              bgColor={rel.playEnabled ? 'rgba(34,197,94,0.18)' : 'rgba(139,92,246,0.18)'}
            />
            <Text fontSize={11} color={c.text} numberOfLines={1} maxWidth={80}>
              {rel.agentName}
            </Text>

            {/* Slots −/+ */}
            <XStack alignItems="center" gap="$1">
              <TouchableOpacity
                onPress={() => onSetSlots(rel.agentId, Math.max(0, rel.slots - 1))}
                style={{
                  width: 18, height: 18, borderRadius: 4,
                  backgroundColor: c.bgCardHover,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Minus size={10} color={c.text3} />
              </TouchableOpacity>
              <Text fontSize={11} color={c.text2} minWidth={14} textAlign="center">
                {rel.slots}
              </Text>
              <TouchableOpacity
                onPress={() => onSetSlots(rel.agentId, rel.slots + 1)}
                style={{
                  width: 18, height: 18, borderRadius: 4,
                  backgroundColor: c.bgCardHover,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Plus size={10} color={c.text3} />
              </TouchableOpacity>
            </XStack>

            {/* Play/Stop — active if slots >= 1, dimmed hint if slots === 0 */}
            <TouchableOpacity
              onPress={() => rel.slots >= 1 ? onSetPlay(rel.agentId, !rel.playEnabled) : undefined}
              style={{
                width: 22, height: 22, borderRadius: 5,
                backgroundColor: rel.slots === 0
                  ? c.bgInner
                  : rel.playEnabled ? 'rgba(34,197,94,0.18)' : 'rgba(139,92,246,0.12)',
                alignItems: 'center', justifyContent: 'center',
                borderWidth: 1,
                borderColor: rel.slots === 0
                  ? c.border
                  : rel.playEnabled ? 'rgba(34,197,94,0.4)' : 'rgba(139,92,246,0.3)',
                opacity: rel.slots === 0 ? 0.45 : 1,
              }}
            >
              {rel.playEnabled
                ? <Square size={10} color={colors.green} />
                : <Play size={10} color={rel.slots === 0 ? c.text3 : colors.violet} />}
            </TouchableOpacity>

            {/* Active/total */}
            <Text fontSize={10} color={c.text3} minWidth={28} textAlign="right">
              {rel.activeSlots}/{rel.slots}
            </Text>

            {/* ✕ remove button */}
            <TouchableOpacity
              onPress={() => onRemoveRunner(rel.agentId)}
              style={{
                width: 14, height: 14, borderRadius: 3,
                alignItems: 'center', justifyContent: 'center',
                marginLeft: 2, opacity: 0.6,
              }}
            >
              <X size={9} color={c.text3} />
            </TouchableOpacity>
          </XStack>
        ))}

        {/* "+ Add runner" button — last item in the row */}
        <View ref={addButtonRef} collapsable={false}>
          <TouchableOpacity
            onPress={openDropdown}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 3,
              paddingHorizontal: 7, paddingVertical: 5,
              borderRadius: 6,
              backgroundColor: showAddDropdown ? colors.violetGlow : c.bgInner,
              borderWidth: 1,
              borderColor: showAddDropdown ? 'rgba(139,92,246,0.4)' : c.border,
            }}
          >
            <Plus size={10} color={colors.violet} />
            <Text fontSize={10} color={colors.violet} fontWeight="600">{t("board.addRunner")}</Text>
          </TouchableOpacity>
        </View>

        {/* Dropdown rendered in a Modal so it floats above all other elements */}
        <Modal
          visible={showAddDropdown}
          transparent
          animationType="none"
          onRequestClose={() => setShowAddDropdown(false)}
        >
          {/* Backdrop — tap outside to close */}
          <Pressable
            style={{ flex: 1 }}
            onPress={() => setShowAddDropdown(false)}
          >
            {/* Dropdown panel anchored below the button */}
            <View
              style={{
                position: 'absolute',
                top: dropdownAnchor ? dropdownAnchor.y + dropdownAnchor.height + 4 : 100,
                left: dropdownAnchor ? dropdownAnchor.x : 100,
                backgroundColor: c.bgCard,
                borderRadius: 7,
                borderWidth: 1,
                borderColor: 'rgba(139,92,246,0.25)',
                paddingVertical: 4,
                minWidth: 160,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 12,
                elevation: 20,
              }}
            >
              {candidates.length === 0 ? (
                <Text
                  fontSize={11} color={c.text3}
                  paddingHorizontal={10} paddingVertical={6}
                >
                  {t("board.noAgentsAvailable")}
                </Text>
              ) : (
                candidates.map((agent) => (
                  <TouchableOpacity
                    key={agent.agentId}
                    onPress={() => { onAddRunner(agent.agentId); setShowAddDropdown(false); }}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 8,
                      paddingHorizontal: 10, paddingVertical: 7,
                    }}
                  >
                    <AgentAvatar
                      name={agent.name}
                      avatarUrl={agent.avatarUrl}
                      size={18}
                      color={colors.violet}
                      bgColor="rgba(139,92,246,0.18)"
                    />
                    <Text fontSize={12} color={c.text}>{agent.name}</Text>
                  </TouchableOpacity>
                ))
              )}
            </View>
          </Pressable>
        </Modal>
      </XStack>
    </YStack>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface BoardWindowContentProps extends BoardWindowProps {
  windowId: string;
}

export function BoardWindowContent({
  windowId,
  workspaceId: initialWorkspaceId,
  projectId: initialProjectId,
}: BoardWindowContentProps) {
  const { t } = useTranslation();
  const c = useColors();
  const client = getTerosClient();
  const toast = useToast();
  const router = useRouter();
  const { openWindow, updateWindowProps } = useTilingStore();

  const {
    projects,
    board,
    tasks,
    currentProjectId,
    isLoadingProjects,
    isLoadingBoard,
    isCreatingTask,
    selectedTaskId,
    setCurrentProject,
    setProjects,
    setBoard,
    setTasks,
    addTask,
    addTasks,
    updateTaskInStore,
    removeTask,
    setSelectedTask,
    setLoadingProjects,
    setLoadingBoard,
    setCreatingTask,
    addProject,
  } = useBoardStore(windowId);

  // workspaceId: single source of truth — prop takes priority, falls back to
  // active workspace from Zustand store (handles late AsyncStorage hydration).
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceId = initialWorkspaceId || activeWorkspaceId || '';

  // WebSocket connection state — data loading must wait until connected.
  // Initialized as false (not client.isConnected()) so that on remount
  // (rotation / split view) the false→true transition always fires and
  // triggers the data-loading effects even when the socket is already up.
  const [connected, setConnected] = useState(false);

  // Track WebSocket connection state so data loading waits until connected.
  // This mirrors the pattern used by ConversationsWindow.
  useEffect(() => {
    const handleConnected = () => setConnected(true);
    const handleDisconnected = () => setConnected(false);
    client.on('connected', handleConnected);
    client.on('disconnected', handleDisconnected);
    // Sync current state in case the client connected before this effect ran
    setConnected(client.isConnected());
    return () => {
      client.off('connected', handleConnected);
      client.off('disconnected', handleDisconnected);
    };
  }, [client]);

  // Local UI state
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);
  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const boardRootRef = useRef<HTMLElement | null>(null);

  // Click-outside detection for the task detail panel (web only).
  // Closes the panel when clicking outside of it AND outside of task cards.
  // Clicks on task cards are handled by their own onPress (selects that task).
  useEffect(() => {
    if (!showTaskDetail || Platform.OS !== 'web') return;

    const root = boardRootRef.current;
    if (!root) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // If the click is inside the detail panel, do nothing
      if (target.closest('[data-task-detail-panel]')) return;
      // If the click is on a task card, do nothing — the card's onPress handles it
      if (target.closest('[data-task-card]')) return;
      // Otherwise, close the panel
      setShowTaskDetail(false);
      setSelectedTask(null);
    };

    root.addEventListener('mousedown', handleClickOutside);
    return () => root.removeEventListener('mousedown', handleClickOutside);
  }, [showTaskDetail]);

  // Agent name/avatar cache
  const [agentMap, setAgentMap] = useState<Record<string, { name: string; avatarUrl?: string }>>(
    {},
  );
  const [globalAgentMap, setGlobalAgentMap] = useState<
    Record<string, { name: string; avatarUrl?: string }>
  >({});

  // Tag filters state
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [showTagFilterDropdown, setShowTagFilterDropdown] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const tagSearchInputRef = useRef<any>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Dependency highlight: taskId being hovered triggers highlight on its dependents
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);

  // Autoplay v2: agent relationships (slots, playEnabled, activeSlots)
  const [agentRelationships, setAgentRelationships] = useState<AgentRelationshipState[]>([]);
  // Autoplay v2: all board-capable agents in the workspace (for "+ Add runner" dropdown)
  const [availableAgents, setAvailableAgents] = useState<BoardAgentInfo[]>([]);

  // Computed: unique tags from all tasks
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const task of tasks) {
      if (task.tags) {
        for (const tag of task.tags) {
          tagSet.add(tag);
        }
      }
    }
    return Array.from(tagSet).sort();
  }, [tasks]);

  // Computed: tags filtered by the search query inside the dropdown
  const visibleTagsInDropdown = useMemo(() => {
    if (!tagSearchQuery.trim()) return allTags;
    const q = tagSearchQuery.trim().toLowerCase();
    return allTags.filter((tag) => tag.toLowerCase().includes(q));
  }, [allTags, tagSearchQuery]);

  // Computed: filtered tasks based on active tag filters AND search query
  const filteredTasks = useMemo(() => {
    let result = tasks;

    // Apply tag filters
    if (activeTagFilters.size > 0) {
      result = result.filter((task) => {
        if (!task.tags || task.tags.length === 0) return false;
        // Show task if it has at least one of the active tags
        return task.tags.some((tag) => activeTagFilters.has(tag));
      });
    }

    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((task) => {
        // Search in title
        if (task.title.toLowerCase().includes(query)) return true;
        // Search in description
        if (task.description && task.description.toLowerCase().includes(query)) return true;
        // Search in instructions
        if (task.instructions && task.instructions.toLowerCase().includes(query)) return true;
        // Search in tags
        if (task.tags && task.tags.some((tag) => tag.toLowerCase().includes(query))) return true;
        return false;
      });
    }

    return result;
  }, [tasks, activeTagFilters, searchQuery]);

  // Computed: total tasks by column (unfiltered)
  const totalTasksByColumn = useMemo(() => {
    if (!board) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const column of board.columns) {
      const count = tasks.filter((t) => t.columnId === column.columnId).length;
      map.set(column.columnId, count);
    }
    return map;
  }, [tasks, board]);

  const tasksByColumn = useMemo(() => {
    if (!board) return new Map<string, Task[]>();
    return getTasksByColumn(filteredTasks, board.columns);
  }, [filteredTasks, board]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.taskId === selectedTaskId) || null,
    [tasks, selectedTaskId],
  );

  // Computed: dependency highlights for the currently hovered task
  const dependencyHighlights = useMemo(
    () =>
      hoveredTaskId
        ? computeDependencyHighlights(hoveredTaskId, tasks)
        : new Map<string, DependencyHighlight>(),
    [hoveredTaskId, tasks],
  );

  const toggleTagFilter = useCallback((tag: string) => {
    setActiveTagFilters((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(tag)) {
        newSet.delete(tag);
      } else {
        newSet.add(tag);
      }
      return newSet;
    });
  }, []);

  // Auto-focus tag search input when dropdown opens; reset search when it closes
  useEffect(() => {
    if (showTagFilterDropdown) {
      setTagSearchQuery('');
      // Small delay to ensure the input is rendered before focusing
      setTimeout(() => {
        tagSearchInputRef.current?.focus();
      }, 50);
    }
  }, [showTagFilterDropdown]);

  const currentProject = useMemo(
    () => projects.find((p) => p.projectId === currentProjectId) || null,
    [projects, currentProjectId],
  );

  // ========================================================================
  // DATA LOADING
  // ========================================================================

  // Load workspace agents filtered by MCA access (board-runner / board-manager).
  const loadFilteredAgents = useCallback(async (wsId: string) => {
    try {
      const { agents } = await client.agent.listAgents(wsId);

      // Fetch app access for all agents in parallel
      const appsResults = await Promise.all(
        agents.map((a) =>
          client.getAgentApps(a.agentId).catch(() => [] as Array<{ mcaId: string }>),
        ),
      );

      const workerMap: Record<string, { name: string; avatarUrl?: string }> = {};
      const supervisorMap: Record<string, { name: string; avatarUrl?: string }> = {};

      agents.forEach((agent, i) => {
        const apps = appsResults[i];
        const mcaIds = apps.map((app: any) => app.mcaId);
        if (mcaIds.includes('mca.teros.board-runner')) {
          workerMap[agent.agentId] = { name: agent.name, avatarUrl: agent.avatarUrl };
        }
        if (mcaIds.includes('mca.teros.board-manager')) {
          supervisorMap[agent.agentId] = { name: agent.name, avatarUrl: agent.avatarUrl };
        }
      });

      setAgentMap(workerMap);
      setGlobalAgentMap(supervisorMap);

      // Load board-capable agents (workspace + superagents) for the "+ Add runner" dropdown
      try {
        const { agents: boardAgents } = await client.board.listBoardAgents(wsId);
        setAvailableAgents(boardAgents);
      } catch (err) {
        console.error('Error loading board agents:', err);
      }
    } catch (err) {
      console.error('Error loading agents:', err);
    }
  }, [client]);

  // Load projects (and select the initial one) + agents when workspaceId is available
  // AND the WebSocket is connected. Without the connected guard, navigating directly
  // to /board/[projectId] (e.g. on page reload) would call sendFrameworkRequest before
  // the WebSocket handshake completes, causing a "Not connected to server" error.
  useEffect(() => {
    if (!workspaceId || !connected) return;
    loadProjects(initialProjectId ?? null);
    loadFilteredAgents(workspaceId);
  }, [workspaceId, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load board when the selected project changes (also gated on connection).
  useEffect(() => {
    if (!currentProjectId) {
      setBoard(null);
      setTasks([]);
      return;
    }
    if (!connected) return;
    loadBoard(currentProjectId);
  }, [currentProjectId, connected]);

  // Destroy this window's board store on unmount to free memory
  useEffect(() => {
    return () => {
      destroyBoardStore(windowId);
    };
  }, [windowId]);

  // Sync workspaceId + projectId + projectName into window props so:
  // 1. useUrlSync can build the correct deep-link URL: /workspace/{workspaceId}/board/{projectId}
  // 2. The tab title shows the project name instead of "Board"
  useEffect(() => {
    if (!workspaceId && !currentProjectId) return;
    updateWindowProps(windowId, {
      workspaceId: workspaceId || undefined,
      projectId: currentProjectId || undefined,
      projectName: currentProject?.name || undefined,
    });
  }, [windowId, workspaceId, currentProjectId, currentProject?.name]);

  // ========================================================================
  // REAL-TIME BOARD SUBSCRIPTION
  // ========================================================================

  useEffect(() => {
    if (!board) return;

    const boardId = board.boardId;

    // Subscribe to board events
    client.board.subscribeBoard(boardId).catch((err) => {
      console.warn('[BoardWindowContent] subscribeBoard error:', err);
    });

    const onTaskCreated = (msg: any) => {
      if (msg.task) addTask(msg.task);
    };
    const onBatchCreated = (msg: any) => {
      if (msg.tasks) addTasks(msg.tasks);
    };
    const onTaskUpdated = (msg: any) => {
      if (msg.task) updateTaskInStore(msg.task);
    };
    const onTaskDeleted = (msg: any) => {
      if (msg.taskId) removeTask(msg.taskId);
    };
    const onAgentConfigUpdated = (msg: any) => {
      if (!msg.agentId) return;
      setAgentRelationships((prev) => {
        const exists = prev.some((r) => r.agentId === msg.agentId);
        if (exists) {
          return prev.map((r) =>
            r.agentId === msg.agentId
              ? {
                  ...r,
                  slots: msg.slots ?? r.slots,
                  playEnabled: msg.playEnabled ?? r.playEnabled,
                  activeSlots: msg.activeSlots ?? r.activeSlots,
                }
              : r,
          );
        }
        // New agent relationship received — add it
        return [
          ...prev,
          {
            agentId: msg.agentId,
            agentName: msg.agentId,
            slots: msg.slots ?? 0,
            playEnabled: msg.playEnabled ?? false,
            activeSlots: msg.activeSlots ?? 0,
          },
        ];
      });
    };

    client.on('board_task_created', onTaskCreated);
    client.on('board_tasks_batch_created', onBatchCreated);
    client.on('board_task_updated', onTaskUpdated);
    client.on('board_task_deleted', onTaskDeleted);
    client.on('board_agent_config_updated', onAgentConfigUpdated);

    return () => {
      client.board.unsubscribeBoard(boardId).catch((err) => {
        console.warn('[BoardWindowContent] unsubscribeBoard error:', err);
      });
      client.off('board_task_created', onTaskCreated);
      client.off('board_tasks_batch_created', onBatchCreated);
      client.off('board_task_updated', onTaskUpdated);
      client.off('board_task_deleted', onTaskDeleted);
      client.off('board_agent_config_updated', onAgentConfigUpdated);
    };
  }, [board?.boardId]);

  // ========================================================================
  // DATA FETCHING
  // ========================================================================

  const loadProjects = async (targetProjectId: string | null = null) => {
    setLoadingProjects(true);
    try {
      const result = await client.board.listProjects(workspaceId);
      setProjects((result.projects || []) as any);
      // Auto-select project if none is currently selected.
      // Prefer targetProjectId (restored from props) over the first project in the list.
      if (!currentProjectId && result.projects?.length > 0) {
        const restoredProject = targetProjectId
          ? result.projects.find((p: any) => p.projectId === targetProjectId)
          : null;
        const projectToSelect = restoredProject || result.projects[0];
        setCurrentProject(projectToSelect.projectId);
        // URL sync is handled by the updateWindowProps effect (useUrlSync)
      }
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    } finally {
      setLoadingProjects(false);
    }
  };

  const loadBoard = async (projectId: string) => {
    setLoadingBoard(true);
    try {
      const result = await client.board.getBoard(projectId) as any;
      setBoard(result.board as any);
      setTasks((result.tasks || []) as any);

      // Populate agentRelationships from board.get response (autoplay v2)
      if (Array.isArray(result.agentRelationships)) {
        const rels: AgentRelationshipState[] = result.agentRelationships.map((rel: any) => {
          const agentInfo = globalAgentMap[rel.agentId] || agentMap[rel.agentId];
          return {
            agentId: rel.agentId,
            // prefer local map name (already resolved), fall back to what backend sent
            agentName: agentInfo?.name || rel.agentName || rel.agentId,
            // prefer local map avatar, fall back to avatarUrl from backend (covers superagents
            // and agents that don't appear in any task and thus aren't in the local map)
            avatarUrl: agentInfo?.avatarUrl ?? rel.avatarUrl,
            slots: rel.slots ?? 0,
            playEnabled: rel.playEnabled ?? false,
            activeSlots: rel.activeSlots ?? 0,
          };
        });
        setAgentRelationships(rels);
      }
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    } finally {
      setLoadingBoard(false);
    }
  };

  // ========================================================================
  // ACTIONS
  // ========================================================================

  const handleCreateProject = async () => {
    if (!newProjectName.trim() || !workspaceId) return;
    try {
      const result = await client.board.createProject(workspaceId, newProjectName.trim());
      addProject(result.project as any);
      setCurrentProject(result.project.projectId);
      setNewProjectName('');
      setShowCreateProject(false);
      toast.success(t("board.projectCreated"));
      // Update URL to reflect the new project
      router.push(`/workspace/${workspaceId}/board/${result.project.projectId}`);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  const handleCreateTask = async (columnId: string) => {
    if (!newTaskTitle.trim() || !currentProjectId) return;
    setCreatingTask(true);
    try {
      const result = await client.board.createTask(currentProjectId, {
        title: newTaskTitle.trim(),
        columnId,
      });
      addTask(result.task as any);
      setNewTaskTitle('');
      setAddingToColumn(null);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    } finally {
      setCreatingTask(false);
    }
  };

  const handleMoveTask = async (taskId: string, targetColumnId: string, dropIndex?: number) => {
    try {
      // Optimistic local reorder: move task in local state immediately
      if (dropIndex !== undefined) {
        const task = tasks.find((t) => t.taskId === taskId);
        if (task) {
          const sourceCol = task.columnId;
          const sameColumn = sourceCol === targetColumnId;

          // Get tasks in the target column (sorted), excluding the moved task
          const targetTasks = tasks
            .filter((t) => t.columnId === targetColumnId && t.taskId !== taskId)
            .sort((a, b) => a.position - b.position);

          // Calculate insert index for the filtered list
          let insertAt = dropIndex;
          if (sameColumn && task.position < dropIndex) {
            insertAt = dropIndex - 1;
          }
          insertAt = Math.max(0, Math.min(insertAt, targetTasks.length));

          // Insert the task at the right position
          targetTasks.splice(insertAt, 0, task);

          // Rebuild positions for target column
          const updatedTargetTasks = targetTasks.map((t, i) => ({
            ...t,
            columnId: targetColumnId,
            position: i,
          }));

          // If cross-column, also reindex source column
          let updatedSourceTasks: Task[] = [];
          if (!sameColumn) {
            updatedSourceTasks = tasks
              .filter((t) => t.columnId === sourceCol && t.taskId !== taskId)
              .sort((a, b) => a.position - b.position)
              .map((t, i) => ({ ...t, position: i }));
          }

          // Merge everything
          const affectedIds = new Set(
            [...updatedTargetTasks, ...updatedSourceTasks].map((t) => t.taskId),
          );
          const newTasks = tasks
            .filter((t) => !affectedIds.has(t.taskId))
            .concat(updatedTargetTasks, updatedSourceTasks);

          setTasks(newTasks);
        }
      }

      const result = await client.board.moveTask(taskId, targetColumnId, dropIndex);
      updateTaskInStore(result.task as any);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await client.board.deleteTask(taskId);
      removeTask(taskId);
      if (selectedTaskId === taskId) {
        setSelectedTask(null);
        setShowTaskDetail(false);
      }
      toast.success(t("board.taskDeleted"));
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  const handleOpenConversation = (channelId: string) => {
    openWindow('chat', { channelId }, true, windowId);
  };

  const handleAssignTask = async (taskId: string, agentId: string | null) => {
    try {
      const result = await client.board.assignTask(taskId, agentId);
      updateTaskInStore(result.task as any);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  const handleStartTask = async (taskId: string, agentId?: string) => {
    try {
      const result = await client.board.startTask(taskId, agentId);
      updateTaskInStore(result.task as any);
      toast.success(t("board.taskStarted"));
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  const handleStopTask = async (taskId: string) => {
    try {
      const result = await client.board.stopTask(taskId);
      updateTaskInStore(result.task as any);
      toast.success(t("board.stopRequested"));
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  // Complete task: move to Done column
  const handleCompleteTask = async (taskId: string) => {
    if (!board) return;
    const doneCol = board.columns.find((c) => c.slug === 'done');
    if (!doneCol) {
      toast.error('Done column not found');
      return;
    }
    try {
      const result = await client.board.moveTask(taskId, doneCol.columnId);
      updateTaskInStore(result.task as any);
      toast.success('Task completed');
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  // Archive task (soft-delete). If reason is provided, add a progress note first.
  const handleArchiveTask = async (taskId: string, reason?: string) => {
    try {
      if (reason && reason.trim()) {
        await client.board.addProgressNote(taskId, `Cancelada: ${reason.trim()}`);
      }
      const result = await client.board.archiveTask(taskId, true);
      updateTaskInStore(result.task as any);
      if (selectedTaskId === taskId) {
        setSelectedTask(null);
        setShowTaskDetail(false);
      }
      toast.success('Task archived');
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  const handleSetSlots = async (agentId: string, slots: number) => {
    if (!currentProjectId) return;
    // Optimistic update
    setAgentRelationships((prev) =>
      prev.map((r) => (r.agentId === agentId ? { ...r, slots } : r)),
    );
    try {
      await client.board.setAgentSlots(currentProjectId, agentId, slots);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
      // Revert on error by reloading
      loadBoard(currentProjectId);
    }
  };

  const handleSetPlay = async (agentId: string, enabled: boolean) => {
    if (!currentProjectId) return;
    // Optimistic update
    setAgentRelationships((prev) =>
      prev.map((r) => (r.agentId === agentId ? { ...r, playEnabled: enabled } : r)),
    );
    try {
      await client.board.setAgentPlay(currentProjectId, agentId, enabled);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
      // Revert on error by reloading
      loadBoard(currentProjectId);
    }
  };

  const handleRemoveRunner = async (agentId: string) => {
    if (!currentProjectId) return;
    // Optimistic: remove from panel immediately
    setAgentRelationships((prev) => prev.filter((r) => r.agentId !== agentId));
    try {
      await client.board.removeAgent(currentProjectId, agentId);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
      // Revert on error
      loadBoard(currentProjectId);
    }
  };

  const handleAddRunner = async (agentId: string) => {
    if (!currentProjectId) return;
    // Find agent info from availableAgents for optimistic update
    const agentInfo = availableAgents.find((a) => a.agentId === agentId);
    if (!agentInfo) return;
    // Optimistic: add to panel with slots:0, playEnabled:false
    setAgentRelationships((prev) => [
      ...prev,
      {
        agentId,
        agentName: agentInfo.name,
        avatarUrl: agentInfo.avatarUrl,
        slots: 0,
        playEnabled: false,
        activeSlots: 0,
      },
    ]);
    try {
      // setAgentSlots with slots:0 creates the relationship in backend
      await client.board.setAgentSlots(currentProjectId, agentId, 0);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
      // Revert on error
      setAgentRelationships((prev) => prev.filter((r) => r.agentId !== agentId));
    }
  };

  // ========================================================================
  // RENDER: CONTENT BELOW HEADER (computed)
  // ========================================================================

  const renderBoardContent = () => {
    // No workspace selected
    if (!workspaceId) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center" padding="$4">
          <SquareKanban size={40} color={colors.violet} />
          <Text fontSize={16} fontWeight="600" color={c.text} marginTop="$3">
            {t("board.selectWorkspace")}
          </Text>
          <Text fontSize={13} color={c.text2} marginTop="$1">
            {t("board.selectWorkspaceHint")}
          </Text>
        </YStack>
      );
    }

    // Loading projects
    if (isLoadingProjects && projects.length === 0) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <AppSpinner size="lg" variant="board" />
          <Text fontSize={13} color={c.text2} marginTop="$2">
            {t("board.loadingProjects")}
          </Text>
        </YStack>
      );
    }

    // No projects
    if (projects.length === 0 && !isLoadingProjects && workspaceId) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center" padding="$4">
          <Folder size={40} color={colors.violet} />
          <Text fontSize={16} fontWeight="600" color={c.text} marginTop="$3">
            {t("board.noProjects")}
          </Text>
          <Text fontSize={13} color={c.text2} marginTop="$1" textAlign="center">
            {t("board.noProjectsHint")}
          </Text>
          {!showCreateProject ? (
            <TouchableOpacity
              onPress={() => setShowCreateProject(true)}
              style={{
                marginTop: 16,
                backgroundColor: colors.violet,
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 8,
              }}
            >
              <Text color="white" fontWeight="600" fontSize={14}>
                {t("board.createProject")}
              </Text>
            </TouchableOpacity>
          ) : (
            <XStack marginTop="$3" gap="$2" alignItems="center">
              <TextInput
                value={newProjectName}
                onChangeText={setNewProjectName}
                placeholder={t("board.projectNamePlaceholder")}
                placeholderTextColor={c.text3}
                autoFocus
                onSubmitEditing={handleCreateProject}
                style={{
                  backgroundColor: c.bgInner,
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  color: c.text,
                  fontSize: 14,
                  width: 200,
                  borderWidth: 1,
                  borderColor: 'rgba(139,92,246,0.35)',
                }}
              />
              <TouchableOpacity onPress={handleCreateProject}>
                <Check size={20} color={colors.green} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setShowCreateProject(false);
                  setNewProjectName('');
                }}
              >
                <X size={20} color={colors.red} />
              </TouchableOpacity>
            </XStack>
          )}
        </YStack>
      );
    }

    // Loading board
    if (isLoadingBoard) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <AppSpinner size="lg" variant="board" />
        </YStack>
      );
    }

    // Board loaded
    if (board) {
      return (
        <YStack flex={1}>
          <XStack
            paddingHorizontal="$3"
            paddingVertical="$2"
            alignItems="flex-start"
            gap="$3"
            borderBottomWidth={1}
            borderBottomColor={c.border}
            flexWrap="wrap"
          >
            {/* Left: Autoplay panel */}
            <AgentPlayPanel
              relationships={agentRelationships}
              availableAgents={availableAgents}
              onSetSlots={handleSetSlots}
              onSetPlay={handleSetPlay}
              onAddRunner={handleAddRunner}
              onRemoveRunner={handleRemoveRunner}
            />

            {/* Spacer — pushes Tags + Search to the right */}
            <XStack flex={1} />

            {/* Right: Tags + Search */}
            <XStack gap="$3" alignItems="flex-start">
              {/* Tags column */}
              {allTags.length > 0 && (
                <YStack gap="$1">
                  <Text fontSize={11} color={c.text3} fontWeight="600">
                    {t("board.tags")}
                  </Text>
                  <TouchableOpacity
                    onPress={() => setShowTagFilterDropdown(!showTagFilterDropdown)}
                    style={{
                      backgroundColor:
                        activeTagFilters.size > 0
                          ? colors.violetGlow
                          : c.bgInner,
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      borderRadius: 6,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      borderWidth: 1,
                      borderColor:
                        activeTagFilters.size > 0
                          ? 'rgba(139,92,246,0.4)'
                          : c.border,
                    }}
                  >
                    <Filter size={12} color={activeTagFilters.size > 0 ? colors.violet : c.text3} />
                    {activeTagFilters.size > 0 && (
                      <View
                        style={{
                          backgroundColor: colors.violet,
                          borderRadius: 10,
                          minWidth: 16,
                          height: 16,
                          alignItems: 'center',
                          justifyContent: 'center',
                          paddingHorizontal: 4,
                        }}
                      >
                        <Text fontSize={9} fontWeight="700" color="white">
                          {activeTagFilters.size}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                </YStack>
              )}

              {/* Search column */}
              <YStack gap="$1">
                <Text fontSize={11} color={c.text3} fontWeight="600">
                  {t("board.search")}
                </Text>
                <XStack gap="$2" alignItems="center">
                  <View
                    style={{
                      backgroundColor: c.bgInner,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: searchQuery ? 'rgba(139,92,246,0.4)' : c.border,
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      gap: 4,
                      minWidth: 150,
                    }}
                  >
                    <Search size={12} color={searchQuery ? colors.violet : c.text3} />
                    <TextInput
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder={t("board.searchPlaceholder")}
                      placeholderTextColor={c.text3}
                      style={{ flex: 1, fontSize: 11, color: c.text, padding: 0 } as any}
                    />
                    {searchQuery && (
                      <TouchableOpacity onPress={() => setSearchQuery('')} style={{ padding: 2 }}>
                        <X size={10} color={c.text3} />
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* Clear all button */}
                  {(activeTagFilters.size > 0 || searchQuery) && (
                    <TouchableOpacity
                      onPress={() => {
                        setActiveTagFilters(new Set());
                        setSearchQuery('');
                      }}
                      style={{
                        backgroundColor: c.badges.err.bg,
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        borderRadius: 6,
                      }}
                    >
                      <X size={12} color={colors.red} />
                    </TouchableOpacity>
                  )}
                </XStack>
              </YStack>
            </XStack>

          </XStack>

          {/* Blocked tasks notification — based on column position */}
          {(() => {
            const blockedCol = board.columns.find((c) => c.slug === 'blocked');
            const blockedTasks = blockedCol
              ? tasks.filter((t) => t.columnId === blockedCol.columnId)
              : [];
            if (blockedTasks.length === 0) return null;
            return (
              <XStack
                paddingHorizontal="$3"
                paddingVertical="$2"
                alignItems="center"
                gap="$2"
                backgroundColor={c.badges.err.bg}
                borderBottomWidth={1}
                borderBottomColor={c.badges.err.border}
              >
                <AlertTriangle size={13} color={colors.red} />
                <Text fontSize={12} color={c.badges.err.text} flex={1}>
                  {t("board.blockedTaskCount", { count: blockedTasks.length })}
                </Text>
              </XStack>
            );
          })()}

          {/* Board columns */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
            <XStack padding="$2" gap="$2" alignItems="stretch" style={{ minHeight: '100%' }}>
              {board.columns.map((column) => (
                <KanbanColumn
                  key={column.columnId}
                  column={column}
                  tasks={tasksByColumn.get(column.columnId) || []}
                  allTasks={tasks}
                  totalTasksCount={totalTasksByColumn.get(column.columnId) || 0}
                  allColumns={board.columns}
                  selectedTaskId={selectedTaskId}
                  addingToColumn={addingToColumn}
                  newTaskTitle={newTaskTitle}
                  isCreatingTask={isCreatingTask}
                  onSelectTask={(taskId) => {
                    setSelectedTask(taskId);
                    setShowTaskDetail(true);
                  }}
                  onAddTask={() => setAddingToColumn(column.columnId)}
                  onCancelAdd={() => {
                    setAddingToColumn(null);
                    setNewTaskTitle('');
                  }}
                  onChangeNewTitle={setNewTaskTitle}
                  onSubmitNewTask={() => handleCreateTask(column.columnId)}
                  onMoveTask={handleMoveTask}
                  onDeleteTask={handleDeleteTask}
                  onOpenConversation={handleOpenConversation}
                  agentMap={agentMap}
                  dependencyHighlights={dependencyHighlights}
                  onTaskHoverIn={(taskId) => setHoveredTaskId(taskId)}
                  onTaskHoverOut={() => setHoveredTaskId(null)}
                />
              ))}
            </XStack>
          </ScrollView>
        </YStack>
      );
    }

    // No project selected
    if (!currentProjectId) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Text fontSize={14} color={c.text3}>
            {t("board.selectProject")}
          </Text>
        </YStack>
      );
    }

    return null;
  };

  const closeDropdowns = useCallback(() => {
    setShowProjectPicker(false);
  }, []);

  // ========================================================================
  // RENDER: MAIN LAYOUT
  // ========================================================================

  return (
    <Pressable
      onPress={closeDropdowns}
      style={{ flex: 1 }}
      {...(Platform.OS === 'web'
        ? { ref: (v: View | null) => { boardRootRef.current = v as unknown as HTMLElement | null; } } as any
        : {})}
    >
      <YStack flex={1} backgroundColor="$background">
        {/* ================================================================ */}
        {/* HEADER BAR */}
        {/* ================================================================ */}
        <XStack
          paddingHorizontal="$3"
          paddingVertical="$2"
          alignItems="center"
          borderBottomWidth={1}
          borderBottomColor={c.border}
          gap="$2"
        >
          {/* Project selector */}
          <TouchableOpacity
            onPress={() => {
              setShowProjectPicker(!showProjectPicker);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              backgroundColor: 'rgba(139,92,246,0.12)',
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 6,
            }}
          >
            <Folder size={13} color={colors.violet} />
            <Text fontSize={12} fontWeight="600" color={c.text} numberOfLines={1} maxWidth={160}>
              {currentProject?.name || t("board.selectProject")}
            </Text>
            <ChevronDown size={12} color={colors.violet} />
          </TouchableOpacity>

          <View style={{ flex: 1 }} />

          {/* Task count */}
          {board && (
            <Text fontSize={12} color={c.text3}>
              {t("board.taskCount", { count: tasks.length })}
            </Text>
          )}

          {/* New project button */}
          <TouchableOpacity onPress={() => setShowCreateProject(true)} style={{ padding: 4 }}>
            <Plus size={16} color={colors.violet} />
          </TouchableOpacity>
        </XStack>

        {/* Project picker dropdown */}
        {showProjectPicker && (
          <YStack
            position="absolute"
            top={44}
            left={180}
            zIndex={100}
            backgroundColor="$background"
            borderRadius={8}
            borderWidth={1}
            borderColor={c.borderStrong}
            padding="$1"
            minWidth={220}
            shadowColor="#000"
            shadowOpacity={0.2}
            shadowRadius={8}
            elevation={5}
          >
            {projects.length === 0 ? (
              <YStack paddingHorizontal={12} paddingVertical={8}>
                <Text fontSize={12} color={c.text3}>
                  {t("board.noProjectsInWorkspace")}
                </Text>
              </YStack>
            ) : (
              projects.map((p) => (
                <TouchableOpacity
                  key={p.projectId}
                  onPress={() => {
                    setCurrentProject(p.projectId);
                    setShowProjectPicker(false);
                    // Update URL to reflect the selected project
                    if (workspaceId) {
                      router.push(`/workspace/${workspaceId}/board/${p.projectId}`);
                    }
                  }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 6,
                    backgroundColor:
                      p.projectId === currentProjectId ? 'rgba(139,92,246,0.12)' : 'transparent',
                  }}
                >
                  <Text
                    fontSize={13}
                    color={c.text}
                    fontWeight={p.projectId === currentProjectId ? '600' : '400'}
                  >
                    {p.name}
                  </Text>
                </TouchableOpacity>
              ))
            )}
          </YStack>
        )}

        {/* Create project inline */}
        {showCreateProject && (
          <XStack
            padding="$2"
            gap="$2"
            alignItems="center"
            borderBottomWidth={1}
            borderBottomColor={c.border}
          >
            <TextInput
              value={newProjectName}
              onChangeText={setNewProjectName}
              placeholder={t("board.projectNamePlaceholder")}
              placeholderTextColor={c.text3}
              autoFocus
              onSubmitEditing={handleCreateProject}
              style={{
                flex: 1,
                backgroundColor: c.bgInner,
                borderRadius: 6,
                paddingHorizontal: 10,
                paddingVertical: 6,
                color: c.text,
                fontSize: 13,
              }}
            />
            <TouchableOpacity onPress={handleCreateProject}>
              <Check size={18} color={colors.green} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setShowCreateProject(false);
                setNewProjectName('');
              }}
            >
              <X size={18} color={colors.red} />
            </TouchableOpacity>
          </XStack>
        )}

        {/* ================================================================ */}
        {/* BOARD CONTENT — shrinks when detail panel is open so columns  */}
        {/* remain fully scrollable instead of hiding behind the overlay   */}
        {/* ================================================================ */}
        <View style={{ flex: 1, paddingRight: showTaskDetail ? 320 : 0 }}>
          {renderBoardContent()}
        </View>

        {/* ================================================================ */}
        {/* TASK DETAIL PANEL */}
        {/* ================================================================ */}

        {showTaskDetail && selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            columns={board?.columns || []}
            onClose={() => {
              setShowTaskDetail(false);
              setSelectedTask(null);
            }}
            onMoveTask={handleMoveTask}
            onOpenConversation={handleOpenConversation}
            onAssignTask={handleAssignTask}
            onStartTask={handleStartTask}
            onStopTask={handleStopTask}
            onCompleteTask={handleCompleteTask}
            onArchiveTask={handleArchiveTask}
            agentMap={agentMap}
          />
        )}
      </YStack>

      {/* Tag filter dropdown - rendered at root level for proper z-index */}
      {showTagFilterDropdown && allTags.length > 0 && (
        <>
          {/* Backdrop to close dropdown */}
          <Pressable
            onPress={() => setShowTagFilterDropdown(false)}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9998,
            }}
          />

          {/* Dropdown menu */}
          <View
            style={{
              position: 'absolute',
              top: 88,
              left: 60,
              zIndex: 9999,
              backgroundColor: c.bgCard,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: 'rgba(139,92,246,0.25)',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.25,
              shadowRadius: 16,
              minWidth: 220,
              maxHeight: 360,
              elevation: 20,
            }}
          >
            {/* Search input */}
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderBottomColor: c.border,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: c.bgInner,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: 'rgba(139,92,246,0.25)',
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  gap: 6,
                }}
              >
                <Search size={12} color={c.text3} />
                <TextInput
                  ref={tagSearchInputRef}
                  value={tagSearchQuery}
                  onChangeText={setTagSearchQuery}
                  placeholder={t("board.searchTags")}
                  placeholderTextColor={c.text3}
                  style={{
                    flex: 1,
                    color: c.text,
                    fontSize: 13,
                    backgroundColor: 'transparent',
                    borderWidth: 0,
                    padding: 0,
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {tagSearchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setTagSearchQuery('')}>
                    <X size={12} color={c.text3} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <ScrollView style={{ maxHeight: 280 }}>
              <YStack padding="$2" gap="$1">
                {visibleTagsInDropdown.length === 0 ? (
                  <View
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 14,
                      alignItems: 'center',
                    }}
                  >
                    <Text fontSize={13} color={c.text3}>
                      {t("board.noMatchingTags")}
                    </Text>
                  </View>
                ) : (
                  visibleTagsInDropdown.map((tag) => {
                    const isActive = activeTagFilters.has(tag);
                    return (
                      <TouchableOpacity
                        key={tag}
                        onPress={() => toggleTagFilter(tag)}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                          paddingHorizontal: 12,
                          paddingVertical: 10,
                          borderRadius: 6,
                          backgroundColor: isActive ? 'rgba(139,92,246,0.12)' : 'transparent',
                        }}
                      >
                        {/* Checkbox */}
                        <View
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            borderWidth: 2,
                            borderColor: isActive ? colors.violet : c.borderStrong,
                            backgroundColor: isActive ? colors.violet : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {isActive && <Check size={14} color="white" />}
                        </View>
                        <Text
                          fontSize={13}
                          color={c.text}
                          fontWeight={isActive ? '600' : '400'}
                          flex={1}
                        >
                          {tag}
                        </Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </YStack>
            </ScrollView>
          </View>
        </>
      )}
    </Pressable>
  );
}
