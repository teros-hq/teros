import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractListItem } from "./_lists-helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListListItemsArgs {
  listId: string
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

export const listListItems: ToolConfig = {
  description:
    "List items (rows) in a Slack List with cursor pagination. Returns { listId, items, nextCursor, hasMore }. Retryable. EXPERIMENTAL. Params: listId, limit (1-100, def 50), cursor?.",
  parameters: {
    type: "object",
    properties: {
      listId: { type: "string", description: "List id." },
      limit: { type: "number", description: "Items per page (1-100, default 50)." },
      cursor: { type: "string", description: "Pagination cursor." },
    },
    required: ["listId"],
  },
  annotations: {
    version: "1.0.0",
    stability: "experimental",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { listId, limit, cursor, includeRaw} = args as unknown as ListListItemsArgs
    if (typeof listId !== "string" || listId.trim().length === 0) {
      throw new Error("listId must be a non-empty string.")
    }
    const safeLimit = sanitizeLimit(limit, { max: 100, default: 50 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      (client as any).slackLists.items.list(
        sanitiseBody({ list_id: listId, limit: safeLimit, cursor }) as any,
      ),
    )
    if (includeRaw) return result
    const items = ((result?.items ?? []) as any[]).map((it) => extractListItem(it, listId))
    return {
      listId,
      items,
      count: items.length,
      nextCursor: result?.response_metadata?.next_cursor || null,
      hasMore: Boolean(result?.response_metadata?.next_cursor),
    }
  },
}
