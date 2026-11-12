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
import type { BoardFeedEvent } from '../services/BoardApi';

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

export interface ProgressNote {
  text: string;
  actor: string;
  timestamp: string;
}

/** A typed value attached to a task: its input or its deliverable. */
export interface TaskArtifact {
  /** Artifact type id — null when untyped; "markdown" is the built-in free-text type. */
  schemaId: string | null;
  /** Snapshot of the artifact schema (form-first) taken when the task was created. */
  schema?: Record<string, unknown>;
  /** The value. */
  data?: unknown;
}

export interface Task {
  taskId: string;
  boardId: string;
  columnId: string;
  position: number;
  title: string;
  description?: string;
  instructions?: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  archived: boolean;
  running: boolean;
  tags: string[];
  assignedAgentId?: string;
  channelId?: string;
  originChannelId?: string;
  parentTaskId?: string;
  /** True when a manager has requested the runner to stop this task cooperatively */
  stopRequested?: boolean;
  /**
   * IDs of tasks that must be completed before this task can start.
   * Empty array means no dependencies (task is unblocked).
   */
  dependencies: string[];
  /**
   * Progress notes. NOTE: board list payloads (board.get / board.list-tasks)
   * strip these via TASK_LIST_PROJECTION — they are only present after the
   * detail hydration (board.get-task) or in full-doc responses.
   */
  progressNotes?: ProgressNote[];
  /**
   * Activity log. Same as progressNotes: stripped from list payloads by the
   * large-board projection; present after detail hydration.
   */
  activity?: Array<{
    eventType: string;
    actor: string;
    timestamp: string;
    details?: Record<string, any>;
  }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Artifacts (docs/specs/tasks/artifacts.md) — owned by the task
  /** What the task receives (event payload, upstream flow data, …) */
  input?: TaskArtifact;
  /** What the task delivers (form answers, report, structured output, …) */
  output?: TaskArtifact;
  // Workflow linkage — only present when created by the workflow engine
  /** Input gate from the workflow node (routing metadata) */
  workflowInputGate?: Record<string, unknown>;
  /** Output gate from the workflow node (routing metadata) */
  workflowOutputGate?: Record<string, unknown>;
  /** Reference to the workflow execution that created this task */
  workflowExecutionId?: string;
  /** Reference to the workflow node that created this task */
  workflowNodeId?: string;
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
  /** Activity feed events from board_events collection (null = not loaded, undefined = loading) */
  boardFeed: BoardFeedEvent[] | null;

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
  setBoardFeed: (feed: BoardFeedEvent[] | null) => void;
  addTask: (task: Task) => void;
  addTasks: (tasks: Task[]) => void;
  updateTaskInStore: (task: Task) => void;
  /**
   * Merge a hydrated (full) task doc into the list. Board list payloads strip
   * detail-only fields (instructions, progressNotes, activity, input/output —
   * TASK_LIST_PROJECTION); the detail panel fetches the full doc via
   * board.get-task and merges it here. Only fills in missing heavy fields —
   * it never overwrites fields already present, so live updates (which carry
   * full docs) are preserved.
   */
  hydrateTask: (task: Task) => void;
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
  boardFeed: null,
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
    setBoardFeed: (feed) => set({ boardFeed: feed }),

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

    hydrateTask: (fullTask) =>
      set((state) => ({
        tasks: state.tasks.map((t) => {
          if (t.taskId !== fullTask.taskId) return t;
          // Fill in only fields missing from the light list doc — never
          // overwrite what's already there (live updates carry fresh values).
          const merged: Task = { ...t };
          const heavyFields = [
            "instructions",
            "progressNotes",
            "activity",
            "input",
            "output",
            "workflowInputData",
            "workflowOutputData",
          ] as const;
          for (const f of heavyFields) {
            const current = (t as unknown as Record<string, unknown>)[f];
            if (current === undefined || current === null) {
              const incoming = (fullTask as unknown as Record<string, unknown>)[f];
              if (incoming !== undefined) {
                (merged as unknown as Record<string, unknown>)[f] = incoming;
              }
            }
          }
          return merged;
        }),
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
      set((state) =>
        state.projects.some((p) => p.projectId === project.projectId)
          ? state
          : { projects: [...state.projects, project] },
      ),

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
 * Reset ALL board store instances (used on logout).
 * Iterates the registry and calls reset() on every active instance.
 */
export function resetAllBoardStores(): void {
  for (const [, store] of storeRegistry) {
    store.getState().reset();
  }
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

// ── Session lifecycle registration ──────────────────────────────────────────
// @todo nira - 2026-05-20: migrate to createSessionStore once circular deps resolved

import { storeRegistry as sessionStoreRegistry } from './session/StoreRegistry'

sessionStoreRegistry.register('board', {
  resetSession: () => {
    resetAllBoardStores()
    // Clear the internal instance registry so next session starts fresh
    storeRegistry.clear()
  },
})
