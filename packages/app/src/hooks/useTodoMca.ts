/**
 * useTodoMca - Specific hook for the Todo MCA
 *
 * Built on top of useMcaTools, provides a typed and convenient API
 * for managing lists and tasks.
 *
 * Requires the user to have the Todo MCA installed and access to it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useMcaTools } from './useMcaTools';

// ============================================================================
// TYPES
// ============================================================================

export interface Task {
  id: string;
  title: string;
  status: 'inbox' | 'active' | 'working' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  focus: boolean;
  notes?: string;
  tags?: string[];
  due_date?: number;
  list_id: string;
  parent_id?: string;
  order: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface TaskList {
  id: string;
  name: string;
  icon: 'inbox' | 'folder' | 'target';
  is_default?: boolean;
  order: number;
  created_at: string;
  updated_at: string;
}

export interface TaskStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  focus: number;
}

// ============================================================================
// HOOK
// ============================================================================

interface UseTodoMcaOptions {
  /** Auto-load lists and tasks on mount */
  autoLoad?: boolean;
}

export function useTodoMca(appId: string, options: UseTodoMcaOptions = {}) {
  const { autoLoad = true } = options;

  const [lists, setLists] = useState<TaskList[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [initialLoading, setInitialLoading] = useState(autoLoad);

  const { executeTool, loading: toolLoading, error, clearError } = useMcaTools(appId);

  // ============================================================================
  // LIST OPERATIONS
  // ============================================================================

  const loadLists = useCallback(async () => {
    console.log('[useTodoMca] loadLists called, appId:', appId);
    try {
      console.log('[useTodoMca] Calling executeTool list-list...');
      const result = await executeTool<{ lists: TaskList[] }>('list-list', {});
      console.log('[useTodoMca] list-list result:', JSON.stringify(result, null, 2));
      if (result.success && result.result.lists) {
        console.log('[useTodoMca] Setting lists:', result.result.lists.length);
        setLists(result.result.lists);
      } else {
        console.warn('[useTodoMca] list-list returned success=false or no lists:', result);
      }
      return result.result.lists || [];
    } catch (err) {
      console.error('[useTodoMca] Failed to load lists:', err);
      throw err;
    }
  }, [executeTool, appId]);

  const createList = useCallback(
    async (data: { name: string; icon?: 'inbox' | 'folder' | 'target' }) => {
      try {
        const result = await executeTool<{ list: TaskList; lists: TaskList[] }>('list-create', data);
        if (result.success) {
          // Use the full lists array from backend if available
          if (result.result.lists) {
            setLists(result.result.lists);
          } else if (result.result.list) {
            // Fallback to appending new item
            setLists((prev) => [...prev, result.result.list]);
          }
        }
        return result.result.list;
      } catch (err) {
        console.error('[useTodoMca] Failed to create list:', err);
        throw err;
      }
    },
    [executeTool],
  );

  const updateList = useCallback(
    async (listId: string, data: { name?: string; icon?: 'inbox' | 'folder' | 'target' }) => {
      try {
        const result = await executeTool<{ list: TaskList; lists: TaskList[] }>('list-update', { listId, ...data });
        if (result.success) {
          // Use the full lists array from backend if available
          if (result.result.lists) {
            setLists(result.result.lists);
          } else if (result.result.list) {
            // Fallback to updating single item
            setLists((prev) => prev.map((l) => (l.id === listId ? result.result.list : l)));
          }
        }
        return result.result.list;
      } catch (err) {
        console.error('[useTodoMca] Failed to update list:', err);
        throw err;
      }
    },
    [executeTool],
  );

  const deleteList = useCallback(
    async (listId: string) => {
      try {
        const result = await executeTool<{ success: boolean; lists: TaskList[] }>('list-delete', { listId });
        if (result.success) {
          // Use the full lists array from backend if available
          if (result.result.lists) {
            setLists(result.result.lists);
          } else {
            // Fallback to filtering out the deleted item
            setLists((prev) => prev.filter((l) => l.id !== listId));
          }
          // Also remove tasks from this list
          setTasks((prev) => prev.filter((t) => t.list_id !== listId));
        }
        return result.result.success;
      } catch (err) {
        console.error('[useTodoMca] Failed to delete list:', err);
        throw err;
      }
    },
    [executeTool],
  );

  // ============================================================================
  // TASK OPERATIONS
  // ============================================================================

  const loadTasks = useCallback(
    async (listId?: string, focus?: boolean) => {
      console.log('[useTodoMca] loadTasks called, listId:', listId, 'focus:', focus);
      try {
        const input: Record<string, any> = {};
        if (listId) input.listId = listId;
        if (focus !== undefined) input.focus = focus;

        console.log('[useTodoMca] Calling executeTool todo-list with input:', input);
        const result = await executeTool<{ tasks: Task[] }>('todo-list', input);
        console.log('[useTodoMca] todo-list result success:', result.success, 'tasks count:', result.result?.tasks?.length);
        if (result.success && result.result.tasks) {
          setTasks(result.result.tasks);
        } else {
          console.warn('[useTodoMca] todo-list returned success=false or no tasks:', result);
        }
        return result.result.tasks || [];
      } catch (err) {
        console.error('[useTodoMca] Failed to load tasks:', err);
        throw err;
      }
    },
    [executeTool],
  );

  const createTask = useCallback(
    async (data: {
      title: string;
      listId?: string;
      parentId?: string;
      status?: Task['status'];
      priority?: Task['priority'];
      focus?: boolean;
      notes?: string;
      tags?: string[];
      dueDate?: number;
    }) => {
      try {
        const result = await executeTool<{ task: Task; tasks?: Task[] }>('todo-create', data);
        if (result.success) {
          // If backend returns full tasks array, use it
          if (result.result.tasks) {
            console.log('[useTodoMca] Using tasks array from backend:', result.result.tasks.length);
            setTasks(result.result.tasks);
          } else if (result.result.task) {
            console.log('[useTodoMca] Using single task fallback');
            setTasks((prev) => [...prev, result.result.task]);
          }
        }
        return result.result.task;
      } catch (err) {
        console.error('[useTodoMca] Failed to create task:', err);
        throw err;
      }
    },
    [executeTool],
  );

  const updateTask = useCallback(
    async (
      taskId: string,
      data: {
        title?: string;
        status?: Task['status'];
        priority?: Task['priority'];
        focus?: boolean;
        notes?: string;
        tags?: string[];
        dueDate?: number;
      },
    ) => {
      try {
        const result = await executeTool<{ task: Task; tasks: Task[] }>('todo-update', { taskId, ...data });
        if (result.success) {
          // Use the full tasks array from backend if available
          if (result.result.tasks) {
            setTasks(result.result.tasks);
          } else if (result.result.task) {
            // Fallback to updating single item
            setTasks((prev) => prev.map((t) => (t.id === taskId ? result.result.task : t)));
          }
        }
        return result.result.task;
      } catch (err) {
        console.error('[useTodoMca] Failed to update task:', err);
        throw err;
      }
    },
    [executeTool],
  );

  const completeTask = useCallback(
    async (taskId: string) => {
      try {
        const result = await executeTool<{ task: Task; tasks: Task[] }>('todo-complete', { taskId });
        if (result.success) {
          // Use the full tasks array from backend if available
          if (result.result.tasks) {
            setTasks(result.result.tasks);
          } else if (result.result.task) {
            // Fallback to updating single item
            setTasks((prev) => prev.map((t) => (t.id === taskId ? result.result.task : t)));
          }
        }
        return result.result.task;
      } catch (err) {
        console.error('[useTodoMca] Failed to complete task:', err);
        throw err;
      }
    },
    [executeTool],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      try {
        const result = await executeTool<{ success: boolean; tasks: Task[] }>('todo-delete', { taskId });
        if (result.success) {
          // Use the full tasks array from backend if available
          if (result.result.tasks) {
            setTasks(result.result.tasks);
          } else {
            // Fallback to filtering out deleted item and subtasks
            setTasks((prev) => prev.filter((t) => t.id !== taskId && t.parent_id !== taskId));
          }
        }
        return result.result.success;
      } catch (err) {
        console.error('[useTodoMca] Failed to delete task:', err);
        throw err;
      }
    },
    [executeTool],
  );

  const reorderTask = useCallback(
    async (
      taskId: string,
      data: {
        order?: number;
        parentId?: string | null;
        listId?: string;
      },
    ) => {
      try {
        const result = await executeTool<{ task: Task }>('todo-reorder', { taskId, ...data });
        if (result.success && result.result.task) {
          setTasks((prev) => prev.map((t) => (t.id === taskId ? result.result.task : t)));
        }
        return result.result.task;
      } catch (err) {
        console.error('[useTodoMca] Failed to reorder task:', err);
        throw err;
      }
    },
    [executeTool],
  );

  // ============================================================================
  // STATS
  // ============================================================================

  const loadStats = useCallback(async () => {
    try {
      const result = await executeTool<TaskStats>('todo-stats', {});
      if (result.success) {
        setStats(result.result);
      }
      return result.result;
    } catch (err) {
      console.error('[useTodoMca] Failed to load stats:', err);
      throw err;
    }
  }, [executeTool]);

  // ============================================================================
  // BATCH OPERATIONS
  // ============================================================================

  const batchOperation = useCallback(
    async (operations: {
      create?: Array<Omit<Parameters<typeof createTask>[0], 'never'>>;
      update?: Array<{ taskId: string } & Parameters<typeof updateTask>[1]>;
      delete?: string[];
    }) => {
      try {
        const result = await executeTool<{ tasks: Task[] }>('todo-batch', operations);
        if (result.success && result.result.tasks) {
          setTasks(result.result.tasks);
        }
        return result.result.tasks;
      } catch (err) {
        console.error('[useTodoMca] Failed batch operation:', err);
        throw err;
      }
    },
    [executeTool],
  );

  // ============================================================================
  // INITIAL LOAD
  // ============================================================================

  useEffect(() => {
    console.log('[useTodoMca] useEffect triggered, autoLoad:', autoLoad);
    if (!autoLoad) return;

    const init = async () => {
      console.log('[useTodoMca] Initializing - loading lists and tasks...');
      try {
        await Promise.all([loadLists(), loadTasks()]);
        console.log('[useTodoMca] Initialization complete');
      } catch (err) {
        console.error('[useTodoMca] Failed to initialize:', err);
      } finally {
        setInitialLoading(false);
      }
    };

    init();
  }, [autoLoad, loadLists, loadTasks]);

  // ============================================================================
  // RETURN
  // ============================================================================

  return {
    // State
    lists,
    tasks,
    stats,
    loading: initialLoading || toolLoading,
    error,
    clearError,

    // List operations
    loadLists,
    createList,
    updateList,
    deleteList,

    // Task operations
    loadTasks,
    createTask,
    updateTask,
    completeTask,
    deleteTask,
    reorderTask,

    // Stats
    loadStats,

    // Batch
    batchOperation,

    // Raw tool execution (for advanced use cases)
    executeTool,
  };
}
