import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnAssignment, runnList } from "../lib"
import { ASSIGNMENT_FIELDS } from "./_fields"
import { validateId } from "./_runn-helpers"
import { resolveFieldsList, sanitizeLimit } from "./utils"

/**
 * Runn exposes assignments globally and scoped per person/project. We route to
 * the most specific documented endpoint so the filter is applied server-side.
 * `personId` and `projectId` are mutually exclusive scopes here.
 */
function assignmentsEndpoint(personId?: number, projectId?: number): string {
  if (personId !== undefined) return `/people/${personId}/assignments`
  if (projectId !== undefined) return `/projects/${projectId}/assignments`
  return "/assignments"
}

export const listAssignments: ToolConfig = {
  description:
    "List Runn assignments (a person/placeholder allocated to a project at a role over a date range). Returns { items: [{ id, personId, projectId, roleId, startDate, endDate, minutesPerDay, isBillable, isPlaceholder, ... }], total, hasMore, nextCursor }. Filter by personId OR projectId (not both). Params: personId?, projectId?, limit (1-200, def 50), cursor?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      personId: { type: "number", description: "Scope to one person's assignments." },
      projectId: { type: "number", description: "Scope to one project's assignments." },
      limit: { type: "number", description: "Results per page. Min 1, max 200, default 50." },
      cursor: {
        type: "string",
        description: "Pagination cursor from a previous response.nextCursor.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Runn assignment objects. Default false.",
      },
    },
  },
  annotations: { version: "1.0.0", stability: "stable", readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const { personId, projectId, limit, cursor, fields, includeRaw } = args as {
      personId?: number
      projectId?: number
      limit?: number
      cursor?: string
      fields?: string[]
      includeRaw?: boolean
    }
    if (personId !== undefined) validateId(personId, "personId")
    if (projectId !== undefined) validateId(projectId, "projectId")

    const page = await runnList<RunnAssignment>(assignmentsEndpoint(personId, projectId), context, {
      limit: sanitizeLimit(limit, { max: 200, default: 50 }),
      cursor,
    })
    const items = resolveFieldsList(page.values as any, page.values, {
      includeRaw,
      fields,
      defaultFields: ASSIGNMENT_FIELDS,
    })
    return {
      items,
      total: items.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
    }
  },
}
