import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListChannelMembersArgs {
  channelId: string
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

export const listChannelMembers: ToolConfig = {
  description:
    "List user ids that are members of a channel. Returns { channelId, members: string[], nextCursor, hasMore }. Retryable. Use list-users + lookup if you need profile info. Params: channelId, limit (1-1000, def 200), cursor?.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id (C... / G... / D... / M...)." },
      limit: { type: "number", description: "Max members per page (1-1000, default 200)." },
      cursor: { type: "string", description: "Pagination cursor." },
    },
    required: ["channelId"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, limit, cursor, includeRaw} = args as unknown as ListChannelMembersArgs
    validateChannelId(channelId, "channelId")
    const safeLimit = sanitizeLimit(limit, { max: 1000, default: 200 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.conversations.members(
        sanitiseBody({ channel: channelId, limit: safeLimit, cursor }) as any,
      ),
    )
    if (includeRaw) return result
    const members = (result.members ?? []) as string[]
    return {
      channelId,
      members,
      count: members.length,
      nextCursor: result.response_metadata?.next_cursor || null,
      hasMore: Boolean(result.response_metadata?.next_cursor),
    }
  },
}
