import type { ToolConfig } from "@teros/mca-sdk"
import { type RunnClient, runnList } from "../lib"
import { CLIENT_FIELDS } from "./_fields"
import { resolveFieldsList, sanitizeLimit } from "./utils"

export const listClients: ToolConfig = {
  description:
    "List Runn clients. Returns { items: [{ id, name, website, isArchived, references, createdAt, updatedAt }], total, hasMore, nextCursor }. Params: limit (1-200, def 50), cursor?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
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
        description: "Return raw Runn client objects. Default false.",
      },
    },
  },
  annotations: { version: "1.0.0", stability: "stable", readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const { limit, cursor, fields, includeRaw } = args as {
      limit?: number
      cursor?: string
      fields?: string[]
      includeRaw?: boolean
    }

    const page = await runnList<RunnClient>("/clients", context, {
      limit: sanitizeLimit(limit, { max: 200, default: 50 }),
      cursor,
    })
    const items = resolveFieldsList(page.values as any, page.values, {
      includeRaw,
      fields,
      defaultFields: CLIENT_FIELDS,
    })
    return {
      items,
      total: items.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
    }
  },
}
