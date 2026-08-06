import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { MESSAGE_COMPACT_FIELDS } from "./_fields"
import {
  cleanOptionalString,
  extractMessage,
  validateChannelId,
  validateMessageTs,
} from "./_helpers"
import { resolveFieldsList, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListMessagesArgs {
  channel: string
  limit?: number
  cursor?: string
  threadTs?: string
  oldest?: string
  latest?: string
  inclusive?: boolean
  fields?: string[]
  includeRaw?: boolean
}

export const listMessages: ToolConfig = {
  description:
    "List messages from a channel or thread (passes threadTs to fetch replies). Returns curated rows { ts, channel, user, text, threadTs, replyCount, reactions, permalink, createdAt } + nextCursor + isThread. Params: channel, threadTs?, limit (1-200, def 50), cursor, oldest, latest, inclusive, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Slack channel id (C... / G... / D... / M...).",
      },
      threadTs: {
        type: "string",
        description: "Parent message ts to fetch thread replies. Format 1234567890.123456.",
      },
      limit: {
        type: "number",
        description: "Results per page. Min 1, max 200, default 50.",
      },
      cursor: {
        type: "string",
        description: "Slack cursor from previous response.nextCursor.",
      },
      oldest: {
        type: "string",
        description: "Start of time range (Unix seconds).",
      },
      latest: {
        type: "string",
        description: "End of time range (Unix seconds).",
      },
      inclusive: {
        type: "boolean",
        description: "Include boundary timestamps. Default false.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Slack message objects. Default false.",
      },
    },
    required: ["channel"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, threadTs, limit, cursor, oldest, latest, inclusive, fields, includeRaw } =
      args as unknown as ListMessagesArgs
    validateChannelId(channel, "channel")
    const cleanThreadTs = cleanOptionalString(threadTs)
    if (cleanThreadTs) validateMessageTs(cleanThreadTs, "threadTs")
    const pageSize = sanitizeLimit(limit, { max: 200, default: 50 })

    const { client } = await getSlackSession(context)
    const result = cleanThreadTs
      ? await wrapSlackCall(() =>
          client.conversations.replies({
            channel,
            ts: cleanThreadTs,
            limit: pageSize,
            cursor,
            oldest,
            latest,
            inclusive: inclusive ?? false,
          }),
        )
      : await wrapSlackCall(() =>
          client.conversations.history({
            channel,
            limit: pageSize,
            cursor,
            oldest,
            latest,
            inclusive: inclusive ?? false,
          }),
        )

    const rawMessages = result.messages ?? []
    const shaped = rawMessages.map((m: any) => extractMessage(m, { channel }))
    const messages = resolveFieldsList(shaped as any, rawMessages, {
      includeRaw,
      fields,
      defaultFields: MESSAGE_COMPACT_FIELDS,
    })

    return {
      messages,
      total: messages.length,
      hasMore: !!result.has_more || !!result.response_metadata?.next_cursor,
      nextCursor: result.response_metadata?.next_cursor || null,
      isThread: !!cleanThreadTs,
    }
  },
}
