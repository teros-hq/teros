/**
 * Generic utilities for curating tool responses + safe SDK wrappers.
 *
 * `pickFields` / `resolveFields` are the curated-vs-raw pattern: handlers
 * build a full curated object then let these helpers strip it (or pass the
 * raw SDK response when `includeRaw=true`). Mirrors `mca.linear/utils.ts`
 * and `mca.figma/utils.ts`.
 *
 * `wrapSlackCall` runs the Slack SDK call through `withRetry` BUT only retries
 * transient failures classified as such (RATE_LIMITED, DEPENDENCY_UNAVAILABLE,
 * TIMEOUT). Mutations should NOT be wrapped — see `feedback_mca_retry_get_only`.
 */

import { withRetry, type RetryOptions } from '@teros/mca-sdk';
import type { FieldList } from './_fields';
import { classifySlackApiError, SlackApiError } from './_slack-error';

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
 *  - includeRaw=true  → raw object passthrough (escape hatch for advanced flows)
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
 * Drop `undefined` (and optionally `null`) entries from a payload before
 * sending to Slack. Some Slack endpoints reject explicit nulls (e.g. unset
 * topic must omit the field, not pass `null`). Default is conservative —
 * strip both undefined and null. Pass `{ keepNull: true }` to preserve null
 * when the endpoint treats it as "clear field".
 */
export function sanitiseBody<T extends Record<string, any>>(
  body: T,
  opts: { keepNull?: boolean } = {},
): Partial<T> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (!opts.keepNull && value === null) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

// ============================================================================
// SLACK SDK CALL WRAPPER
// ============================================================================

function shouldRetrySlack(err: unknown): boolean {
  if (err instanceof SlackApiError) return err.retryable;
  return classifySlackApiError(err).retryable;
}

/**
 * Wraps a Slack SDK call with retry + structured error rethrow.
 *
 * Use ONLY for IDEMPOTENT operations: GETs (`conversations.list`, `users.info`,
 * `auth.test`, …). Do NOT wrap mutations (`chat.postMessage`, `chat.delete`,
 * `reactions.add`, `conversations.create`, …) without an idempotency key —
 * a retry after partial success duplicates messages, posts ghost reactions,
 * etc. See `feedback_mca_retry_get_only`.
 *
 * Errors are always rethrown as `SlackApiError` (preserves upstream `code`
 * + bracket prefix in `message`).
 */
export async function wrapSlackCall<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  try {
    return await withRetry(fn, { shouldRetry: shouldRetrySlack, ...opts });
  } catch (err) {
    if (err instanceof SlackApiError) throw err;
    throw new SlackApiError(classifySlackApiError(err));
  }
}

/**
 * Same as `wrapSlackCall` but for mutations: NO retry, just structured error
 * rethrow. Use in handlers for any tool that creates/updates/deletes/posts
 * something.
 */
export async function wrapSlackMutation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SlackApiError) throw err;
    throw new SlackApiError(classifySlackApiError(err));
  }
}
