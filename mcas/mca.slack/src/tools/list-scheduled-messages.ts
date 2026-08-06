import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { tsToIso } from "./_helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListScheduledMessagesArgs {
  channel?: string
  latest?: string
  oldest?: string
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

interface CuratedScheduled {
  id: string
  channelId: string
  postAt: number | null
  postAtIso: string | null
  text: string
}

function extractScheduled(raw: any): CuratedScheduled {
  return {
    id: raw?.id ?? "",
    channelId: raw?.channel_id ?? "",
    postAt: typeof raw?.post_at === "number" ? raw.post_at : null,
    postAtIso: tsToIso(raw?.post_at),
    text: raw?.text ?? "",
  }
}

export const listScheduledMessages: ToolConfig = {
  description:
    "List pending scheduled messages for the authenticated user. Returns { messages: [{ id, channelId, postAt, postAtIso, text }], nextCursor, hasMore }. Retryable. Params: channel?, latest?, oldest? (unix-seconds bounds), limit (1-100, def 100), cursor?.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Filter to a single channel id." },
      latest: { type: "string", description: "Upper bound (unix-seconds string)." },
      oldest: { type: "string", description: "Lower bound (unix-seconds string)." },
      limit: { type: "number", description: "Max items (1-100, default 100)." },
      cursor: { type: "string", description: "Pagination cursor from a previous call." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, latest, oldest, limit, cursor, includeRaw} = args as unknown as ListScheduledMessagesArgs
    const safeLimit = sanitizeLimit(limit, { max: 100, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.chat.scheduledMessages.list(
        sanitiseBody({ channel, latest, oldest, limit: safeLimit, cursor }) as any,
      ),
    )
    if (includeRaw) return result
    const raw = (result.scheduled_messages ?? []) as any[]
    return {
      messages: raw.map(extractScheduled),
      nextCursor: result.response_metadata?.next_cursor || null,
      hasMore: Boolean(result.response_metadata?.next_cursor),
    }
  },
}
