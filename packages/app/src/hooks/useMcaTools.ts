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

import { useCallback, useRef, useState } from 'react';
import { getTerosClient } from '../services/terosClientSingleton';

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

  // @fixme nira - 2026.09.18 : Stabilize options with a ref so executeTool's useCallback
  // identity doesn't change when callers pass inline objects. Without this, any consumer
  // that passes `options={{ onExecuteStart: ... }}` as an inline object would cause
  // executeTool to get a new reference every render, cascading into useEffect re-runs.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const executeTool = useCallback(
    async <T = any>(
      tool: string,
      input: Record<string, any> = {},
    ): Promise<{ success: boolean; result: T; mcaId: string }> => {
      const opts = optionsRef.current;

      setLoading(true);
      setExecutingTool(tool);
      setError(null);

      opts?.onExecuteStart?.(tool);

      try {
        console.log('[useMcaTools] Executing tool:', tool, 'on appId:', appId, 'with input:', input);
        const result = await client.executeTool<T>(appId, tool, input);
        console.log('[useMcaTools] Tool execution result:', { success: result.success, mcaId: result.mcaId });

        if (!result.success) {
          // Tool returned an error in its result
          // Try to extract a structured error message; fall back to raw string
          let errorMessage = 'Tool execution failed';
          if (typeof result.result === 'string') {
            // The MCA may have thrown a JSON error string like:
            // "Error: {"error":true,"code":"FLOW_NOT_FOUND","message":"...","suggestion":"..."}"
            // Try to parse it for a cleaner message
            let cleaned = result.result as string;
            if (cleaned.startsWith('Error: ')) cleaned = cleaned.slice(7);
            try {
              const parsed = JSON.parse(cleaned);
              if (parsed && typeof parsed === 'object' && parsed.message) {
                errorMessage = parsed.suggestion
                  ? `${parsed.message} — ${parsed.suggestion}`
                  : parsed.message;
              } else {
                errorMessage = result.result as string;
              }
            } catch {
              errorMessage = result.result as string;
            }
          } else if (typeof result.result === 'object' && result.result !== null) {
            const obj = result.result as any;
            // Check for structured error object
            if (obj.error === true && obj.message) {
              errorMessage = obj.suggestion ? `${obj.message} — ${obj.suggestion}` : obj.message;
            } else {
              errorMessage = obj.error || obj.message || 'Tool execution failed';
            }
          }
          console.error('[useMcaTools] Tool execution failed:', errorMessage, 'result:', result);
          throw new Error(errorMessage);
        }

        opts?.onExecuteSuccess?.(tool, result.result);
        return result;
      } catch (err) {
        console.error('[useMcaTools] Exception during tool execution:', err);
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        opts?.onExecuteError?.(tool, error);
        throw error;
      } finally {
        setLoading(false);
        setExecutingTool(null);
      }
    },
    // options intentionally excluded — read from optionsRef.current at call time.
    // client is a singleton (getTerosClient returns the same instance), so it's stable.
    [appId, client],
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
