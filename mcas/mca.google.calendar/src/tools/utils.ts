/**
 * Generic utilities for curating tool responses.
 *
 *  - pickFields/resolveFields strip a curated object down to a default
 *    whitelist (or pass it through raw when includeRaw=true). Pattern matches
 *    `mcas/mca.notion/src/tools/utils.ts` so renderers can rely on shape parity.
 *  - sanitizeLimit clamps user-provided limit args to API maximums.
 *  - wrapCalendarCall centralises retry + timeout for googleapis SDK calls.
 */

import { type RetryOptions, withRetry, withTimeout } from "@teros/mca-sdk"
import type { FieldList } from "./_fields"

// ============================================================================
// FIELD CURATION
// ============================================================================

export function pickFields<T extends Record<string, unknown>>(
  obj: T,
  fields: FieldList,
): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const key of fields) {
    if (key in obj) out[key] = obj[key]
  }
  return out as Partial<T>
}

export interface ResolveFieldsOptions {
  includeRaw?: boolean
  fields?: string[]
  defaultFields: FieldList
}

/**
 * Three-mode resolution:
 *  - includeRaw=true  → raw passthrough (escape hatch for the agent).
 *  - fields=[...]     → caller-picked subset.
 *  - else             → defaultFields whitelist.
 */
export function resolveFields<T extends Record<string, unknown>>(
  obj: T,
  raw: unknown,
  opts: ResolveFieldsOptions,
): Partial<T> | unknown {
  if (opts.includeRaw) return raw
  if (opts.fields && opts.fields.length > 0) return pickFields(obj, opts.fields)
  return pickFields(obj, opts.defaultFields)
}

export function resolveFieldsList<T extends Record<string, unknown>>(
  items: T[],
  rawItems: unknown[],
  opts: ResolveFieldsOptions,
): (Partial<T> | unknown)[] {
  if (opts.includeRaw) return rawItems
  const effective = opts.fields && opts.fields.length > 0 ? opts.fields : opts.defaultFields
  return items.map((item) => pickFields(item, effective))
}

// ============================================================================
// LIMIT SANITISATION
// ============================================================================

export interface LimitOptions {
  min?: number
  max: number
  default: number
}

export function sanitizeLimit(value: unknown, opts: LimitOptions): number {
  const min = opts.min ?? 1
  if (typeof value !== "number" || Number.isNaN(value)) return opts.default
  if (value < min) return min
  if (value > opts.max) return opts.max
  return Math.floor(value)
}

// ============================================================================
// GOOGLE API CALL WRAPPER (timeout + retry)
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Google API errors expose `code` (HTTP status) plus `errors[]`. We retry
 * transient failures (5xx, rate-limit, network) and let 4xx fail fast so the
 * agent gets the real error.
 */
function shouldRetryCalendar(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as { code?: number | string; message?: string; errors?: Array<{ reason?: string }> }
  const code = typeof e.code === "string" ? Number.parseInt(e.code, 10) : e.code
  if (typeof code === "number" && code >= 500) return true
  if (code === 429) return true // rate limited
  const reason = e.errors?.[0]?.reason
  if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return true
  if (reason === "backendError" || reason === "internalError") return true
  const msg = e.message ?? ""
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(msg)
}

/**
 * Wrap an idempotent Google Calendar API call with timeout + retry.
 *
 * Use ONLY for idempotent operations (reads, get-by-id, updates that overwrite,
 * deletes by id). Do NOT wrap `events.insert` / `events.quickAdd` without an
 * idempotency key — a retry after a partial success creates duplicate events.
 * Mutations call `withTimeout` directly via {@link runCalendarCall}.
 */
export async function wrapCalendarCall<T>(
  fn: () => Promise<T>,
  opts: RetryOptions & { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return withRetry(() => withTimeout(fn, timeoutMs), {
    shouldRetry: shouldRetryCalendar,
    ...opts,
  })
}

/**
 * Timeout-only wrapper for non-idempotent mutations (insert, quickAdd).
 */
export async function runCalendarCall<T>(
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return withTimeout(fn, timeoutMs)
}

/**
 * Reject empty / non-http(s) `fileUrl`. Google Calendar's events API silently
 * accepts any string here (including `""`), creating events with broken
 * attachments that look successful. Validate at the handler boundary so the
 * agent gets a clear error instead of a phantom event.
 */
export function validateAttachment(
  attachment: { fileUrl?: string },
  index: number,
): void {
  const url = attachment.fileUrl
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(`attachments[${index}].fileUrl must be a non-empty string.`)
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `attachments[${index}].fileUrl must be a valid http(s) URL — got "${url}".`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `attachments[${index}].fileUrl must use http or https — got "${parsed.protocol}".`,
    )
  }
}
