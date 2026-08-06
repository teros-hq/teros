import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface ListMessagesArgs {
  channel: string
  limit?: number
  cursor?: string
  threadTs?: string
  oldest?: string
  latest?: string
  inclusive?: boolean
}

export const listMessages: ToolConfig = {
  description: "List messages from a Slack channel or thread. Supports pagination and time range.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel ID to fetch messages from",
      },
      limit: {
        type: "number",
        description: "Max messages (1-200). Default: 50",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor",
      },
      threadTs: {
        type: "string",
        description: "If provided, fetch replies in this thread instead of channel history",
      },
      oldest: {
        type: "string",
        description: "Start of time range (Unix timestamp string). Default: 24h ago",
      },
      latest: {
        type: "string",
        description: "End of time range (Unix timestamp string). Default: now",
      },
      inclusive: {
        type: "boolean",
        description: "Include messages at the boundary timestamps. Default: false",
      },
    },
    required: ["channel"],
  },
  handler: async (args, context) => {
    const { channel, limit, cursor, threadTs, oldest, latest, inclusive } = (args as unknown) as ListMessagesArgs
    try {
      const { client } = await getSlackSession(context)

      let result: any
      if (threadTs) {
        result = await client.conversations.replies({
          channel,
          ts: threadTs,
          limit: limit ?? 50,
          cursor,
          oldest,
          latest,
          inclusive: inclusive ?? false,
        })
      } else {
        result = await client.conversations.history({
          channel,
          limit: limit ?? 50,
          cursor,
          oldest,
          latest,
          inclusive: inclusive ?? false,
        })
      }

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const messages = (result.messages ?? []).map((m: any) => ({
        ts: m.ts,
        user: m.user ?? m.bot_id ?? "system",
        text: m.text ?? "",
        type: m.type,
        subtype: m.subtype ?? null,
        threadTs: m.thread_ts ?? null,
        replyCount: m.reply_count ?? 0,
        reactions: (m.reactions ?? []).map((r: any) => ({
          name: r.name,
          count: r.count,
          users: r.users ?? [],
        })),
        attachments: m.attachments ?? [],
        edited: m.edited ? { user: m.edited.user, ts: m.edited.ts } : null,
        blocks: m.blocks ?? [],
        files: (m.files ?? []).map((f: any) => ({
          id: f.id,
          name: f.name,
          url: f.url_private ?? f.permalink ?? "",
          mimetype: f.mimetype,
          size: f.size,
        })),
      }))

      return {
        messages,
        hasMore: result.has_more ?? false,
        nextCursor: result.response_metadata?.next_cursor ?? null,
        total: messages.length,
        isThread: !!threadTs,
      }
    } catch (error) {
      handleSlackError(error, "list messages")
    }
  },
}
