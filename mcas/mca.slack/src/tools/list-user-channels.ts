import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractChannel, isUserId } from "./_helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListUserChannelsArgs {
  userId?: string
  types?: string
  excludeArchived?: boolean
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

export const listUserChannels: ToolConfig = {
  description:
    "List channels a user is a member of. Returns { channels, nextCursor, hasMore }. Retryable. Params: userId? (def authed), types? (csv: public_channel,private_channel,mpim,im), excludeArchived (def true), limit (1-1000, def 200), cursor?.",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User id (def authenticated user)." },
      types: {
        type: "string",
        description: "Comma-separated types: public_channel,private_channel,mpim,im.",
      },
      excludeArchived: { type: "boolean", description: "Skip archived. Default true." },
      limit: { type: "number", description: "Per page (1-1000, default 200)." },
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
    const { userId, types, excludeArchived, limit, cursor, includeRaw} = args as unknown as ListUserChannelsArgs
    if (userId !== undefined && !isUserId(userId)) {
      throw new Error(`Invalid userId: expected U.../W..., got "${userId}"`)
    }
    const safeLimit = sanitizeLimit(limit, { max: 1000, default: 200 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.users.conversations(
        sanitiseBody({
          user: userId,
          types,
          exclude_archived: excludeArchived ?? true,
          limit: safeLimit,
          cursor,
        }) as any,
      ),
    )
    if (includeRaw) return result
    const channels = ((result.channels ?? []) as any[]).map(extractChannel)
    return {
      userId: userId ?? null,
      channels,
      count: channels.length,
      nextCursor: result.response_metadata?.next_cursor || null,
      hasMore: Boolean(result.response_metadata?.next_cursor),
    }
  },
}
