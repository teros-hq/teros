/**
 * useMcaTools - Generic hook for direct MCA tool execution
 *
 * Provides a simple interface to execute MCA tools directly from the frontend,
 * without going through the agent/LLM. Used by UI views (Tasks, Calendar, etc.)
 *
 * Usage:
 * ```tsx
 * const { executeTool, loading, error } = useMcaTools(appId);
 *
 * // Execute a tool
 * const result = await executeTool('todo-list', {});
 * const task = await executeTool('todo-create', { title: 'New task' });
 * ```
 */

import { useCallback, useState } from 'react';
import { getTerosClient } from '../../app/_layout';

interface UseMcaToolsOptions {
  /** Called when a tool execution starts */
  onExecuteStart?: (tool: string) => void;
  /** Called when a tool execution completes successfully */
  onExecuteSuccess?: (tool: string, result: any) => void;
  /** Called when a tool execution fails */
  onExecuteError?: (tool: string, error: Error) => void;
}

interface UseMcaToolsReturn {
  /** Execute a tool on the MCA */
  executeTool: <T = any>(
    tool: string,
    input?: Record<string, any>,
  ) => Promise<{ success: boolean; result: T; mcaId: string }>;
  /** Whether a tool is currently executing */
  loading: boolean;
  /** The name of the currently executing tool (if any) */
  executingTool: string | null;
  /** Last error that occurred */
  error: Error | null;
  /** Clear the error state */
  clearError: () => void;
}

/**
 * Hook for executing MCA tools directly from the frontend.
 *
 * @param appId - The app ID (installed MCA instance)
 * @param options - Optional callbacks for tool execution lifecycle
 * @returns Object with executeTool function and state
 */
export function useMcaTools(appId: string, options?: UseMcaToolsOptions): UseMcaToolsReturn {
  const [loading, setLoading] = useState(false);
  const [executingTool, setExecutingTool] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const client = getTerosClient();

  const executeTool = useCallback(
    async <T = any>(
      tool: string,
      input: Record<string, any> = {},
    ): Promise<{ success: boolean; result: T; mcaId: string }> => {
      setLoading(true);
      setExecutingTool(tool);
      setError(null);

      options?.onExecuteStart?.(tool);

      try {
        console.log('[useMcaTools] Executing tool:', tool, 'on appId:', appId, 'with input:', input);
        const result = await client.executeTool<T>(appId, tool, input);
        console.log('[useMcaTools] Tool execution result:', { success: result.success, mcaId: result.mcaId });

        if (!result.success) {
          // Tool returned an error in its result
          const errorMessage =
            typeof result.result === 'object' && result.result !== null
              ? (result.result as any).error || (result.result as any).message || 'Tool execution failed'
              : 'Tool execution failed';
          console.error('[useMcaTools] Tool execution failed:', errorMessage, 'result:', result);
          throw new Error(errorMessage);
        }

        options?.onExecuteSuccess?.(tool, result.result);
        return result;
      } catch (err) {
        console.error('[useMcaTools] Exception during tool execution:', err);
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        options?.onExecuteError?.(tool, error);
        throw error;
      } finally {
        setLoading(false);
        setExecutingTool(null);
      }
    },
    [appId, client, options],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    executeTool,
    loading,
    executingTool,
    error,
    clearError,
  };
}

/**
 * Type helper for creating typed tool execution hooks.
 *
 * Example:
 * ```tsx
 * // Define tool types
 * interface TodoTools {
 *   'todo-list': { input: { listId?: string }; output: { tasks: Task[] } };
 *   'todo-create': { input: { title: string }; output: { task: Task } };
 * }
 *
 * // Create typed hook
 * const useTodoTools = createTypedMcaToolsHook<TodoTools>();
 *
 * // Use in component
 * const { executeTool } = useTodoTools(appId);
 * const { tasks } = await executeTool('todo-list', {}); // Fully typed!
 * ```
 */
export type ToolDefinitions = Record<string, { input: any; output: any }>;

export function createTypedMcaToolsHook<T extends ToolDefinitions>() {
  return (appId: string, options?: UseMcaToolsOptions) => {
    const tools = useMcaTools(appId, options);

    return {
      ...tools,
      executeTool: async <K extends keyof T>(
        tool: K,
        input: T[K]['input'],
      ): Promise<{ success: boolean; result: T[K]['output']; mcaId: string }> => {
        return tools.executeTool(tool as string, input);
      },
    };
  };
}
