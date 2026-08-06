/**
 * Slack Canvas API helpers (feature 2024+, experimental).
 *
 * Canvases son documentos rich-text colaborativos. La API expone CRUD básico
 * + un modelo de "changes" para edits parciales (insert/replace/delete).
 */

import { tsToIso } from "./_helpers"

export interface CuratedCanvas {
  id: string
  title: string
  channelId: string | null
  isStandalone: boolean
  createdAt: string | null
  updatedAt: string | null
  ownerUserId: string | null
}

export function extractCanvas(raw: any, channelIdHint?: string | null): CuratedCanvas {
  return {
    id: raw?.id ?? raw?.canvas_id ?? "",
    title: raw?.title ?? "",
    channelId: raw?.channel_id ?? channelIdHint ?? null,
    isStandalone: Boolean(raw?.is_standalone ?? !raw?.channel_id),
    createdAt: tsToIso(raw?.date_created ?? raw?.created),
    updatedAt: tsToIso(raw?.date_updated ?? raw?.updated),
    ownerUserId: raw?.owner_user_id ?? raw?.created_by ?? null,
  }
}

// Valid `operation` values per Slack canvases.edit docs (2026):
// https://docs.slack.dev/reference/methods/canvases.edit/
//   - insert_at_start: append section at the start of the canvas
//   - insert_at_end:   append section at the end (no section_id required)
//   - insert_before:   insert before a section (section_id required)
//   - insert_after:    insert after a section (section_id required)
//   - replace:         replace a section's content (section_id + document_content required)
//   - delete:          delete a section (section_id required)
//
// Previous declaration ("insert" | "replace" | "delete") was wrong — Slack
// rejected every call with `invalid_arguments` because "insert" alone is not
// a valid operation. See QA report 2026-05-14 round-3.
export type CanvasOperation =
  | "insert_at_start"
  | "insert_at_end"
  | "insert_before"
  | "insert_after"
  | "replace"
  | "delete"

const CANVAS_OPERATIONS: readonly CanvasOperation[] = [
  "insert_at_start",
  "insert_at_end",
  "insert_before",
  "insert_after",
  "replace",
  "delete",
]

const SECTION_ID_REQUIRED: ReadonlySet<CanvasOperation> = new Set([
  "insert_before",
  "insert_after",
  "replace",
  "delete",
])

const DOCUMENT_CONTENT_REQUIRED: ReadonlySet<CanvasOperation> = new Set([
  "insert_at_start",
  "insert_at_end",
  "insert_before",
  "insert_after",
  "replace",
])

export interface CanvasChange {
  operation: CanvasOperation
  section_id?: string
  document_content?: { type: "markdown"; markdown: string }
}

export function parseChanges(input: string | undefined): CanvasChange[] {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("changes must be a non-empty JSON array.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (err) {
    throw new Error(
      `Invalid changes JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!Array.isArray(parsed)) throw new Error("changes must parse to a JSON array.")
  return parsed.map((c, i) => {
    const op = (c as any)?.operation
    if (!CANVAS_OPERATIONS.includes(op)) {
      throw new Error(
        `changes[${i}].operation must be one of ${CANVAS_OPERATIONS.join("|")} (got "${op}")`,
      )
    }
    // Slack accepts either camelCase `sectionId` or snake_case `section_id`
    // from callers; serialise to snake_case for the API.
    const section_id = (c as any).section_id ?? (c as any).sectionId
    const document_content = (c as any).document_content ?? (c as any).documentContent
    if (SECTION_ID_REQUIRED.has(op as CanvasOperation)) {
      if (typeof section_id !== "string" || section_id.trim().length === 0) {
        throw new Error(
          `changes[${i}].section_id is required for operation "${op}". Use canvases.sections.lookup to find one.`,
        )
      }
    }
    if (DOCUMENT_CONTENT_REQUIRED.has(op as CanvasOperation)) {
      if (
        !document_content ||
        typeof document_content !== "object" ||
        (document_content as any).type !== "markdown" ||
        typeof (document_content as any).markdown !== "string"
      ) {
        throw new Error(
          `changes[${i}].document_content is required for operation "${op}" and must be { type: "markdown", markdown: string }.`,
        )
      }
    }
    const out: CanvasChange = { operation: op }
    if (section_id) out.section_id = section_id
    if (document_content) out.document_content = document_content
    return out
  })
}
