/**
 * Parameter relevance ranking + value bounding for the permission-approval card.
 *
 * `ParamsTable` renders a flat readout where every object collapses to "{...}".
 * That is fine for a completed tool call but useless when deciding whether to
 * approve one, so this module ranks the params a reviewer needs first and makes
 * every value reachable. See docs/specs/mca/permission-approval-detail.md.
 *
 * Pure by design: no runtime imports, so `bun test` can exercise it (bun cannot
 * parse react-native's Flow-only source). The one `import type` below is erased
 * at compile time and costs nothing at runtime.
 */

import type { ToolParameters } from "../../../types/tool-details"

// Re-exported because this module is what the primitives barrel exposes the type
// through. Declaring a second identical copy here is what let it drift.
export type { ToolParameters }

export const PARAM_CAPS = {
  /** Rows shown before the "show all" toggle on the approval card. */
  compactRows: 4,
  /** Nesting levels expanded; deeper containers show a summary only. */
  maxDepth: 3,
  /** Children listed per container. */
  maxItems: 10,
  /** Characters kept of a single stringified value. */
  maxChars: 240,
} as const

interface SchemaProperty {
  type?: string
  description?: string
  enum?: unknown[]
}

export interface RankedParam {
  key: string
  value: unknown
  /** The schema property's own `description`, when declared. */
  description?: string
  /** Allowed values, when the schema declares an enum. */
  enumValues?: unknown[]
  required: boolean
  /** Present in input but absent from the schema — worth the reviewer's notice. */
  undeclared: boolean
  container: boolean
}

export interface BoundedValue {
  text: string
  truncated: boolean
  /**
   * The WHOLE stringified scalar when `text` is a clipped view of it, else
   * undefined. Kept so the row's "show more" can actually show more: without it
   * the remaining characters were discarded at bounding time, leaving the hint
   * pointing at nothing. Undefined for containers — those disclose through
   * `children` / `hiddenCount` instead.
   */
  fullText?: string
  children: Array<{ key: string; value: unknown }>
  /**
   * Entries this value holds that are NOT in `children` — either because the item
   * cap kept them out or because the depth cap stopped the walk. 0 for scalars.
   * The UI needs the count to tell the reviewer that content was withheld; a
   * container that silently renders as `{2 fields}` with no affordance is
   * indistinguishable from one with nothing to show.
   */
  hiddenCount: number
  /**
   * True when the walk stopped at `PARAM_CAPS.maxDepth`. Distinct from the
   * item cap: nothing here is expandable at any price, so the UI must offer an
   * explanation rather than a toggle.
   */
  atDepthLimit: boolean
}

function isContainer(value: unknown): boolean {
  return typeof value === "object" && value !== null
}

interface SortableRow {
  row: RankedParam
  tier: number
  containerSort: number
  order: number
}

function buildRow(
  key: string,
  value: unknown,
  property: SchemaProperty | undefined,
  opts: { required: boolean; undeclared: boolean },
): RankedParam {
  return {
    key,
    value,
    required: opts.required,
    undeclared: opts.undeclared,
    container: isContainer(value),
    ...(property?.description ? { description: property.description } : {}),
    ...(property?.enum ? { enumValues: property.enum } : {}),
  }
}

function pushRow(
  rows: SortableRow[],
  tier: number,
  order: number,
  key: string,
  value: unknown,
  property: SchemaProperty | undefined,
  opts: { required: boolean; undeclared: boolean },
): void {
  const row = buildRow(key, value, property, opts)
  rows.push({ row, tier, containerSort: row.container ? 1 : 0, order })
}

// Tier 0: schema.required first. Within the tier, scalars sort before containers
// (see the sort in rankParams) — that ordering wins over schema order, because a
// reviewer reads the concrete values before the nested structures. `undeclared`
// still reflects `properties` membership — a required key absent from properties
// is a genuine schema inconsistency worth flagging, not something `required`
// should paper over.
function collectRequiredRows(
  rows: SortableRow[],
  input: Record<string, unknown>,
  properties: Record<string, unknown>,
  requiredList: string[],
  seen: Set<string>,
  startOrder: number,
): number {
  let order = startOrder
  for (const key of requiredList) {
    if (seen.has(key) || !Object.hasOwn(input, key)) continue
    seen.add(key)
    const property = properties[key] as SchemaProperty | undefined
    const undeclared = !Object.hasOwn(properties, key)
    pushRow(rows, 0, order, key, input[key], property, { required: true, undeclared })
    order += 1
  }
  return order
}

// Tier 1: schema.properties (excluding required), in schema order.
function collectDeclaredRows(
  rows: SortableRow[],
  input: Record<string, unknown>,
  properties: Record<string, unknown>,
  seen: Set<string>,
  startOrder: number,
): number {
  let order = startOrder
  for (const key of Object.keys(properties)) {
    if (seen.has(key) || !Object.hasOwn(input, key)) continue
    seen.add(key)
    const property = properties[key] as SchemaProperty
    pushRow(rows, 1, order, key, input[key], property, { required: false, undeclared: false })
    order += 1
  }
  return order
}

// Tier 2: whatever is left in input, in input order.
//
// `undeclared` must mean "the schema was consulted and this key was not in
// it" — never "we had no schema to consult". `hasSchema` is `Boolean(schema)`
// from the caller: while metadata is loading, after a failed fetch, or when
// no schema reaches this row at all, `schema` is `undefined` and EVERY input
// key would otherwise land in this tier tagged undeclared — falsely flagging
// every parameter as "not in schema" on first render of every approval card.
// A present-but-empty `properties: {}` still means the schema WAS consulted,
// so that case correctly keeps `undeclared: true`. Do not "simplify" this
// back to a hardcoded `true` — see param-relevance.ts's tests and
// AnnotatedParamsTable.render.test.tsx test (5).
//
// `hasSchema` keys on `properties`, NOT on the schema object: a real MCP server
// may emit a bare `{"type":"object"}`, and there `properties` was never
// consulted either, so nothing can be said to be absent from it.
function collectUndeclaredRows(
  rows: SortableRow[],
  input: Record<string, unknown>,
  seen: Set<string>,
  startOrder: number,
  hasSchema: boolean,
): number {
  let order = startOrder
  for (const [key, value] of Object.entries(input)) {
    if (seen.has(key)) continue
    seen.add(key)
    pushRow(rows, 2, order, key, value, undefined, { required: false, undeclared: hasSchema })
    order += 1
  }
  return order
}

export function rankParams(
  input: Record<string, unknown> | undefined,
  schema: ToolParameters | undefined,
): RankedParam[] {
  if (!input) return []

  const properties = schema?.properties ?? {}
  const requiredList = schema?.required ?? []

  const rows: SortableRow[] = []
  const seen = new Set<string>()

  let order = collectRequiredRows(rows, input, properties, requiredList, seen, 0)
  order = collectDeclaredRows(rows, input, properties, seen, order)
  collectUndeclaredRows(rows, input, seen, order, Boolean(schema?.properties))

  // Sort within tier by container type first, then by encounter order.
  rows.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.containerSort !== b.containerSort) return a.containerSort - b.containerSort
    return a.order - b.order
  })

  return rows.map((r) => r.row)
}

/** A scalar leaf: nothing to expand structurally, though `text` may be clipped. */
function leaf(text: string, fullText?: string): BoundedValue {
  return {
    text,
    truncated: fullText !== undefined,
    ...(fullText !== undefined ? { fullText } : {}),
    children: [],
    hiddenCount: 0,
    atDepthLimit: false,
  }
}

/**
 * Cuts a string to the character cap without splitting a surrogate pair.
 * `slice` counts UTF-16 code units, so landing between the halves of an
 * astral character (emoji, many CJK extension glyphs) would leave a lone
 * surrogate that renders as U+FFFD.
 *
 * Exported for `permission-intent.ts`'s intent-line clipping, which hits the
 * same surrogate-pair hazard — kept as one implementation rather than a second
 * copy drifting in the sibling module.
 */
export function sliceWholeChars(raw: string, maxChars: number): string {
  const cut = raw.slice(0, maxChars)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

export function boundValue(value: unknown, depth = 0): BoundedValue {
  if (value === null) return leaf("null")
  if (value === undefined) return leaf("undefined")

  if (!isContainer(value)) {
    const raw = String(value)
    if (raw.length <= PARAM_CAPS.maxChars) return leaf(raw)
    return leaf(sliceWholeChars(raw, PARAM_CAPS.maxChars), raw)
  }

  const entries: Array<{ key: string; value: unknown }> = Array.isArray(value)
    ? value.map((item, index) => ({ key: String(index), value: item }))
    : Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, value: item }))

  const text = Array.isArray(value) ? `[${entries.length} items]` : `{${entries.length} fields}`

  // At the depth cap, summarise without exposing children — this is also what
  // stops a circular structure from being walked forever. `hiddenCount` carries
  // how much is being withheld so the row can say so; without it the reviewer
  // sees `{2 fields}` and has no way to know a value is there at all.
  if (depth >= PARAM_CAPS.maxDepth) {
    return {
      text,
      truncated: entries.length > 0,
      children: [],
      hiddenCount: entries.length,
      atDepthLimit: true,
    }
  }

  const capped = entries.slice(0, PARAM_CAPS.maxItems)
  return {
    text,
    truncated: capped.length < entries.length,
    children: capped,
    hiddenCount: entries.length - capped.length,
    atDepthLimit: false,
  }
}
