/**
 * Generic utilities for curating tool responses.
 *
 * pickFields / resolveFields are the main pattern — handlers build a full
 * curated object, then let these helpers strip it down (or return raw
 * when the caller passes includeRaw=true).
 *
 * wrapNotionCall centralises retry + error classification for SDK calls.
 */

import { type RetryOptions, withRetry } from '@teros/mca-sdk';
import { classifyNotionError, NotionApiError } from '../lib/_notion-error';
import type { FieldList } from './_fields';

// ============================================================================
// FIELD FILTERING
// ============================================================================

export function pickFields<T extends Record<string, any>>(obj: T, fields: FieldList): Partial<T> {
  const out: Record<string, any> = {};
  for (const key of fields) {
    if (key in obj) out[key] = obj[key];
  }
  return out as Partial<T>;
}

export function pickFieldsList<T extends Record<string, any>>(
  items: T[],
  fields: FieldList,
): Partial<T>[] {
  return items.map((item) => pickFields(item, fields));
}

export interface ResolveFieldsOptions {
  includeRaw?: boolean;
  fields?: string[];
  defaultFields: FieldList;
}

/**
 * Three-mode resolution:
 *  - includeRaw=true  → the raw object passthrough (escape hatch)
 *  - fields=[...]     → caller-picked subset
 *  - else             → defaultFields whitelist
 *
 * Handlers pass the already-curated camelCase object; this just filters keys.
 */
export function resolveFields<T extends Record<string, any>>(
  obj: T,
  raw: unknown,
  opts: ResolveFieldsOptions,
): Partial<T> | unknown {
  if (opts.includeRaw) return raw;
  if (opts.fields && opts.fields.length > 0) return pickFields(obj, opts.fields);
  return pickFields(obj, opts.defaultFields);
}

export function resolveFieldsList<T extends Record<string, any>>(
  items: T[],
  rawItems: unknown[],
  opts: ResolveFieldsOptions,
): (Partial<T> | unknown)[] {
  if (opts.includeRaw) return rawItems;
  const effective = opts.fields && opts.fields.length > 0 ? opts.fields : opts.defaultFields;
  return items.map((item) => pickFields(item, effective));
}

// ============================================================================
// INPUT SANITISATION
// ============================================================================

export interface LimitOptions {
  min?: number;
  max: number;
  default: number;
}

export function sanitizeLimit(value: unknown, opts: LimitOptions): number {
  const min = opts.min ?? 1;
  if (typeof value !== 'number' || Number.isNaN(value)) return opts.default;
  if (value < min) return min;
  if (value > opts.max) return opts.max;
  return Math.floor(value);
}

// ============================================================================
// NOTION SDK CALL WRAPPER
// ============================================================================

/**
 * Notion API error shape (from @notionhq/client v5):
 *   - APIResponseError: { code: APIErrorCode, status: number, message }
 *   - RequestTimeoutError: { code: 'notionhq_client_request_timeout', message }
 *   - UnknownHTTPResponseError: { code: 'notionhq_client_response_error', status, message }
 *
 * We only retry transient failures (5xx, rate_limited, gateway_timeout,
 * client request timeout, network). 4xx client errors (unauthorized,
 * validation, not_found, conflict) fail fast.
 */
function shouldRetryNotion(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; message?: string };
  if (e.status && e.status >= 500) return true;
  if (e.code === 'rate_limited') return true;
  if (e.code === 'service_unavailable') return true;
  if (e.code === 'internal_server_error') return true;
  if (e.code === 'gateway_timeout') return true;
  if (e.code === 'notionhq_client_request_timeout') return true;
  const msg = e.message ?? '';
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(msg);
}

/**
 * Wraps an idempotent Notion SDK call with retry + error classification.
 *
 * Use for reads + PUT-style updates that overwrite. Do NOT wrap `create-*`
 * calls without an idempotency key — a retry after partial success creates
 * duplicates. Mutations should use {@link wrapNotionWrite} instead.
 *
 * Any thrown error is normalised to {@link NotionApiError} with a `[CODE]`
 * prefix on the message so the agent can route on AUTH_EXPIRED / PERMISSION_DENIED
 * / RATE_LIMITED. The upstream Notion message is preserved verbatim.
 */
export async function wrapNotionCall<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  try {
    return await withRetry(fn, { shouldRetry: shouldRetryNotion, ...opts });
  } catch (err) {
    throw err instanceof NotionApiError ? err : new NotionApiError(classifyNotionError(err));
  }
}

/**
 * Wraps a non-idempotent Notion SDK call (create-*, append-*, delete-*) with
 * error classification only — no retry, since Notion does not accept
 * idempotency keys and a retry after partial success would duplicate rows /
 * blocks / comments.
 */
export async function wrapNotionWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof NotionApiError ? err : new NotionApiError(classifyNotionError(err));
  }
}

// ============================================================================
// PAGINATION CURSOR (manual Notion-native passthrough)
// ============================================================================

export interface PaginatedResponse<T> {
  results: T[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
}

/**
 * Notion cursors are opaque strings — pass them straight through without
 * parsing. This helper just reshapes the SDK response into our canonical
 * camelCase envelope.
 */
export function wrapPaginated<T, R>(
  sdkResponse: { results: T[]; has_more: boolean; next_cursor: string | null },
  mapper: (item: T) => R,
): PaginatedResponse<R> {
  const results = sdkResponse.results.map(mapper);
  return {
    results,
    hasMore: sdkResponse.has_more,
    nextCursor: sdkResponse.next_cursor,
    total: results.length,
  };
}
