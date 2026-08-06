/**
 * Shared utilities for board-runner MCA tools.
 *
 * Duplica el patrón de `mca.teros.core/src/tools/utils.ts` (YAGNI: no creamos
 * un paquete compartido `@teros/mca-board-shared` para 2 MCAs). Cuando aparezca
 * un 3er MCA del dominio, se promueve.
 */

import {
  withRetry as sdkWithRetry,
  withTimeout as sdkWithTimeout,
  TimeoutError,
} from '@teros/mca-sdk';
import { isWsConnected } from '../lib';

// ============================================================================
// FIELD PICKERS
// ============================================================================

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
// FIELD RESOLUTION
// ============================================================================

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

export function assertBackendConnected(): void {
  if (!isWsConnected()) {
    throw new Error('Not connected to backend. Please try again in a moment.');
  }
}

/** Envuelve una Promise con timeout. Delega en el SDK. */
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
 * Retry con backoff exponencial. **Solo en operaciones idempotentes**
 * (`get-my-tasks`, `get-my-task`). NO en writes (complete/block/cancel/add-note).
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
