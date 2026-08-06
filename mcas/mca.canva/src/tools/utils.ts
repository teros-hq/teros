/**
 * Generic utilities for Canva tool handlers.
 *
 * - `pickFields` / `resolveFields*` — curate response shapes; raw passthrough
 *   when caller passes `includeRaw: true`.
 * - `sanitiseBody` — strip undefined (and optionally null) before write
 *   requests. Canva PATCH/POST reject explicit nulls in many shapes.
 * - `wrapCanvaCall` — retry transient failures (5xx, 429, network). NEVER
 *   wrap non-idempotent mutations without an idempotency key.
 */

import { type RetryOptions, withRetry } from '@teros/mca-sdk';
import { CanvaApiError } from '../lib/_canva-error';
import type { FieldList } from './_fields';

// ============================================================================
// FIELD FILTERING
// ============================================================================

export function pickFields<T extends Record<string, any>>(obj: T, fields: FieldList): Partial<T> {
  const out: Record<string, any> = {};
  for (const key of fields) {
    if (key in obj) out[key] = (obj as any)[key];
  }
  return out as Partial<T>;
}

export interface ResolveFieldsOptions {
  includeRaw?: boolean;
  fields?: string[];
  defaultFields: FieldList;
}

/**
 * Three-mode resolution:
 *  - includeRaw=true  → raw object passthrough (escape hatch)
 *  - fields=[...]     → caller-picked subset
 *  - else             → defaultFields whitelist
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

/**
 * Strip undefined (and optionally null) from a write body. Canva PATCH/POST
 * accept `null` for "clear this field" in some shapes but reject it in
 * others; pass `{ stripNull: true }` when the endpoint rejects nulls.
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

// ============================================================================
// CANVA CALL WRAPPER (retry transient failures)
// ============================================================================

function shouldRetryCanva(err: unknown): boolean {
  if (err instanceof CanvaApiError) {
    if (err.status === 429) return true;
    if (err.status >= 500) return true;
    return false;
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = String((err as Error).message ?? '');
    if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(msg)) return true;
  }
  return false;
}

/**
 * Wrap a Canva API call with retry semantics. ONLY use for idempotent
 * operations (reads, PATCH that overwrites, DELETE). Do NOT wrap creates
 * or non-idempotent mutations — a retry after a partial success creates
 * duplicates.
 */
export async function wrapCanvaCall<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  return withRetry(fn, { shouldRetry: shouldRetryCanva, ...opts });
}
