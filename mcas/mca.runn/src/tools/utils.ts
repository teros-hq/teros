/**
 * Generic utilities for curating tool responses.
 *
 * `pickFields` / `resolveFields` are the main pattern — Runn returns flat
 * JSON objects, so handlers pass the raw object straight through these helpers
 * to strip it down to a whitelist (or return raw when includeRaw=true).
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
 *  - includeRaw=true  → raw object passthrough (escape hatch)
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

/**
 * Remove `undefined` values before sending to Runn. The Runn API only updates
 * properties present in the body (PATCH-style) and treats `null`/`""`/`[]` as
 * "clear the field", so we strip only `undefined` by default.
 *
 * Pass `{ stripNull: true }` when an endpoint rejects explicit nulls.
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

/**
 * Unwrap a Runn create/update response. Runn's mutation endpoints return the
 * affected record(s) as an ARRAY (e.g. `POST /assignments` → `[{...}]`), even
 * for a single create — whereas `GET /x/{id}` returns a bare object. This takes
 * the first element of an array, or passes a bare object through unchanged.
 */
export function firstOf<T>(data: T | T[]): T {
  return Array.isArray(data) ? (data[0] as T) : data
}
