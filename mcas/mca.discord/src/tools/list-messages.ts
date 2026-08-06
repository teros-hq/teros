import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const listMessages: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "List messages in a channel. Supports pagination via before/after/around message IDs.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Channel ID (snowflake)",
      },
      limit: {
        type: "number",
        description: "Number of messages to retrieve (1-100). Default: 50",
        default: 50,
      },
      before: {
        type: "string",
        description: "Get messages before this message ID",
      },
      after: {
        type: "string",
        description: "Get messages after this message ID",
      },
      around: {
        type: "string",
        description: "Get messages around this message ID",
      },
    },
    required: ["channelId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const params = new URLSearchParams()
      if ((args as any).limit) params.set("limit", String(Math.min((args as any).limit, 100)))
      if ((args as any).before) params.set("before", (args as any).before)
      if ((args as any).after) params.set("after", (args as any).after)
      if ((args as any).around) params.set("around", (args as any).around)

      const qs = params.toString()
      const path = qs
        ? `${Routes.channelMessages((args as any).channelId as `/${string}`)}?${qs}`
        : Routes.channelMessages((args as any).channelId as `/${string}`)
      const messages = (await rest.get(path as `/${string}`)) as Array<Record<string, unknown>>

      return {
        messages: messages.map((m) => ({
          id: m.id,
          channel_id: m.channel_id,
          author: m.author
            ? {
                id: (m.author as any).id,
                username: (m.author as any).username,
                global_name: (m.author as any).global_name,
                bot: (m.author as any).bot,
              }
            : null,
          content: m.content,
          timestamp: m.timestamp,
          edited_timestamp: m.edited_timestamp,
          tts: m.tts,
          mention_everyone: m.mention_everyone,
          mentions: m.mentions,
          attachments: m.attachments,
          embeds: m.embeds,
          reactions: m.reactions,
          pinned: m.pinned,
          type: m.type,
          thread: m.thread,
          referenced_message: m.referenced_message,
        })),
        total: messages.length,
      }
    } catch (error) {
      handleDiscordError(error, "list messages")
    }
  },
}
