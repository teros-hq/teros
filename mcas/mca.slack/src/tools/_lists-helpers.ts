/**
 * Slack Lists API helpers (feature 2024+, marked experimental).
 *
 * Lists are structured collaborative tables in Slack with column-based schemas.
 * The Web API is `slackLists.*` (and `slackLists.items.*` for row CRUD).
 * The shape is still evolving in the official SDK; helpers here keep the
 * curated camelCase output stable even if upstream renames fields.
 */

import { tsToIso } from "./_helpers"

export interface CuratedList {
  id: string
  name: string
  description: string | null
  todoMode: boolean
  schema: Array<{ id: string; name: string; type: string; required: boolean }>
  itemCount: number | null
  createdAt: string | null
  updatedAt: string | null
}

export interface CuratedListItem {
  id: string
  listId: string
  fields: Record<string, unknown>
  createdAt: string | null
  updatedAt: string | null
}

export function extractList(raw: any): CuratedList {
  const cols = Array.isArray(raw?.schema) ? raw.schema : raw?.columns
  return {
    id: raw?.id ?? "",
    name: raw?.name ?? "",
    description: raw?.description || null,
    todoMode: Boolean(raw?.todo_mode),
    schema: Array.isArray(cols)
      ? cols.map((c: any) => ({
          id: c?.id ?? c?.key ?? "",
          name: c?.name ?? "",
          type: c?.type ?? c?.field_type ?? "text",
          required: Boolean(c?.is_required ?? c?.required),
        }))
      : [],
    itemCount:
      typeof raw?.item_count === "number"
        ? raw.item_count
        : typeof raw?.items_count === "number"
          ? raw.items_count
          : null,
    createdAt: tsToIso(raw?.date_created ?? raw?.created),
    updatedAt: tsToIso(raw?.date_updated ?? raw?.updated),
  }
}

export function extractListItem(raw: any, listId: string): CuratedListItem {
  return {
    id: raw?.id ?? "",
    listId: raw?.list_id ?? listId,
    fields: raw?.fields ?? raw?.values ?? {},
    createdAt: tsToIso(raw?.date_created ?? raw?.created),
    updatedAt: tsToIso(raw?.date_updated ?? raw?.updated),
  }
}

export function parseFieldsJson(input: string | undefined): Record<string, unknown> | undefined {
  if (input === undefined) return undefined
  if (typeof input !== "string" || input.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(input)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    throw new Error("fields must parse to a JSON object.")
  } catch (err) {
    throw new Error(
      `Invalid fields JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
