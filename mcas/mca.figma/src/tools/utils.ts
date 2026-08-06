/**
 * Generic utilities for curating Figma tool responses.
 *
 * `pickFields` / `resolveFields` are the main pattern: handlers build a full
 * curated object, then let these helpers strip it down (or return raw when
 * the caller passes `includeRaw=true`).
 *
 * Mirrors `mcas/mca.linear/src/tools/utils.ts`. Keep both in sync when adding
 * features (or extract to a shared package once a third MCA wants the same).
 */

import type { FieldList } from "./_fields"

// ============================================================================
// FIELD FILTERING
// ============================================================================

export function pickFields<T extends Record<string, any>>(obj: T, fields: FieldList): Partial<T> {
  const out: Record<string, any> = {}
  for (const key of fields) {
    if (key in obj) out[key] = obj[key]
  }
  return out as Partial<T>
}

export function pickFieldsList<T extends Record<string, any>>(
  items: T[],
  fields: FieldList,
): Partial<T>[] {
  return items.map((item) => pickFields(item, fields))
}

export interface ResolveFieldsOptions {
  includeRaw?: boolean
  fields?: string[]
  defaultFields: FieldList
}

/**
 * Three-mode resolution:
 *  - includeRaw=true  → raw upstream object passthrough (escape hatch)
 *  - fields=[...]     → caller-picked subset
 *  - else             → defaultFields whitelist
 */
export function resolveFields<T extends Record<string, any>>(
  obj: T,
  raw: unknown,
  opts: ResolveFieldsOptions,
): Partial<T> | unknown {
  if (opts.includeRaw) return raw
  if (opts.fields && opts.fields.length > 0) return pickFields(obj, opts.fields)
  return pickFields(obj, opts.defaultFields)
}

export function resolveFieldsList<T extends Record<string, any>>(
  items: T[],
  rawItems: unknown[],
  opts: ResolveFieldsOptions,
): (Partial<T> | unknown)[] {
  if (opts.includeRaw) return rawItems
  const effective = opts.fields && opts.fields.length > 0 ? opts.fields : opts.defaultFields
  return items.map((item) => pickFields(item, effective))
}

// ============================================================================
// INPUT SANITISATION
// ============================================================================

export interface NumberOptions {
  min?: number
  max: number
  default: number
  integer?: boolean
}

export function sanitizeNumber(value: unknown, opts: NumberOptions): number {
  const min = opts.min ?? 0
  if (typeof value !== "number" || Number.isNaN(value)) return opts.default
  let n = value
  if (n < min) n = min
  if (n > opts.max) n = opts.max
  return opts.integer ? Math.floor(n) : n
}

/**
 * Validate Figma file key. Per Figma URL pattern, file keys are alphanumeric
 * (with `-` and `_`), typically 22 chars. Reject empty / whitespace strings
 * and obviously malformed inputs at the boundary so the upstream API gets a
 * cleaner request.
 */
export function validateFileKey(value: unknown, paramName = "fileKey"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${paramName} must be a non-empty string`)
  }
  const key = value.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(`${paramName} contains invalid characters. Expected alphanumeric, '-', '_'.`)
  }
  return key
}

/**
 * Normalise a Figma node ID. The Figma URL format uses `nodeId=1-2`, but the
 * REST API expects `1:2`. This handles both inputs transparently.
 */
export function normalizeNodeId(value: unknown, paramName = "nodeId"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${paramName} must be a non-empty string`)
  }
  return value.trim().replace(/-/g, ":")
}

// ============================================================================
// WRITE BODY SANITISATION
// ============================================================================

/**
 * Remove `undefined` values (and optionally `null`) from an object before
 * sending to Figma. Pass `{ stripNull: true }` for endpoints that reject
 * explicit nulls.
 */
export function sanitiseBody<T extends Record<string, any>>(
  body: T,
  opts: { stripNull?: boolean } = {},
): Partial<T> {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    if (opts.stripNull && value === null) continue
    out[key] = value
  }
  return out as Partial<T>
}
