/**
 * MCA Health — pure helpers, constants, and derived types shared by the dashboard,
 * the runner hook, and the row/form components. No JSX, no React state: everything here
 * is a pure function or a constant so it can be unit-tested in isolation (T-08-04) and
 * imported without dragging the component tree in.
 */
import type { McaToolAnnotations } from "@teros/shared"
import type { McaData, McaHealthRecord, McaTestResult, McaToolSchema } from "../../services/AppApi"
import type { McaOverallStatus, McaRowData, McaToolResult, ToolTestStatus } from "./mcaStatus.types"

export const STATUS_COLORS: Record<string, string> = {
  ok: "#22C55E",
  operational: "#22C55E",
  fail: "#EF4444",
  failed: "#EF4444",
  partial: "#F59E0B",
  confirm: "#F59E0B",
  pending: "#71717A",
  skip: "#71717A",
}

/**
 * Fixed semantic content-category order (D-12). Category headers always render in this sequence,
 * never alphabetical or by-count. Any catalog category not in this list (including empty/missing)
 * buckets into "other".
 */
export const CATEGORY_ORDER = [
  "productivity",
  "development",
  "ai",
  "communication",
  "data",
  "design",
  "storage",
  "system",
  "utility",
  "other",
] as const

export type CategoryKey = (typeof CATEGORY_ORDER)[number]

const CATEGORY_SET = new Set<string>(CATEGORY_ORDER)

/** Map an MCA's raw category to a CATEGORY_ORDER member; unknown/missing → "other" (D-12). */
export function bucketCategory(category: string | undefined): CategoryKey {
  if (category && CATEGORY_SET.has(category)) return category as CategoryKey
  return "other"
}

/**
 * Derive an MCA's overall status from its tool results (spec thresholds, lines 218-222):
 * none tested -> pending; all tested ok -> operational; all tested fail -> failed; otherwise partial.
 *
 * Only DEFINITIVE results (ok | fail | confirm) count. Untested rows (pending / skip) must be
 * excluded: passing the full row set here dragged a partially-tested-but-all-passing MCA down to
 * "partial", because `every(status === "ok")` was false on the leftover pending rows. This mirrors
 * `computeHealth`'s denominator so the overall badge and the health-bar fraction agree.
 */
export function deriveOverall(tools: { status: string }[]): McaOverallStatus {
  const definitive = tools.filter(
    (t) => t.status === "ok" || t.status === "fail" || t.status === "confirm",
  )
  if (definitive.length === 0) return "pending"
  if (definitive.every((t) => t.status === "ok")) return "operational"
  if (definitive.every((t) => t.status === "fail")) return "failed"
  return "partial"
}

/**
 * Left-join a catalog MCA's tool names against the persisted per-tool results (DASH-04 / AC-6).
 * Every catalog tool yields a row: a tool with no matching persisted result is `pending`. A
 * persisted result whose tool is no longer in the catalog is appended (flagged in notes) so the
 * snapshot stays visible without crashing (spec edge cases lines 277-281).
 */
export function buildToolRows(
  catalogTools: string[],
  persistedResults: McaToolResult[],
): McaToolResult[] {
  const byName = new Map(persistedResults.map((tr) => [tr.tool, tr]))
  const rows: McaToolResult[] = catalogTools.map((tool) => {
    const persisted = byName.get(tool)
    return persisted ?? { tool, status: "pending" as ToolTestStatus }
  })
  // Persisted results for tools no longer in the catalog: keep them visible, do not crash.
  for (const tr of persistedResults) {
    if (!catalogTools.includes(tr.tool)) rows.push(tr)
  }
  return rows
}

/**
 * Health-bar aggregate for a set of tool rows (HEALTH-05, D-05).
 * Denominator (`counted`) = tools with a definitive result (ok | fail | confirm); pending and
 * skip are excluded. `passing` = tools with status === "ok". `confirm`/`fail` counts drive the
 * amber/red segments. A never-tested MCA has counted === 0 and renders a neutral grey bar.
 */
export function computeHealth(toolRows: McaToolResult[]): {
  counted: number
  passing: number
  confirm: number
  fail: number
} {
  let passing = 0
  let confirm = 0
  let fail = 0
  for (const tr of toolRows) {
    if (tr.status === "ok") passing += 1
    else if (tr.status === "confirm") confirm += 1
    else if (tr.status === "fail") fail += 1
    // pending + skip excluded from the denominator (D-05).
  }
  return { counted: passing + confirm + fail, passing, confirm, fail }
}

/** Stable per-tool run-state key (D-05/D-06 — one entry per (mcaId, tool)). */
export function toolKey(mcaId: string, tool: string): string {
  return `${mcaId}::${tool}`
}

/**
 * Typed not-installed reason code returned by `app.get-mca-resolvability` (D-06). A code, never
 * display text. Imported from `@teros/shared` (single source of truth) and re-exported so the cached
 * value is byte-identical to the backend wire shape without a hardcoded literal synced by comment.
 */
export { NOT_INSTALLED_REASON } from "@teros/shared"

/**
 * Classify a tool as read-only vs destructive for the whole-MCA run order (D-09).
 * Read-only iff the explicit annotations declare `readOnlyHint === true` — annotations
 * are always explicit since the shared name heuristic was removed (mca-protocol.ts,
 * 2026-07-04). Liberal on the destructive side: an unannotated tool classifies as
 * destructive, so a mis-annotated tool errs toward requiring the confirm rather than
 * silently running (T-08-03-01).
 */
export function isReadOnlyTool(_tool: string, annotations?: McaToolAnnotations): boolean {
  return annotations?.readOnlyHint === true
}

/**
 * Split an MCA's tools into read-only vs destructive for the whole-MCA run order (D-09). Uses the
 * loaded schemas' annotations via `isReadOnlyTool`; an unannotated / unmatched tool classifies as
 * destructive, so an empty `schemas` (fetch failed) sends every tool to the confirm — nothing runs
 * unconfirmed (T-08-04).
 */
export function classifyTools(
  tools: string[],
  schemas: McaToolSchema[],
): { readOnly: string[]; destructive: string[] } {
  const annotationsFor = (tool: string): McaToolAnnotations | undefined =>
    schemas.find((s) => s.tool === tool)?.annotations
  return {
    readOnly: tools.filter((tool) => isReadOnlyTool(tool, annotationsFor(tool))),
    destructive: tools.filter((tool) => !isReadOnlyTool(tool, annotationsFor(tool))),
  }
}

/**
 * Extract a human-readable error message from a failed McaTestResult (T-08-04-01).
 * Prefers the explicit `error` wire field (populated by the backend from the tool's
 * returned message); falls back to a string form of `result` (a string directly, or a
 * `message`/`error`/`text` property of an object). Returns undefined when nothing
 * carries text, so the caller renders the generic "Failed" label only in that case.
 */
export function extractErrorMessage(res: McaTestResult): string | undefined {
  if (typeof res.error === "string" && res.error.trim().length > 0) return res.error
  const r = res.result
  if (typeof r === "string" && r.trim().length > 0) return r
  if (r && typeof r === "object") {
    const obj = r as Record<string, unknown>
    const candidate = obj.message ?? obj.error ?? obj.text
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate
  }
  return undefined
}

/** Truncate a short-error to a bounded length before render/persist (T-08-04-02, ~300 chars). */
export function shortenError(message: string | undefined): string | undefined {
  if (!message) return undefined
  return message.length > 300 ? message.slice(0, 300) : message
}

/**
 * Format a persisted ISO `testedAt` as a locale-aware date + time for display. The raw ISO string
 * (e.g. "2026-07-06T15:19:35.350Z") is unreadable in the UI; render it as e.g. "Jul 6, 2026, 11:19 AM"
 * using the active i18n locale. Returns undefined for a missing/invalid timestamp so callers can skip
 * rendering rather than showing "Invalid Date".
 */
export function formatTestedAt(iso: string | undefined, locale: string): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
}

/**
 * D-02 fallback heuristic: an input schema is "flat" only when every property is a primitive
 * (string / number / integer / boolean, incl. enum). Any property whose declared `type` is
 * `object` or `array` (or is a nested schema without a primitive type) makes the schema non-flat,
 * so the whole form falls back to a single raw-JSON textarea. Returns true for an empty schema.
 */
export function isFlatSchema(inputSchema: McaToolSchema["inputSchema"]): boolean {
  const props = inputSchema.properties ?? {}
  // A required key with no property definition can't be turned into a generated field, so the flat
  // form would render nothing for it and Submit as {} despite the tool requiring it. Fall back to
  // the raw-JSON editor so the user can supply the key (and the required-field gate can block).
  const required = inputSchema.required ?? []
  if (required.some((key) => !(key in props))) return false
  return Object.values(props).every((raw) => {
    if (!raw || typeof raw !== "object") return false
    const type = (raw as { type?: unknown }).type
    return type === "string" || type === "number" || type === "integer" || type === "boolean"
  })
}

/** A generated input-form field descriptor derived from a flat property schema. */
export interface FormField {
  name: string
  type: "string" | "number" | "integer" | "boolean"
  required: boolean
  enum?: string[]
}

/** Extract the ordered flat field descriptors from a flat input schema (D-02 field generation). */
export function buildFormFields(inputSchema: McaToolSchema["inputSchema"]): FormField[] {
  const required = new Set(inputSchema.required ?? [])
  return Object.entries(inputSchema.properties ?? {}).map(([name, raw]) => {
    const prop = (raw ?? {}) as { type?: string; enum?: unknown }
    const enumVals = Array.isArray(prop.enum) ? prop.enum.map((v) => String(v)) : undefined
    const type =
      prop.type === "number" || prop.type === "integer"
        ? (prop.type as "number" | "integer")
        : prop.type === "boolean"
          ? "boolean"
          : "string"
    return { name, type, required: required.has(name), enum: enumVals }
  })
}

/**
 * Seed a raw-JSON template from a non-flat input schema so the textarea opens with the tool's full
 * shape — every property present, required ones included — instead of a blank box a user can Submit
 * as `{}`. Each property is seeded from its `default` when declared, else a type-appropriate empty
 * value (string → "", number → 0, boolean → false, array → [], object → {}). Required string fields
 * start empty, so the required-field Submit gate keeps them blocked until the user fills them.
 */
export function buildJsonTemplate(inputSchema: McaToolSchema["inputSchema"]): string {
  const props = inputSchema.properties ?? {}
  const obj: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(props)) {
    const prop = (raw ?? {}) as { type?: string; default?: unknown }
    if (prop.default !== undefined) {
      obj[name] = prop.default
      continue
    }
    switch (prop.type) {
      case "number":
      case "integer":
        obj[name] = 0
        break
      case "boolean":
        obj[name] = false
        break
      case "array":
        obj[name] = []
        break
      case "object":
        obj[name] = {}
        break
      default:
        obj[name] = ""
    }
  }
  return JSON.stringify(obj, null, 2)
}

/**
 * True when a tool must open the input Sheet before running: it declares required inputs. Gates on
 * `required.length`, NOT `requiresInput` (properties-count) — a malformed schema with a non-empty
 * `required` but empty `properties` would otherwise run the tool with `{}` (D-01).
 */
export function toolNeedsInput(schema: McaToolSchema | undefined): boolean {
  return !!schema && (schema.inputSchema.required?.length ?? 0) > 0
}

/**
 * Initial raw-JSON editor contents when opening the Sheet: empty for a flat schema (per-field form
 * is used instead), or the schema shape template for a non-flat one so required fields are visible
 * to fill — never an empty box that Submits as `{}` (→ opaque MCA crash).
 */
export function initialRawJson(inputSchema: McaToolSchema["inputSchema"]): string {
  return isFlatSchema(inputSchema) ? "" : buildJsonTemplate(inputSchema)
}

/**
 * True when a raw-JSON body satisfies every required key in the schema: it parses to an object and
 * each required property is present and non-empty (undefined/null/blank-string all fail). Mirrors
 * the flat-form required check so a non-flat tool can never be fired with missing required input.
 */
export function rawJsonRequiredFilled(
  rawJson: string,
  inputSchema: McaToolSchema["inputSchema"],
): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
  const record = parsed as Record<string, unknown>
  return (inputSchema.required ?? []).every((key) => {
    const v = record[key]
    return v !== undefined && v !== null && (typeof v !== "string" || v.trim() !== "")
  })
}

/**
 * Build the tool input from the active input form, or `null` when Submit must stay gated. Flat
 * schemas use the per-field `formValues` verbatim; non-flat schemas parse the raw-JSON editor and
 * return `null` on a parse error or a missing/blank required field (matching the disabled-Submit UX
 * — never firing a tool with malformed or partial input).
 */
export function buildFormInput(
  inputSchema: McaToolSchema["inputSchema"],
  formValues: Record<string, unknown>,
  rawJson: string,
): Record<string, unknown> | null {
  if (isFlatSchema(inputSchema)) return formValues
  let input: Record<string, unknown>
  try {
    input = JSON.parse(rawJson) as Record<string, unknown>
  } catch {
    return null
  }
  if (!rawJsonRequiredFilled(rawJson, inputSchema)) return null
  return input
}

/** Sheet-open descriptor for the active input form (Task 2 / D-01). */
export interface ActiveForm {
  mcaId: string
  tool: string
  schema: McaToolSchema
}

/**
 * Map a completed live `McaTestResult` to its rendered tool row + the short error to persist
 * (T-08-04-01/02). Success → a plain `ok` row (no note). Failure → a `fail` row whose note is the
 * extracted-then-truncated backend message, or the generic "Failed" label when nothing carries
 * text. `shortError` is returned separately so the caller persists the SAME extracted message (not
 * the localized label) through write-through, keeping a reload's rehydrated reason honest (D-07).
 *
 * `testedAt` is stamped now (ISO) on every live row so the row's "last tested" line updates the
 * instant a run finishes — the live overlay replaces the persisted row wholesale, so without this
 * the timestamp would blank out until a page reload re-read the persisted health (DASH-04).
 */
export function resultToRow(
  res: McaTestResult,
  tool: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { row: McaToolResult; shortError?: string } {
  const testedAt = new Date().toISOString()
  if (res.success) return { row: { tool, status: "ok", testedAt } }
  const shortError = shortenError(extractErrorMessage(res))
  return {
    row: {
      tool,
      status: "fail",
      testedAt,
      notes: shortError
        ? t("mca.status.run.error", { message: shortError })
        : t("mca.status.run.failed"),
    },
    shortError,
  }
}

/** The five availability filter-chip toggles (D-08). */
export interface AvailabilityFilters {
  showSystem: boolean
  showAdminOnly: boolean
  showUser: boolean
  showHidden: boolean
  showDisabled: boolean
}

/** Default filter state: every availability tier visible. */
export const ALL_VISIBLE: AvailabilityFilters = {
  showSystem: true,
  showAdminOnly: true,
  showUser: true,
  showHidden: true,
  showDisabled: true,
}

const isAdminRole = (role: string) => role === "admin" || role === "super"

/**
 * An MCA's single availability tier (D-08). Values double as the `mca.status.filters.*`
 * i18n key suffix so the badge label is `t(`mca.status.filters.${tier}`)`.
 */
export type AvailabilityTier = "system" | "hidden" | "disabled" | "adminOnly" | "user"

/**
 * Single source of truth for an MCA's availability tier. BOTH the filter chips
 * (`filterRows`) and the row badge (`availabilityLabel`) derive from this one function, so
 * the chip that hides an MCA and the badge that names it can never disagree. Order is
 * significant — system → hidden → disabled → role — and mirrors the Control window groups.
 */
export function classifyAvailabilityTier(mca: McaData): AvailabilityTier {
  const a = mca.availability
  if (a.system) return "system"
  if (a.hidden) return "hidden"
  if (!a.enabled) return "disabled"
  return isAdminRole(a.role) ? "adminOnly" : "user"
}

/**
 * Left-join the catalog to the persisted health baseline (D-01/D-03/D-04). Persisted rows are the
 * SOLE baseline: a catalog tool with no persisted record resolves to `pending` and a catalog MCA
 * with no persisted rows is `pending` overall (never throws). Current-session live results fold on
 * top later in the row render via `effectiveRows`.
 */
export function buildRows(
  mcas: McaData[],
  persistedHealth: Map<string, McaHealthRecord>,
): McaRowData[] {
  // Group persisted records by mcaId once (O(n)) so each MCA is fed ALL its records — including a
  // tool that has since dropped out of the catalog. Feeding only catalog tools left `buildToolRows`'s
  // orphan-append branch unreachable, silently dropping that snapshot (spec edge cases 277-281).
  const recordsByMca = new Map<string, McaHealthRecord[]>()
  for (const rec of persistedHealth.values()) {
    const list = recordsByMca.get(rec.mcaId)
    if (list) list.push(rec)
    else recordsByMca.set(rec.mcaId, [rec])
  }
  const toResult = (rec: McaHealthRecord): McaToolResult => ({
    tool: rec.tool,
    status: rec.status,
    testedAt: rec.testedAt,
    // Only surface a persisted error note for a failing tool — never a stale error left on a
    // now-ok/pending/skip record from a prior failed run.
    ...(rec.status === "fail" && rec.error ? { notes: rec.error } : {}),
  })
  return mcas.map((mca) => {
    const catalogTools = mca.tools ?? []
    const persistedRows = (recordsByMca.get(mca.mcaId) ?? []).map(toResult)
    const toolRows = buildToolRows(catalogTools, persistedRows)
    const overall = deriveOverall(toolRows)
    const testedAt = persistedRows.reduce<string | undefined>((acc, r) => {
      // testedAt can be absent on a malformed persisted row — skip those.
      if (r.testedAt && (!acc || r.testedAt > acc)) return r.testedAt
      return acc
    }, undefined)
    return { mca, overall, toolRows, testedAt }
  })
}

/**
 * Availability + search filter chain (D-08/D-09/D-10). Each chip, when OFF, removes the MCAs it
 * represents; the search (already debounced + trimmed) then matches name/mcaId case-insensitively.
 * Applied BEFORE grouping so empty categories drop out.
 */
export function filterRows(
  rows: McaRowData[],
  filters: AvailabilityFilters,
  query: string,
): McaRowData[] {
  const availability = rows.filter(({ mca }) => {
    switch (classifyAvailabilityTier(mca)) {
      case "system":
        return filters.showSystem
      case "hidden":
        return filters.showHidden
      case "disabled":
        return filters.showDisabled
      case "adminOnly":
        return filters.showAdminOnly
      case "user":
        return filters.showUser
      default:
        return false // unreachable — AvailabilityTier is exhaustive above (satisfies biome)
    }
  })
  const q = query.trim().toLowerCase()
  if (!q) return availability
  return availability.filter(
    ({ mca }) => mca.name.toLowerCase().includes(q) || mca.mcaId.toLowerCase().includes(q),
  )
}

/** Bucket filtered rows into the fixed-order content-category groups; drop empty groups (D-12/D-13). */
export function groupRows(
  rows: McaRowData[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): Array<{ key: CategoryKey; label: string; rows: McaRowData[] }> {
  return CATEGORY_ORDER.map((key) => ({
    key,
    label: t(`mca.status.categories.${key}`),
    rows: rows.filter(({ mca }) => bucketCategory(mca.category) === key),
  })).filter((g) => g.rows.length > 0)
}
