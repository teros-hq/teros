import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { CHANNEL_COMPACT_FIELDS } from "./_fields"
import { extractChannel } from "./_helpers"
import { resolveFieldsList, sanitizeLimit, wrapSlackCall } from "./utils"

const TYPE_ENUM = ["public_channel", "private_channel", "mpim", "im"] as const

interface ListChannelsArgs {
  types?: string
  limit?: number
  cursor?: string
  excludeArchived?: boolean
  fields?: string[]
  includeRaw?: boolean
}

export const listChannels: ToolConfig = {
  description:
    "List channels. Returns curated rows { id, name, isPrivate, isArchived, isMember, numMembers, topic, purpose, created } + nextCursor. Params: types? (CSV public_channel|private_channel|mpim|im), limit (1-1000, def 100), cursor, excludeArchived (def true), fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      types: {
        type: "string",
        description: "Comma-separated channel types from " + TYPE_ENUM.join(", ") + ". Default: public_channel,private_channel.",
      },
      limit: {
        type: "number",
        description: "Results per page. Min 1, max 1000, default 100.",
      },
      cursor: {
        type: "string",
        description: "Slack cursor from previous response.nextCursor.",
      },
      excludeArchived: {
        type: "boolean",
        description: "Exclude archived channels. Default true.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Slack channel objects. Default false.",
      },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { types, limit, cursor, excludeArchived, fields, includeRaw } = args as ListChannelsArgs
    const pageSize = sanitizeLimit(limit, { max: 1000, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.conversations.list({
        types: types ?? "public_channel,private_channel",
        limit: pageSize,
        cursor,
        exclude_archived: excludeArchived ?? true,
      }),
    )

    const rawChannels = result.channels ?? []
    const shaped = rawChannels.map(extractChannel)
    const channels = resolveFieldsList(shaped as any, rawChannels, {
      includeRaw,
      fields,
      defaultFields: CHANNEL_COMPACT_FIELDS,
    })

    return {
      channels,
      total: channels.length,
      hasMore: !!result.response_metadata?.next_cursor,
      nextCursor: result.response_metadata?.next_cursor || null,
    }
  },
}
