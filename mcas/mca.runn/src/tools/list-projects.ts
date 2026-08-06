import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnProject, runnList } from "../lib"
import { PROJECT_COMPACT_FIELDS } from "./_fields"
import { validateId } from "./_runn-helpers"
import { resolveFieldsList, sanitizeLimit } from "./utils"

export const listProjects: ToolConfig = {
  description:
    "List Runn projects. Returns { items: [{ id, name, clientId, isArchived, isConfirmed, createdAt, updatedAt }], total, hasMore, nextCursor }. Params: clientId?, isArchived?, limit (1-200, def 50), cursor?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "number", description: "Filter by client id." },
      isArchived: { type: "boolean", description: "Filter by archived state." },
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
        description: "Return raw Runn project objects. Default false.",
      },
    },
  },
  annotations: { version: "1.0.0", stability: "stable", readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const { clientId, isArchived, limit, cursor, fields, includeRaw } = args as {
      clientId?: number
      isArchived?: boolean
      limit?: number
      cursor?: string
      fields?: string[]
      includeRaw?: boolean
    }
    if (clientId !== undefined) validateId(clientId, "clientId")

    const page = await runnList<RunnProject>("/projects", context, {
      limit: sanitizeLimit(limit, { max: 200, default: 50 }),
      cursor,
      query: { clientId, isArchived },
    })
    const items = resolveFieldsList(page.values as any, page.values, {
      includeRaw,
      fields,
      defaultFields: PROJECT_COMPACT_FIELDS,
    })
    return {
      items,
      total: items.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
    }
  },
}
