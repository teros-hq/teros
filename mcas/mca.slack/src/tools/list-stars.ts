import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListStarsArgs {
  count?: number
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

interface CuratedStarItem {
  type: "message" | "file" | "file_comment" | "channel" | string
  channel: string | null
  ts: string | null
  fileId: string | null
}

export const listStars: ToolConfig = {
  description:
    "List the user's saved items (stars). Returns { items, nextCursor, hasMore }. Retryable. Params: count (1-1000, def 100), cursor?.",
  parameters: {
    type: "object",
    properties: {
      count: { type: "number", description: "Items per page (1-1000, def 100)." },
      cursor: { type: "string", description: "Pagination cursor." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { count, limit, cursor, includeRaw} = args as unknown as ListStarsArgs
    const safeCount = sanitizeLimit(limit ?? count, { max: 1000, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.stars.list(sanitiseBody({ count: safeCount, cursor }) as any),
    )
    if (includeRaw) return result
    const raw = ((result as any).items ?? []) as any[]
    const items: CuratedStarItem[] = raw.map((it) => ({
      type: it?.type ?? "message",
      channel: it?.channel ?? null,
      ts: it?.message?.ts ?? null,
      fileId: it?.file?.id ?? null,
    }))
    return {
      items,
      count: items.length,
      nextCursor: (result as any).response_metadata?.next_cursor || null,
      hasMore: Boolean((result as any).response_metadata?.next_cursor),
    }
  },
}
