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
  Filter,
  Folder,
  MessageSquare,
  Minus,
  Pause,
  Play,
  Plus,
  Search,
  SquareKanban,
  User,
  X,
} from '@tamagui/lucide-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useToast } from '../../components/Toast';
import {
  type Board,
  type BoardColumn,
  destroyBoardStore,
  getTasksByColumn,
  PRIORITY_CONFIG,
  type ProgressNote,
  type Project,
  type Task,
  type TaskStatus,
  useBoardStore,
} from '../../store/boardStore';
import { useTilingStore } from '../../store/tilingStore';
import type { BoardWindowProps } from './definition';
import { KanbanColumn } from './KanbanColumn';
import { TaskDetailPanel } from './TaskDetailPanel';
import { AppSpinner } from '../../components/ui';
import { computeDependencyHighlights, type DependencyHighlight } from './board-utils';

// ============================================================================
// CONSTANTS
// ============================================================================

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  idle: { label: 'Idle', color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)' },
  assigned: { label: 'Assigned', color: '#60A5FA', bg: 'rgba(96,165,250,0.15)' },
  working: { label: 'Working', color: '#F59E0B', bg: 'rgba(245,158,11,0.15)' },
  blocked: { label: 'Blocked', color: '#EF4444', bg: 'rgba(239,68,68,0.15)' },
  review: { label: 'Review', color: '#A78BFA', bg: 'rgba(167,139,250,0.15)' },
  done: { label: 'Done', color: '#22C55E', bg: 'rgba(34,197,94,0.15)' },
};

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
    removeProject,
  } = useBoardStore(windowId);

  // Local UI state
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId || '');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);
  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const [workspaces, setWorkspaces] = useState<Array<{ workspaceId: string; name: string }>>([]);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

  // Agent name/avatar cache
  const [agentMap, setAgentMap] = useState<Record<string, { name: string; avatarUrl?: string }>>(
    {},
  );
  const [globalAgentMap, setGlobalAgentMap] = useState<
    Record<string, { name: string; avatarUrl?: string }>
  >({});

  // Auto-dispatcher state
  const [workerSlots, setWorkerSlots] = useState<Record<string, number>>({}); // agentId -> max concurrent tasks
  const [autoDispatchRunning, setAutoDispatchRunning] = useState(false);

  // Supervisor state
  const [selectedSupervisorId, setSelectedSupervisorId] = useState<string | null>(null);
  const [activeSupervisorChannelId, setActiveSupervisorChannelId] = useState<string | null>(null);
  const [showSupervisorPicker, setShowSupervisorPicker] = useState(false);

  // Tag filters state
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());
  const [showTagFilterDropdown, setShowTagFilterDropdown] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Dependency highlight: taskId being hovered triggers highlight on its dependents
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);

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

  // Computed
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

  const currentProject = useMemo(
    () => projects.find((p) => p.projectId === currentProjectId) || null,
    [projects, currentProjectId],
  );

  // ========================================================================
  // DATA LOADING
  // ========================================================================

  // Load workspaces on mount
  useEffect(() => {
    const load = async () => {
      try {
        const data = await client.listWorkspaces();
        setWorkspaces(data);
        // Auto-select first workspace if none provided
        if (!workspaceId && data.length > 0) {
          setWorkspaceId(data[0].workspaceId);
        }
      } catch (err) {
        console.error('Error loading workspaces:', err);
      }
    };
    if (client.isConnected()) {
      load();
    } else {
      const onConnected = () => {
        client.off('connected', onConnected);
        load();
      };
      client.on('connected', onConnected);
      return () => client.off('connected', onConnected);
    }
  }, []);

  // Load projects and agents when workspace changes
  useEffect(() => {
    if (!workspaceId) return;
    loadProjects();

    // Load workspace agents filtered by MCA access
    const loadFilteredAgents = async () => {
      try {
        const { agents } = await client.agent.listAgents(workspaceId);

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
      } catch (err) {
        console.error('Error loading agents:', err);
      }
    };

    loadFilteredAgents();
  }, [workspaceId]);

  // Load board when project changes
  useEffect(() => {
    if (!currentProjectId) {
      setBoard(null);
      setTasks([]);
      return;
    }
    loadBoard(currentProjectId);
  }, [currentProjectId]);

  // Auto-select initial project
  useEffect(() => {
    if (initialProjectId && !currentProjectId) {
      setCurrentProject(initialProjectId);
    }
  }, [initialProjectId]);

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

  const subscribedBoardRef = useRef<string | null>(null);

  useEffect(() => {
    if (!board) return;

    const boardId = board.boardId;

    // Subscribe to board events
    client.board.subscribeBoard(boardId).catch((err) => {
      console.warn('[BoardWindowContent] subscribeBoard error:', err);
    });
    subscribedBoardRef.current = boardId;

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

    client.on('board_task_created', onTaskCreated);
    client.on('board_tasks_batch_created', onBatchCreated);
    client.on('board_task_updated', onTaskUpdated);
    client.on('board_task_deleted', onTaskDeleted);

    return () => {
      client.board.unsubscribeBoard(boardId).catch((err) => {
        console.warn('[BoardWindowContent] unsubscribeBoard error:', err);
      });
      subscribedBoardRef.current = null;
      client.off('board_task_created', onTaskCreated);
      client.off('board_tasks_batch_created', onBatchCreated);
      client.off('board_task_updated', onTaskUpdated);
      client.off('board_task_deleted', onTaskDeleted);
    };
  }, [board?.boardId]);

  // ========================================================================
  // DATA FETCHING
  // ========================================================================

  const loadProjects = async () => {
    setLoadingProjects(true);
    try {
      const result = await client.board.listProjects(workspaceId);
      setProjects((result.projects || []) as any);
      // Auto-select project if none selected:
      // Prefer initialProjectId (restored from props) over the first project
      if (!currentProjectId && result.projects?.length > 0) {
        const restoredProject = initialProjectId
          ? result.projects.find((p: any) => p.projectId === initialProjectId)
          : null;
        const projectToSelect = restoredProject || result.projects[0];
        setCurrentProject(projectToSelect.projectId);
        // Update URL to reflect the selected project
        if (workspaceId) {
          router.push(`/workspace/${workspaceId}/board/${projectToSelect.projectId}`);
        }
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
      const result = await client.board.getBoard(projectId);
      setBoard(result.board as any);
      setTasks((result.tasks || []) as any);
      
      // Restore board config if it exists
      if (result.board?.config) {
        const config = result.board.config;
        if (config.workerSlots) setWorkerSlots(config.workerSlots);
        if (config.autoDispatchRunning !== undefined) setAutoDispatchRunning(config.autoDispatchRunning);
        if (config.selectedSupervisorId !== undefined) setSelectedSupervisorId(config.selectedSupervisorId);
        if (config.activeSupervisorChannelId !== undefined) setActiveSupervisorChannelId(config.activeSupervisorChannelId);
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
      toast.success('Proyecto creado');
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
      toast.success('Tarea eliminada');
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
      toast.success('Tarea iniciada');
      // Open the conversation that was created
      if (result.task?.channelId) {
        openWindow('chat', { channelId: result.task.channelId }, false, windowId);
      }
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  // Start supervisor: create conversation and send briefing
  const handleStartSupervisor = async () => {
    if (!selectedSupervisorId || !board || !currentProject) return;

    try {
      // Build briefing message
      const todoCol = board.columns.find((c) => c.slug === 'todo');
      const todoCount = todoCol ? tasks.filter((t) => t.columnId === todoCol.columnId).length : 0;

      const workersList = Object.entries(workerSlots)
        .filter(([_, slots]) => slots > 0)
        .map(([agentId, slots]) => {
          const agent = agentMap[agentId];
          return `- ${agent?.name || agentId}: ${slots} slot${slots > 1 ? 's' : ''}`;
        })
        .join('\n');

      const briefing = `# Board Supervisor Briefing

**Workspace:** ${workspaces.find((w) => w.workspaceId === workspaceId)?.name || workspaceId} (workspaceId: \`${workspaceId}\`)
**Project:** ${currentProject.name} (projectId: \`${currentProject.projectId}\`)
**To Do tasks:** ${todoCount}

**Available workers:**
${workersList || '(none configured)'}

You are now supervising this board. You have full control over task assignment and execution. Work independently — only stop to ask the user if you need explicit feedback or clarification on a specific aspect of the project that you cannot resolve on your own. If something seems like a reasonable decision, make it and move forward.

**Your role is supervisor, not executor.** You do not implement tasks yourself. Your job is to assign tasks to the available workers, launch them, and monitor their progress through the task's linked conversation (channelId). If a worker reports a blocker or proposes something, evaluate it and act accordingly — reassign, create a new task, or unblock them.

**Important rules:**
- Only work on tasks in the **To Do** and **In Progress** columns. Never touch the Backlog.
- When a task is completed, move it to **Review** (not Done). The user will review and close it.`;

      // Create channel with initial briefing message
      const result = await client.channel.createWithMessage({
        agentId: selectedSupervisorId,
        content: { type: "text", text: briefing },
        workspaceId,
      });

      // Set active supervisor using channelId
      const newChannelId = result.channelId;
      setActiveSupervisorChannelId(newChannelId);

      // Persist immediately (don't rely on debounce)
      await client.board.updateBoardConfig(currentProject.projectId, {
        workerSlots,
        autoDispatchRunning,
        selectedSupervisorId,
        activeSupervisorChannelId: newChannelId,
      });

      toast.success('Supervisor iniciado');

      // Open supervisor conversation in a new tab
      openWindow('chat', { channelId: result.channelId }, true, windowId);
    } catch (err: any) {
      toast.error(`Error: ${err.message}`);
    }
  };

  // Auto-dispatcher: dispatch tasks from To Do to available agents
  const dispatchingRef = useRef(false);
  const dispatchNext = useCallback(async () => {
    if (!board || dispatchingRef.current) return;
    dispatchingRef.current = true;

    try {
      const todoCol = board.columns.find((c) => c.slug === 'todo');
      const inProgressCol = board.columns.find((c) => c.slug === 'in_progress');
      if (!todoCol) return;

      const todoTasks = tasks
        .filter((t) => t.columnId === todoCol.columnId)
        .sort((a, b) => a.position - b.position);

      if (todoTasks.length === 0) {
        setAutoDispatchRunning(false);
        return;
      }

      // Count busy slots: tasks that are running OR already in progress for this agent
      const busyCount: Record<string, number> = {};
      for (const t of tasks) {
        if (
          t.assignedAgentId &&
          (t.running || (inProgressCol && t.columnId === inProgressCol.columnId))
        ) {
          busyCount[t.assignedAgentId] = (busyCount[t.assignedAgentId] || 0) + 1;
        }
      }

      // Find agents with free slots
      const availableAgents: string[] = [];
      for (const [agentId, maxSlots] of Object.entries(workerSlots)) {
        if (maxSlots <= 0) continue;
        const busy = busyCount[agentId] || 0;
        const free = maxSlots - busy;
        for (let i = 0; i < free; i++) {
          availableAgents.push(agentId);
        }
      }

      if (availableAgents.length === 0) return;

      // Dispatch ONE task at a time, then let the effect re-trigger for the next
      const task = todoTasks[0];
      const agentId = availableAgents[0];
      try {
        const result = await client.board.startTask(task.taskId, agentId);
        updateTaskInStore(result.task as any);
      } catch (err: any) {
        toast.error(`Error dispatching ${task.title}: ${err.message}`);
      }
    } finally {
      dispatchingRef.current = false;
    }
  }, [board, tasks, workerSlots, updateTaskInStore, toast]);

  // Auto-dispatch loop: watch for task changes and dispatch next
  useEffect(() => {
    if (!autoDispatchRunning) return;
    // Small delay to let store settle after task updates
    const timer = setTimeout(() => dispatchNext(), 500);
    return () => clearTimeout(timer);
  }, [autoDispatchRunning, tasks, dispatchNext]);

  // Persist board config when it changes (debounced)
  useEffect(() => {
    if (!currentProjectId || !board) return;
    
    const timer = setTimeout(() => {
      const config = {
        workerSlots,
        autoDispatchRunning,
        selectedSupervisorId,
        activeSupervisorChannelId,
      };
      
      client.board.updateBoardConfig(currentProjectId, config).catch((err) => {
        console.error('Error saving board config:', err);
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [workerSlots, autoDispatchRunning, selectedSupervisorId, activeSupervisorChannelId, currentProjectId, board]);

  // ========================================================================
  // RENDER: CONTENT BELOW HEADER (computed)
  // ========================================================================

  const renderBoardContent = () => {
    // No workspace selected
    if (!workspaceId) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center" padding="$4">
          <SquareKanban size={40} color="#8B5CF6" />
          <Text fontSize={16} fontWeight="600" color="$color" marginTop="$3">
            Selecciona un workspace
          </Text>
          <Text fontSize={13} color="$color" opacity={0.5} marginTop="$1">
            Usa el selector de arriba para elegir uno
          </Text>
        </YStack>
      );
    }

    // Loading projects
    if (isLoadingProjects && projects.length === 0) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <AppSpinner size="lg" variant="board" />
          <Text fontSize={13} color="$color" opacity={0.5} marginTop="$2">
            Cargando proyectos...
          </Text>
        </YStack>
      );
    }

    // No projects
    if (projects.length === 0 && !isLoadingProjects && workspaceId) {
      return (
        <YStack flex={1} alignItems="center" justifyContent="center" padding="$4">
          <Folder size={40} color="#8B5CF6" />
          <Text fontSize={16} fontWeight="600" color="$color" marginTop="$3">
            No hay proyectos
          </Text>
          <Text fontSize={13} color="$color" opacity={0.5} marginTop="$1" textAlign="center">
            Crea un proyecto para empezar a organizar tareas
          </Text>
          {!showCreateProject ? (
            <TouchableOpacity
              onPress={() => setShowCreateProject(true)}
              style={{
                marginTop: 16,
                backgroundColor: '#8B5CF6',
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 8,
              }}
            >
              <Text color="white" fontWeight="600" fontSize={14}>
                Crear proyecto
              </Text>
            </TouchableOpacity>
          ) : (
            <XStack marginTop="$3" gap="$2" alignItems="center">
              <TextInput
                value={newProjectName}
                onChangeText={setNewProjectName}
                placeholder="Nombre del proyecto..."
                placeholderTextColor="#999"
                autoFocus
                onSubmitEditing={handleCreateProject}
                style={{
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  color: 'white',
                  fontSize: 14,
                  width: 200,
                  borderWidth: 1,
                  borderColor: 'rgba(139,92,246,0.3)',
                }}
              />
              <TouchableOpacity onPress={handleCreateProject}>
                <Check size={20} color="#22C55E" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setShowCreateProject(false);
                  setNewProjectName('');
                }}
              >
                <X size={20} color="#EF4444" />
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
      const todoCol = board.columns.find((c) => c.slug === 'todo');
      const todoCount = todoCol ? (tasksByColumn.get(todoCol.columnId) || []).length : 0;
      const totalWorkerSlots = Object.values(workerSlots).reduce((a, b) => a + b, 0);

      return (
        <YStack flex={1}>
          <XStack
            paddingHorizontal="$3"
            paddingVertical="$2"
            alignItems="flex-start"
            gap="$3"
            borderBottomWidth={1}
            borderBottomColor="rgba(255,255,255,0.06)"
            flexWrap="wrap"
          >
            {/* Supervisor column */}
            <YStack gap="$1">
              <Text fontSize={11} color="$color" opacity={0.5} fontWeight="600">
                Supervisor
              </Text>
              {(() => {
                // Detect if there's any work happening
                const hasRunningTasks = tasks.some((t) => t.running);
                const inProgressCol = board?.columns.find((c) => c.slug === 'in_progress');
                const hasInProgressTasks = inProgressCol
                  ? tasks.some((t) => t.columnId === inProgressCol.columnId)
                  : false;
                const isWorking = hasRunningTasks || hasInProgressTasks;

                // State a) No supervisor selected
                if (!selectedSupervisorId) {
                  return (
                    <Pressable
                      onPress={() => setShowSupervisorPicker(!showSupervisorPicker)}
                      style={{
                        backgroundColor: 'rgba(255,255,255,0.05)',
                        borderRadius: 6,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <User size={12} color="rgba(255,255,255,0.4)" />
                      <Text fontSize={11} color="$color" opacity={0.5}>
                        Seleccionar
                      </Text>
                      <ChevronDown size={10} color="rgba(255,255,255,0.4)" />
                    </Pressable>
                  );
                }

                // State b) Selected but not active
                if (!activeSupervisorChannelId) {
                  return (
                    <XStack
                      alignItems="center"
                      gap={6}
                      backgroundColor="rgba(255,255,255,0.05)"
                      borderRadius={6}
                      paddingHorizontal={8}
                      paddingVertical={4}
                    >
                      {globalAgentMap[selectedSupervisorId]?.avatarUrl ? (
                        <View
                          style={{ width: 16, height: 16, borderRadius: 8, overflow: 'hidden' }}
                        >
                          <img
                            src={globalAgentMap[selectedSupervisorId].avatarUrl}
                            style={{ width: 16, height: 16, borderRadius: 8, objectFit: 'cover' }}
                          />
                        </View>
                      ) : (
                        <View
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 8,
                            backgroundColor: 'rgba(139,92,246,0.25)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text fontSize={9} color="#8B5CF6" fontWeight="700">
                            {globalAgentMap[selectedSupervisorId]?.name[0] || 'S'}
                          </Text>
                        </View>
                      )}
                      <Text fontSize={11} color="$color" opacity={0.7}>
                        {globalAgentMap[selectedSupervisorId]?.name || 'Supervisor'}
                      </Text>
                      <TouchableOpacity
                        onPress={() => setSelectedSupervisorId(null)}
                        style={{ padding: 2 }}
                      >
                        <X size={12} color="#9CA3AF" />
                      </TouchableOpacity>
                    </XStack>
                  );
                }

                // State c) Active and working
                if (isWorking) {
                  return (
                    <XStack
                      alignItems="center"
                      gap={6}
                      backgroundColor="rgba(139,92,246,0.15)"
                      borderRadius={6}
                      paddingHorizontal={8}
                      paddingVertical={4}
                    >
                      {globalAgentMap[selectedSupervisorId]?.avatarUrl ? (
                        <View
                          style={{ width: 16, height: 16, borderRadius: 8, overflow: 'hidden' }}
                        >
                          <img
                            src={globalAgentMap[selectedSupervisorId].avatarUrl}
                            style={{ width: 16, height: 16, borderRadius: 8, objectFit: 'cover' }}
                          />
                        </View>
                      ) : (
                        <View
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 8,
                            backgroundColor: 'rgba(139,92,246,0.3)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text fontSize={9} color="#8B5CF6" fontWeight="700">
                            {globalAgentMap[selectedSupervisorId]?.name[0] || 'S'}
                          </Text>
                        </View>
                      )}
                      <Text fontSize={11} color="#8B5CF6" fontWeight="600">
                        {globalAgentMap[selectedSupervisorId]?.name || 'Supervisor'}
                      </Text>
                      <TouchableOpacity
                        onPress={() => handleOpenConversation(activeSupervisorChannelId)}
                        style={{ padding: 2 }}
                      >
                        <MessageSquare size={12} color="#8B5CF6" />
                      </TouchableOpacity>
                    </XStack>
                  );
                }

                // State d) Active but idle (needs attention)
                if (autoDispatchRunning || activeSupervisorChannelId) {
                  return (
                    <XStack
                      alignItems="center"
                      gap={6}
                      backgroundColor="rgba(245,158,11,0.15)"
                      borderRadius={6}
                      paddingHorizontal={8}
                      paddingVertical={4}
                    >
                      {globalAgentMap[selectedSupervisorId]?.avatarUrl ? (
                        <View
                          style={{ width: 16, height: 16, borderRadius: 8, overflow: 'hidden' }}
                        >
                          <img
                            src={globalAgentMap[selectedSupervisorId].avatarUrl}
                            style={{ width: 16, height: 16, borderRadius: 8, objectFit: 'cover' }}
                          />
                        </View>
                      ) : (
                        <View
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 8,
                            backgroundColor: 'rgba(245,158,11,0.3)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text fontSize={9} color="#F59E0B" fontWeight="700">
                            {globalAgentMap[selectedSupervisorId]?.name[0] || 'S'}
                          </Text>
                        </View>
                      )}
                      <Text fontSize={11} color="#F59E0B" fontWeight="600">
                        {globalAgentMap[selectedSupervisorId]?.name || 'Supervisor'}
                      </Text>
                      <View
                        style={{
                          animation: 'pulse 2s ease-in-out infinite',
                        }}
                      >
                        <AlertTriangle size={12} color="#F59E0B" />
                      </View>
                      <TouchableOpacity
                        onPress={() => handleOpenConversation(activeSupervisorChannelId)}
                        style={{ padding: 2 }}
                      >
                        <MessageSquare size={12} color="#F59E0B" />
                      </TouchableOpacity>
                    </XStack>
                  );
                }

                // State e) Paused (shouldn't reach here, but fallback)
                return (
                  <XStack
                    alignItems="center"
                    gap={6}
                    backgroundColor="rgba(255,255,255,0.05)"
                    borderRadius={6}
                    paddingHorizontal={8}
                    paddingVertical={4}
                  >
                    {globalAgentMap[selectedSupervisorId]?.avatarUrl ? (
                      <View style={{ width: 16, height: 16, borderRadius: 8, overflow: 'hidden' }}>
                        <img
                          src={globalAgentMap[selectedSupervisorId].avatarUrl}
                          style={{ width: 16, height: 16, borderRadius: 8, objectFit: 'cover' }}
                        />
                      </View>
                    ) : (
                      <View
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 8,
                          backgroundColor: 'rgba(139,92,246,0.25)',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text fontSize={9} color="#8B5CF6" fontWeight="700">
                          {globalAgentMap[selectedSupervisorId]?.name[0] || 'S'}
                        </Text>
                      </View>
                    )}
                    <Text fontSize={11} color="$color" opacity={0.7}>
                      {globalAgentMap[selectedSupervisorId]?.name || 'Supervisor'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => handleOpenConversation(activeSupervisorChannelId)}
                      style={{ padding: 2 }}
                    >
                      <MessageSquare size={12} color="#9CA3AF" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={async () => {
                        setActiveSupervisorChannelId(null);
                        setAutoDispatchRunning(false);
                        
                        // Persist immediately
                        if (currentProjectId) {
                          await client.board.updateBoardConfig(currentProjectId, {
                            workerSlots,
                            autoDispatchRunning: false,
                            selectedSupervisorId,
                            activeSupervisorChannelId: null,
                          }).catch((err) => {
                            console.error('Error saving board config:', err);
                          });
                        }
                      }}
                      style={{ padding: 2 }}
                    >
                      <X size={12} color="#EF4444" />
                    </TouchableOpacity>
                  </XStack>
                );
              })()}
            </YStack>

            {/* Workers column */}
            <YStack gap="$1">
              <Text fontSize={11} color="$color" opacity={0.5} fontWeight="600">
                Workers
              </Text>
              <XStack gap="$2" flexWrap="wrap" alignItems="center">
                {Object.entries(agentMap).map(([agentId, agent]) => {
                  const slots = workerSlots[agentId] || 0;
                  return (
                    <XStack
                      key={agentId}
                      alignItems="center"
                      gap={4}
                      backgroundColor="rgba(255,255,255,0.05)"
                      borderRadius={6}
                      paddingHorizontal={8}
                      paddingVertical={4}
                    >
                      {agent.avatarUrl ? (
                        <View
                          style={{ width: 16, height: 16, borderRadius: 8, overflow: 'hidden' }}
                        >
                          <img
                            src={agent.avatarUrl}
                            style={{ width: 16, height: 16, borderRadius: 8, objectFit: 'cover' }}
                          />
                        </View>
                      ) : (
                        <View
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 8,
                            backgroundColor: 'rgba(139,92,246,0.25)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text fontSize={9} color="#8B5CF6" fontWeight="700">
                            {agent.name[0]}
                          </Text>
                        </View>
                      )}
                      <Text fontSize={11} color="$color" opacity={0.7}>
                        {agent.name}
                      </Text>
                      <XStack alignItems="center" gap={2}>
                        <TouchableOpacity
                          onPress={() =>
                            setWorkerSlots((prev) => ({
                              ...prev,
                              [agentId]: Math.max(0, (prev[agentId] || 0) - 1),
                            }))
                          }
                          style={{ padding: 2 }}
                        >
                          <Minus size={10} color="#9CA3AF" />
                        </TouchableOpacity>
                        <Text
                          fontSize={12}
                          color={slots > 0 ? '#8B5CF6' : '$color'}
                          opacity={slots > 0 ? 1 : 0.3}
                          fontWeight="700"
                          width={14}
                          textAlign="center"
                        >
                          {slots}
                        </Text>
                        <TouchableOpacity
                          onPress={() =>
                            setWorkerSlots((prev) => ({
                              ...prev,
                              [agentId]: (prev[agentId] || 0) + 1,
                            }))
                          }
                          style={{ padding: 2 }}
                        >
                          <Plus size={10} color="#9CA3AF" />
                        </TouchableOpacity>
                      </XStack>
                    </XStack>
                  );
                })}

                {/* Play/Pause button */}
                <TouchableOpacity
                  onPress={async () => {
                    if (activeSupervisorChannelId) {
                      setActiveSupervisorChannelId(null);
                      setAutoDispatchRunning(false);
                      
                      // Persist immediately
                      if (currentProjectId) {
                        await client.board.updateBoardConfig(currentProjectId, {
                          workerSlots,
                          autoDispatchRunning: false,
                          selectedSupervisorId,
                          activeSupervisorChannelId: null,
                        }).catch((err) => {
                          console.error('Error saving board config:', err);
                        });
                      }
                    } else if (selectedSupervisorId) {
                      handleStartSupervisor();
                    } else if (autoDispatchRunning) {
                      setAutoDispatchRunning(false);
                    } else if (totalWorkerSlots > 0 && todoCount > 0) {
                      setAutoDispatchRunning(true);
                    }
                  }}
                  style={{
                    backgroundColor:
                      activeSupervisorChannelId || autoDispatchRunning
                        ? 'rgba(245,158,11,0.2)'
                        : selectedSupervisorId || (totalWorkerSlots > 0 && todoCount > 0)
                          ? 'rgba(34,197,94,0.2)'
                          : 'rgba(255,255,255,0.05)',
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 6,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    opacity:
                      selectedSupervisorId || (totalWorkerSlots > 0 && todoCount > 0) ? 1 : 0.4,
                  }}
                >
                  {activeSupervisorChannelId || autoDispatchRunning ? (
                    <Pause size={12} color="#F59E0B" />
                  ) : (
                    <Play size={12} color="#22C55E" />
                  )}
                  <Text
                    fontSize={11}
                    fontWeight="600"
                    color={activeSupervisorChannelId || autoDispatchRunning ? '#F59E0B' : '#22C55E'}
                  >
                    {activeSupervisorChannelId || autoDispatchRunning ? 'Pause' : 'Run'}
                  </Text>
                </TouchableOpacity>
              </XStack>
            </YStack>

            {/* Spacer */}
            <View style={{ flex: 1 }} />

            {/* Right side: Tags + Search columns */}
            <XStack gap="$3" alignItems="flex-start">
              {/* Tags column */}
              {allTags.length > 0 && (
                <YStack gap="$1">
                  <Text fontSize={11} color="$color" opacity={0.5} fontWeight="600">
                    Tags
                  </Text>
                  <TouchableOpacity
                    onPress={() => setShowTagFilterDropdown(!showTagFilterDropdown)}
                    style={{
                      backgroundColor:
                        activeTagFilters.size > 0
                          ? 'rgba(139,92,246,0.2)'
                          : 'rgba(255,255,255,0.05)',
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
                          : 'rgba(255,255,255,0.1)',
                    }}
                  >
                    <Filter size={12} color={activeTagFilters.size > 0 ? '#A78BFA' : '#9CA3AF'} />
                    {activeTagFilters.size > 0 && (
                      <View
                        style={{
                          backgroundColor: '#8B5CF6',
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
                <Text fontSize={11} color="$color" opacity={0.5} fontWeight="600">
                  Search
                </Text>
                <XStack gap="$2" alignItems="center">
                  <View
                    style={{
                      backgroundColor: 'rgba(255,255,255,0.05)',
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: searchQuery ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.1)',
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      gap: 4,
                      minWidth: 150,
                    }}
                  >
                    <Search size={12} color={searchQuery ? '#A78BFA' : '#9CA3AF'} />
                    <TextInput
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Buscar..."
                      placeholderTextColor="#666"
                      style={{ flex: 1, fontSize: 11, color: 'white', padding: 0, outline: 'none' }}
                    />
                    {searchQuery && (
                      <TouchableOpacity onPress={() => setSearchQuery('')} style={{ padding: 2 }}>
                        <X size={10} color="#9CA3AF" />
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
                        backgroundColor: 'rgba(239,68,68,0.15)',
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        borderRadius: 6,
                      }}
                    >
                      <X size={12} color="#EF4444" />
                    </TouchableOpacity>
                  )}
                </XStack>
              </YStack>
            </XStack>

            {/* Supervisor picker dropdown */}
            {showSupervisorPicker && !activeSupervisorChannelId && (
              <View
                style={{
                  position: 'absolute',
                  top: 40,
                  left: 12,
                  backgroundColor: '#1F2937',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(139,92,246,0.3)',
                  maxHeight: 200,
                  zIndex: 1000,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.3,
                  shadowRadius: 8,
                  minWidth: 200,
                }}
              >
                <ScrollView>
                  <TouchableOpacity
                    onPress={() => {
                      setSelectedSupervisorId(null);
                      setShowSupervisorPicker(false);
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderBottomWidth: 1,
                      borderBottomColor: 'rgba(255,255,255,0.1)',
                    }}
                  >
                    <Text fontSize={13} color="$color" opacity={0.5}>
                      (Sin supervisor)
                    </Text>
                  </TouchableOpacity>
                  {Object.entries(globalAgentMap).map(([agentId, agent]) => (
                    <TouchableOpacity
                      key={agentId}
                      onPress={() => {
                        setSelectedSupervisorId(agentId);
                        setShowSupervisorPicker(false);
                      }}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderBottomWidth: 1,
                        borderBottomColor: 'rgba(255,255,255,0.1)',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        backgroundColor:
                          selectedSupervisorId === agentId ? 'rgba(139,92,246,0.1)' : 'transparent',
                      }}
                    >
                      {agent.avatarUrl ? (
                        <View
                          style={{ width: 20, height: 20, borderRadius: 10, overflow: 'hidden' }}
                        >
                          <img
                            src={agent.avatarUrl}
                            style={{ width: 20, height: 20, borderRadius: 10, objectFit: 'cover' }}
                          />
                        </View>
                      ) : (
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            backgroundColor: 'rgba(139,92,246,0.25)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text fontSize={11} color="#8B5CF6" fontWeight="700">
                            {agent.name[0]}
                          </Text>
                        </View>
                      )}
                      <Text fontSize={13} color="$color">
                        {agent.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </XStack>

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
          <Text fontSize={14} color="$color" opacity={0.4}>
            Selecciona un proyecto
          </Text>
        </YStack>
      );
    }

    return null;
  };

  const closeDropdowns = useCallback(() => {
    setShowWorkspacePicker(false);
    setShowProjectPicker(false);
  }, []);

  // ========================================================================
  // RENDER: MAIN LAYOUT
  // ========================================================================

  return (
    <Pressable onPress={closeDropdowns} style={{ flex: 1 }}>
      <YStack flex={1} backgroundColor="$background">
        {/* ================================================================ */}
        {/* HEADER BAR */}
        {/* ================================================================ */}
        <XStack
          paddingHorizontal="$3"
          paddingVertical="$2"
          alignItems="center"
          borderBottomWidth={1}
          borderBottomColor="rgba(255,255,255,0.06)"
          gap="$2"
        >
          {/* Workspace selector */}
          <TouchableOpacity
            onPress={() => {
              setShowWorkspacePicker(!showWorkspacePicker);
              setShowProjectPicker(false);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              backgroundColor: 'rgba(255,255,255,0.06)',
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 6,
            }}
          >
            <SquareKanban size={13} color="#8B5CF6" />
            <Text
              fontSize={12}
              fontWeight="500"
              color="$color"
              opacity={0.7}
              numberOfLines={1}
              maxWidth={140}
            >
              {workspaces.find((w) => w.workspaceId === workspaceId)?.name || 'Workspace'}
            </Text>
            <ChevronDown size={12} color="#8B5CF6" />
          </TouchableOpacity>

          {/* Breadcrumb separator */}
          <Text fontSize={12} color="$color" opacity={0.2}>
            /
          </Text>

          {/* Project selector */}
          <TouchableOpacity
            onPress={() => {
              setShowProjectPicker(!showProjectPicker);
              setShowWorkspacePicker(false);
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
            <Folder size={13} color="#8B5CF6" />
            <Text fontSize={12} fontWeight="600" color="$color" numberOfLines={1} maxWidth={160}>
              {currentProject?.name || 'Seleccionar proyecto'}
            </Text>
            <ChevronDown size={12} color="#8B5CF6" />
          </TouchableOpacity>

          <View style={{ flex: 1 }} />

          {/* Task count */}
          {board && (
            <Text fontSize={12} color="$color" opacity={0.4}>
              {tasks.length} tarea{tasks.length !== 1 ? 's' : ''}
            </Text>
          )}

          {/* New project button */}
          <TouchableOpacity onPress={() => setShowCreateProject(true)} style={{ padding: 4 }}>
            <Plus size={16} color="#8B5CF6" />
          </TouchableOpacity>
        </XStack>

        {/* Workspace picker dropdown */}
        {showWorkspacePicker && (
          <YStack
            position="absolute"
            top={44}
            left={12}
            zIndex={100}
            backgroundColor="$background"
            borderRadius={8}
            borderWidth={1}
            borderColor="rgba(255,255,255,0.1)"
            padding="$1"
            minWidth={220}
            shadowColor="black"
            shadowOpacity={0.3}
            shadowRadius={8}
            elevation={5}
          >
            {workspaces.map((w) => (
              <TouchableOpacity
                key={w.workspaceId}
                onPress={() => {
                  setWorkspaceId(w.workspaceId);
                  setCurrentProject(null);
                  setShowWorkspacePicker(false);
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 6,
                  backgroundColor:
                    w.workspaceId === workspaceId ? 'rgba(139,92,246,0.15)' : 'transparent',
                }}
              >
                <Text
                  fontSize={13}
                  color="$color"
                  fontWeight={w.workspaceId === workspaceId ? '600' : '400'}
                >
                  {w.name}
                </Text>
              </TouchableOpacity>
            ))}
          </YStack>
        )}

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
            borderColor="rgba(255,255,255,0.1)"
            padding="$1"
            minWidth={220}
            shadowColor="black"
            shadowOpacity={0.3}
            shadowRadius={8}
            elevation={5}
          >
            {projects.length === 0 ? (
              <YStack paddingHorizontal={12} paddingVertical={8}>
                <Text fontSize={12} color="$color" opacity={0.4}>
                  No hay proyectos en este workspace
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
                      p.projectId === currentProjectId ? 'rgba(139,92,246,0.15)' : 'transparent',
                  }}
                >
                  <Text
                    fontSize={13}
                    color="$color"
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
            borderBottomColor="rgba(255,255,255,0.06)"
          >
            <TextInput
              value={newProjectName}
              onChangeText={setNewProjectName}
              placeholder="Nombre del proyecto..."
              placeholderTextColor="#999"
              autoFocus
              onSubmitEditing={handleCreateProject}
              style={{
                flex: 1,
                backgroundColor: 'rgba(255,255,255,0.06)',
                borderRadius: 6,
                paddingHorizontal: 10,
                paddingVertical: 6,
                color: 'white',
                fontSize: 13,
              }}
            />
            <TouchableOpacity onPress={handleCreateProject}>
              <Check size={18} color="#22C55E" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setShowCreateProject(false);
                setNewProjectName('');
              }}
            >
              <X size={18} color="#EF4444" />
            </TouchableOpacity>
          </XStack>
        )}

        {/* ================================================================ */}
        {/* BOARD CONTENT */}
        {/* ================================================================ */}

        {renderBoardContent()}

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
            onDeleteTask={handleDeleteTask}
            onOpenConversation={handleOpenConversation}
            onAssignTask={handleAssignTask}
            onStartTask={handleStartTask}
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
              backgroundColor: '#111827',
              borderRadius: 8,
              borderWidth: 1,
              borderColor: 'rgba(139,92,246,0.3)',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.5,
              shadowRadius: 16,
              minWidth: 220,
              maxHeight: 320,
              elevation: 20,
            }}
          >
            <ScrollView style={{ maxHeight: 320 }}>
              <YStack padding="$2" gap="$1">
                {allTags.map((tag) => {
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
                        backgroundColor: isActive ? 'rgba(139,92,246,0.2)' : 'transparent',
                      }}
                    >
                      {/* Checkbox */}
                      <View
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 4,
                          borderWidth: 2,
                          borderColor: isActive ? '#8B5CF6' : 'rgba(255,255,255,0.3)',
                          backgroundColor: isActive ? '#8B5CF6' : 'transparent',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {isActive && <Check size={14} color="white" />}
                      </View>
                      <Text
                        fontSize={13}
                        color="$color"
                        opacity={isActive ? 1 : 0.7}
                        fontWeight={isActive ? '600' : '400'}
                        flex={1}
                      >
                        {tag}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </YStack>
            </ScrollView>
          </View>
        </>
      )}
    </Pressable>
  );
}

