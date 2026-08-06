/**
 * Shared utilities for board-manager MCA tools.
 *
 * Duplica el patrón de `mca.teros.core/src/tools/utils.ts` (YAGNI: no creamos
 * un paquete compartido `@teros/mca-board-shared` para 2 MCAs). Cuando aparezca
 * un 3er MCA del dominio, se promueve.
 */

import { getWsClient, isWsConnected } from '../lib';

// ============================================================================
// FIELD PICKERS
// ============================================================================

/**
 * Devuelve un subset del objeto con solo los campos listados. Ignora campos
 * que no existen en el objeto. Usado para aplicar whitelists (ver _fields.ts)
 * al response del backend antes de entregarlo al LLM.
 */
export function pickFields<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in obj) result[key] = (obj as Record<string, unknown>)[key];
  }
  return result;
}

/**
 * Aplica pickFields a una lista.
 */
export function pickFieldsList<T extends Record<string, unknown>>(
  items: T[],
  fields: readonly string[],
): Record<string, unknown>[] {
  return items.map((item) => pickFields(item, fields));
}

// ============================================================================
// PAGINATION (fake — backend devuelve todo, MCA corta)
// ============================================================================

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/**
 * Pagina una lista en memoria con cursor opaco.
 *
 * Implementación "fake" mientras el backend handler no soporte cursor real:
 * el backend devuelve toda la colección, el MCA corta a `limit` antes de
 * devolver al LLM. Ahorra tokens del contexto (no DB). La interfaz es
 * estable — cuando el backend exponga paginación nativa, se sustituye este
 * helper por una llamada directa.
 *
 * El cursor codifica el offset como base64url. Opaco para el LLM.
 */
export function paginate<T>(
  items: T[],
  limit?: number,
  cursor?: string,
): { items: T[]; nextCursor?: string } {
  const max = Math.min(Math.max(1, limit ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
  const offset = cursor ? decodeCursor(cursor) : 0;
  const slice = items.slice(offset, offset + max);
  const nextOffset = offset + slice.length;
  const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : undefined;
  return { items: slice, nextCursor };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

// ============================================================================
// FIELD RESOLUTION (3 modos: includeRaw | fields | default)
// ============================================================================

/**
 * Resuelve qué campos retornar según los 3 modos posibles:
 *  - includeRaw=true → objeto completo del backend.
 *  - fields=[...] → solo los campos pedidos por el LLM.
 *  - default → whitelist por entidad (curado estándar).
 */
export function resolveFields<T extends Record<string, unknown>>(
  obj: T,
  opts: {
    includeRaw?: boolean;
    fields?: readonly string[] | string[];
    defaultFields: readonly string[];
  },
): Record<string, unknown> {
  if (opts.includeRaw) return obj;
  if (opts.fields && opts.fields.length > 0) return pickFields(obj, opts.fields);
  return pickFields(obj, opts.defaultFields);
}

export function resolveFieldsList<T extends Record<string, unknown>>(
  items: T[],
  opts: {
    includeRaw?: boolean;
    fields?: readonly string[] | string[];
    defaultFields: readonly string[];
  },
): Record<string, unknown>[] {
  if (opts.includeRaw) return items;
  const fields = opts.fields && opts.fields.length > 0 ? opts.fields : opts.defaultFields;
  return items.map((item) => pickFields(item, fields));
}

// ============================================================================
// BACKEND-BOUND HELPERS
// ============================================================================

/**
 * Asegura que el WebSocket client está conectado al backend. Lanza un error
 * claro y accionable si no lo está.
 */
export function assertBackendConnected(): void {
  if (!isWsConnected()) {
    throw new Error('Not connected to backend. Please try again in a moment.');
  }
}

import {
  withRetry as sdkWithRetry,
  withTimeout as sdkWithTimeout,
  TimeoutError,
} from '@teros/mca-sdk';

/**
 * Envuelve una promesa con timeout. Delega en `withTimeout` del SDK pero
 * acepta una Promise directamente (y un `label` opcional para mensaje de
 * error más claro), en lugar de una factory. Útil para pipelines donde la
 * Promise ya está en vuelo.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms = 15_000,
  label = 'operation',
): Promise<T> {
  try {
    return await sdkWithTimeout(() => promise, ms);
  } catch (err) {
    if (err instanceof TimeoutError) {
      throw new Error(`Timeout: ${label} did not complete within ${ms}ms`);
    }
    throw err;
  }
}

/**
 * Reintenta una operación con backoff exponencial. **Solo usar en
 * operaciones idempotentes** (`list-*`, `get-*`, `remove-*` idempotentes,
 * `unsubscribe`). NO usar en writes — duplica side effects.
 *
 * Delega en `withRetry` del SDK. Acepta opts con la forma del MCA (retries,
 * delayMs, label) y los traduce a RetryOptions del SDK.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  const { retries = 2, delayMs = 500, label = 'operation' } = opts;
  try {
    return await sdkWithRetry(fn, {
      retries,
      initialDelayMs: delayMs,
      backoff: 'exponential',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} failed after ${retries + 1} attempts: ${message}`);
  }
}

// ============================================================================
// ASSIGNEE ENRICHMENT (client-side)
// ============================================================================

type ResolvedAgent = {
  name?: string;
  fullName?: string;
  avatarUrl?: string;
};

/**
 * Merges `assigneeName`/`assigneeAvatarUrl` into each task using the `agents`
 * map that the backend returns alongside `tasks` in list/get responses.
 *
 * The backend ships `agents` as `Record<agentId, ResolvedAgent>`. We resolve
 * locally so the renderer doesn't need to cross-reference.
 */
export function attachAssigneeInfo<T extends { assignedAgentId?: string | null }>(
  tasks: T[],
  agents: Record<string, ResolvedAgent> | undefined,
): Array<T & { assigneeName?: string; assigneeAvatarUrl?: string }> {
  if (!agents) return tasks;
  return tasks.map((task) => {
    if (!task.assignedAgentId) return task;
    const a = agents[task.assignedAgentId];
    if (!a) return task;
    return {
      ...task,
      ...(a.fullName || a.name ? { assigneeName: a.fullName ?? a.name } : {}),
      ...(a.avatarUrl ? { assigneeAvatarUrl: a.avatarUrl } : {}),
    };
  });
}

export function attachAssigneeInfoOne<T extends { assignedAgentId?: string | null }>(
  task: T,
  agents: Record<string, ResolvedAgent> | undefined,
): T & { assigneeName?: string; assigneeAvatarUrl?: string } {
  return attachAssigneeInfo([task], agents)[0] as T & {
    assigneeName?: string;
    assigneeAvatarUrl?: string;
  };
}

// ============================================================================
// ID VALIDATION
// ============================================================================

async function validateExists(
  id: string,
  command: 'get_task' | 'get_project',
  payload: Record<string, unknown>,
  entityLabel: string,
  idField: string,
): Promise<void> {
  const wsClient = getWsClient();
  try {
    await wsClient.queryConversations(command, payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not ?found|404/i.test(message)) {
      throw new Error(
        `${entityLabel} ID "${id}" is not valid or not accessible. Use ${idField} to find valid IDs.`,
      );
    }
    // Re-throw unrelated errors as-is
    throw error;
  }
}

/**
 * Valida que un taskId existe. Lanza error claro si no.
 */
export async function validateTaskId(taskId: string): Promise<void> {
  await validateExists(
    taskId,
    'get_task',
    { taskId },
    'Task',
    'list-tasks or get-my-tasks',
  );
}

/**
 * Valida que un projectId existe.
 */
export async function validateProjectId(projectId: string): Promise<void> {
  await validateExists(projectId, 'get_project', { projectId }, 'Project', 'list-projects');
}
