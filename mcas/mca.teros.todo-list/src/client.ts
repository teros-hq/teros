/**
 * Todo List MCA — backend action client.
 *
 * The MCA holds NO datastore connection. Every tool and UI resource forwards
 * to a named backend action (`todo/<action>`) through the authenticated
 * callback (`context.backend.invokeAction`); the backend resolves the
 * workspace from the verified token and executes the action against
 * `todo_nodes` (datastore-isolation P1b). Nothing here sends `workspaceId`.
 */

import type { ToolContext } from '@teros/mca-sdk';
import type { TodoEventName, TodoEventPayloads } from './events';

// =============================================================================
// STRUCTURED RESULT
// =============================================================================

export type StructuredResult<T> = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T;
};

/** Same wrapper the former tools produced: JSON text + structuredContent. */
export function structured<T>(data: T): StructuredResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

// =============================================================================
// ERRORS
// =============================================================================

/** Error body the backend action dispatcher answers with on failure. */
interface ActionErrorBody {
  error?: string;
  code?: string;
  suggestion?: string;
}

/**
 * Rebuild the `[CODE] message suggestion` Error string the former tools threw
 * (TodoListRenderer strips the `[CODE]` prefix; tests match on it) from the
 * dispatcher's `{ error, code, suggestion? }` body. Anything that is not a
 * structured action failure (timeout, network) is rethrown untouched.
 */
export function toToolError(error: unknown): never {
  const response = (error as { response?: unknown } | null)?.response;
  if (response && typeof response === 'object') {
    const body = response as ActionErrorBody;
    if (typeof body.error === 'string') {
      const code = body.code ?? 'BACKEND_ERROR';
      const suggestion = body.suggestion ? ` ${body.suggestion}` : '';
      throw new Error(`[${code}] ${body.error}${suggestion}`);
    }
  }
  throw error instanceof Error ? error : new Error(String(error));
}

// =============================================================================
// ACTION INVOCATION
// =============================================================================

/**
 * Invoke `todo/<action>` with the tool args. `workspaceId` is dropped if a
 * caller ever sends one — the backend derives the workspace from the verified
 * token and ignores any body value anyway.
 */
export async function invoke<T = unknown>(
  context: ToolContext,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const backend = context.backend;
  if (!backend) {
    throw new Error(
      '[NO_BACKEND_CONTEXT] todo-list requires the backend callback (no callbackUrl in execution context). This is an SDK/host bug, not a user error.',
    );
  }
  const { workspaceId: _ignored, ...body } = args;
  try {
    return (await backend.invokeAction(`todo/${action}`, body)) as T;
  } catch (error) {
    return toToolError(error);
  }
}

// =============================================================================
// EVENT EMISSION (best-effort, unchanged from the former _shared.ts)
// =============================================================================

/**
 * Emit an event to the host via the backend client. If the backend client is
 * unavailable (e.g. standalone mode), the emit is a no-op — events are
 * best-effort, never blocking, never failing a tool call.
 */
export function emitEvent<K extends TodoEventName>(
  context: ToolContext,
  eventName: K,
  payload: TodoEventPayloads[K],
): void {
  try {
    const backend = context.backend;
    if (backend && typeof backend.emitEvent === 'function') {
      const result: unknown = backend.emitEvent(eventName, payload);
      // A rejected promise must not surface as an unhandled rejection.
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(() => {});
      }
    } else {
      console.error(`[Todo List MCA] event: ${eventName}`, JSON.stringify(payload));
    }
  } catch {
    // Events are best-effort — never let emission failure break a tool call
  }
}
