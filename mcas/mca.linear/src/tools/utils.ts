/**
 * Generic utilities for curating tool responses.
 *
 * `pickFields` / `resolveFields` are the main pattern — handlers build a
 * full curated object, then let these helpers strip it down (or return raw
 * when the caller passes includeRaw=true).
 *
 * `wrapLinearCall` centralises retry + error classification for SDK calls.
 */

import { withRetry, type RetryOptions } from '@teros/mca-sdk';
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
// LINEAR SDK CALL WRAPPER
// ============================================================================

/**
 * Linear SDK error shape (approximation):
 *   Error with `.message` containing an HTTP status or GraphQL error code.
 *   The SDK surfaces HTTP status via thrown error's message or `.errors`.
 *
 * We only retry transient failures (5xx, rate_limited, network). 4xx client
 * errors (unauthorized, validation, not_found) fail fast so callers get
 * immediate feedback.
 */
function shouldRetryLinear(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; message?: string };

  if (e.status && e.status >= 500) return true;

  const code = e.code ?? '';
  if (code === 'rate_limited' || code === 'RATE_LIMITED') return true;
  if (code === 'service_unavailable' || code === 'SERVICE_UNAVAILABLE') return true;
  if (code === 'internal_server_error') return true;

  const msg = e.message ?? '';
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  if (/rate.?limit|too many requests/i.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(msg)) return true;
  return false;
}

/**
 * Wraps a Linear SDK call with retry + error normalisation.
 *
 * Only use for IDEMPOTENT operations (all reads + PUT-style updates that
 * overwrite). Do NOT wrap `create-*` / comment-create calls without an
 * idempotency key — a retry after partial success creates duplicates.
 */
export async function wrapLinearCall<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  return withRetry(fn, { shouldRetry: shouldRetryLinear, ...opts });
}

// ============================================================================
// PAGINATION (Linear-native relay cursor passthrough)
// ============================================================================

export interface PaginatedResponse<T> {
  results: T[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Linear SDK list responses expose `nodes`, `pageInfo.hasNextPage`, and
 * `pageInfo.endCursor`. This helper reshapes that into our canonical
 * camelCase envelope without parsing the cursor (it is opaque).
 */
export function wrapPaginated<T, R>(
  sdkResponse: {
    nodes: T[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  },
  mapper: (item: T) => R,
): PaginatedResponse<R> {
  const results = sdkResponse.nodes.map(mapper);
  return {
    results,
    total: results.length,
    hasMore: !!sdkResponse.pageInfo?.hasNextPage,
    nextCursor: sdkResponse.pageInfo?.endCursor ?? null,
  };
}

// ============================================================================
// WRITE BODY SANITISATION
// ============================================================================

/**
 * Remove `undefined` values (and optionally `null`) from an object before
 * sending to Linear. The Linear GraphQL mutations accept `null` as "clear
 * the field" for most optionals, so we only strip `undefined` by default.
 *
 * Pass `{ stripNull: true }` when a specific endpoint rejects explicit
 * nulls — document the reason at the call site.
 */
export function sanitiseBody<T extends Record<string, any>>(
  body: T,
  opts: { stripNull?: boolean } = {},
): Partial<T> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (opts.stripNull && value === null) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}
