/**
 * Board Store - Zustand store for Teros Boards
 *
 * Manages projects, boards, and tasks state for the Kanban board UI.
 *
 * Uses a per-instance store factory pattern so that multiple BoardWindow
 * instances (e.g. in a split pane layout) each maintain independent state,
 * keyed by their windowId.
 */

import { create } from 'zustand';

// ============================================================================
// TYPES
// ============================================================================

export interface BoardColumn {
  columnId: string;
  name: string;
  slug: string;
  position: number;
}

export interface Board {
  boardId: string;
  projectId: string;
  columns: BoardColumn[];
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = 'idle' | 'assigned' | 'working' | 'blocked' | 'review' | 'done' | 'circular_dependency';

export interface ProgressNote {
  text: string;
  actor: string;
  timestamp: string;
}

export interface Task {
  taskId: string;
  boardId: string;
  columnId: string;
  position: number;
  title: string;
  description?: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  taskStatus: TaskStatus;
  running: boolean;
  tags: string[];
  assignedAgentId?: string;
  channelId?: string;
  originChannelId?: string;
  parentTaskId?: string;
  /**
   * IDs of tasks that must be completed before this task can start.
   * Empty array means no dependencies (task is unblocked).
   */
  dependencies: string[];
  progressNotes: ProgressNote[];
  activity: Array<{
    eventType: string;
    actor: string;
    timestamp: string;
    details?: Record<string, any>;
  }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  projectId: string;
  workspaceId: string;
  name: string;
  description?: string;
  createdBy: string;
  boardId: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// STORE INTERFACE
// ============================================================================

interface BoardState {
  // Current context
  currentWorkspaceId: string | null;
  currentProjectId: string | null;

  // Data
  projects: Project[];
  board: Board | null;
  tasks: Task[];

  // UI state
  isLoadingProjects: boolean;
  isLoadingBoard: boolean;
  isCreatingProject: boolean;
  isCreatingTask: boolean;
  selectedTaskId: string | null;
  draggedTaskId: string | null;

  // Actions
  setCurrentWorkspace: (workspaceId: string | null) => void;
  setCurrentProject: (projectId: string | null) => void;
  setProjects: (projects: Project[]) => void;
  setBoard: (board: Board | null) => void;
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  addTasks: (tasks: Task[]) => void;
  updateTaskInStore: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setSelectedTask: (taskId: string | null) => void;
  setDraggedTask: (taskId: string | null) => void;
  setLoadingProjects: (loading: boolean) => void;
  setLoadingBoard: (loading: boolean) => void;
  setCreatingProject: (creating: boolean) => void;
  setCreatingTask: (creating: boolean) => void;
  addProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  reset: () => void;
}

const initialState = {
  currentWorkspaceId: null,
  currentProjectId: null,
  projects: [],
  board: null,
  tasks: [],
  isLoadingProjects: false,
  isLoadingBoard: false,
  isCreatingProject: false,
  isCreatingTask: false,
  selectedTaskId: null,
  draggedTaskId: null,
};

// ============================================================================
// STORE FACTORY (per-instance, keyed by windowId)
// ============================================================================

type BoardStoreInstance = ReturnType<typeof createBoardStore>;

/** Map from windowId → store instance */
const storeRegistry = new Map<string, BoardStoreInstance>();

/** Create a new Zustand store instance for a given windowId */
function createBoardStore() {
  return create<BoardState>((set) => ({
    ...initialState,

    setCurrentWorkspace: (workspaceId) => set({ currentWorkspaceId: workspaceId }),
    setCurrentProject: (projectId) => set({ currentProjectId: projectId }),
    setProjects: (projects) => set({ projects }),
    setBoard: (board) => set({ board }),
    setTasks: (tasks) => set({ tasks }),

    addTask: (task) =>
      set((state) => {
        if (state.tasks.some((t) => t.taskId === task.taskId)) return state;
        return { tasks: [...state.tasks, task] };
      }),

    addTasks: (tasks) =>
      set((state) => {
        const existingIds = new Set(state.tasks.map((t) => t.taskId));
        const newTasks = tasks.filter((t) => !existingIds.has(t.taskId));
        if (newTasks.length === 0) return state;
        return { tasks: [...state.tasks, ...newTasks] };
      }),

    updateTaskInStore: (updatedTask) =>
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.taskId === updatedTask.taskId ? updatedTask : t,
        ),
      })),

    removeTask: (taskId) =>
      set((state) => ({
        tasks: state.tasks.filter((t) => t.taskId !== taskId),
        selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
      })),

    setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),
    setDraggedTask: (taskId) => set({ draggedTaskId: taskId }),
    setLoadingProjects: (loading) => set({ isLoadingProjects: loading }),
    setLoadingBoard: (loading) => set({ isLoadingBoard: loading }),
    setCreatingProject: (creating) => set({ isCreatingProject: creating }),
    setCreatingTask: (creating) => set({ isCreatingTask: creating }),

    addProject: (project) =>
      set((state) => ({ projects: [...state.projects, project] })),

    removeProject: (projectId) =>
      set((state) => ({
        projects: state.projects.filter((p) => p.projectId !== projectId),
        currentProjectId: state.currentProjectId === projectId ? null : state.currentProjectId,
      })),

    reset: () => set(initialState),
  }));
}

/**
 * Get or create a board store instance for the given windowId.
 * Each BoardWindow instance gets its own isolated store so that
 * multiple boards in split panes don't interfere with each other.
 */
export function getBoardStore(windowId: string): BoardStoreInstance {
  if (!storeRegistry.has(windowId)) {
    storeRegistry.set(windowId, createBoardStore());
  }
  return storeRegistry.get(windowId)!;
}

/**
 * Destroy the board store instance for a given windowId.
 * Should be called when a BoardWindow unmounts to free memory.
 */
export function destroyBoardStore(windowId: string): void {
  storeRegistry.delete(windowId);
}

/**
 * Hook to use the board store for a specific window instance.
 * This is the primary API for BoardWindowContent.
 */
export function useBoardStore(windowId: string): BoardState {
  const store = getBoardStore(windowId);
  return store();
}

// ============================================================================
// SELECTORS
// ============================================================================

/** Get tasks grouped by column, sorted by position */
export function getTasksByColumn(tasks: Task[], columns: BoardColumn[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const col of columns) {
    map.set(col.columnId, []);
  }
  for (const task of tasks) {
    const list = map.get(task.columnId);
    if (list) {
      list.push(task);
    }
  }
  // Sort each column by position
  for (const [, list] of map) {
    list.sort((a, b) => a.position - b.position);
  }
  return map;
}

/** Priority display config */
export const PRIORITY_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  urgent: { label: 'Urgente', color: '#EF4444', bg: 'rgba(239,68,68,0.15)', icon: '!!!!' },
  high: { label: 'Alta', color: '#F97316', bg: 'rgba(249,115,22,0.15)', icon: '!!!' },
  medium: { label: 'Media', color: '#EAB308', bg: 'rgba(234,179,8,0.15)', icon: '!!' },
  low: { label: 'Baja', color: '#22C55E', bg: 'rgba(34,197,94,0.15)', icon: '!' },
};
