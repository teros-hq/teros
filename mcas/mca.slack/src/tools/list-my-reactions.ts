import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { isUserId } from "./_helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListMyReactionsArgs {
  userId?: string
  count?: number
  page?: number
  full?: boolean
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

interface CuratedReactionItem {
  type: "message" | "file" | string
  channel: string | null
  ts: string | null
  fileId: string | null
  reaction: string
}

export const listMyReactions: ToolConfig = {
  description:
    "List all items the user has reacted to (messages and files). Returns { items, paging }. Retryable. Params: userId? (def authed), count (1-1000, def 100), page, full (def true).",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User id (def authed)." },
      count: { type: "number", description: "Items per page (1-1000, def 100)." },
      page: { type: "number", description: "Page number (1-indexed)." },
      full: { type: "boolean", description: "Include all reactors. Default true." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { userId, count, page, full, limit, includeRaw} = args as unknown as ListMyReactionsArgs
    if (userId !== undefined && !isUserId(userId)) {
      throw new Error(`Invalid userId: expected U.../W..., got "${userId}"`)
    }
    const safeCount = sanitizeLimit(limit ?? count, { max: 1000, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.reactions.list(
        sanitiseBody({ user: userId, count: safeCount, page, full: full ?? true }) as any,
      ),
    )
    if (includeRaw) return result
    const rawItems = ((result as any).items ?? []) as any[]
    const items: CuratedReactionItem[] = []
    for (const it of rawItems) {
      const reactions = Array.isArray(it?.message?.reactions)
        ? it.message.reactions
        : Array.isArray(it?.file?.reactions)
          ? it.file.reactions
          : []
      for (const r of reactions) {
        items.push({
          type: it.type ?? "message",
          channel: it?.channel ?? null,
          ts: it?.message?.ts ?? null,
          fileId: it?.file?.id ?? null,
          reaction: r?.name ?? "",
        })
      }
    }
    return {
      userId: userId ?? null,
      items,
      count: items.length,
      paging: (result as any).paging ?? null,
    }
  },
}
