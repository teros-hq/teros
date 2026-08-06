import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError, buildEmbed } from "../lib"
import { Routes } from "discord.js"

export const sendMessage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Send a message to a Discord channel. Supports text, embeds, mentions, and replies.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Channel ID (snowflake) to send the message to",
      },
      content: {
        type: "string",
        description: "Message text content (max 2000 characters, 4000 for nitro)",
      },
      embeds: {
        type: "string",
        description: "Optional JSON string of embed objects array. Use buildEmbed helper or pass raw JSON.",
      },
      replyToMessageId: {
        type: "string",
        description: "Optional message ID to reply to",
      },
      mentionEveryone: {
        type: "boolean",
        description: "Allow @everyone and @here mentions. Default: false",
        default: false,
      },
      mentionRoles: {
        type: "boolean",
        description: "Allow @role mentions. Default: true",
        default: true,
      },
      mentionUsers: {
        type: "boolean",
        description: "Allow @user mentions. Default: true",
        default: true,
      },
      tts: {
        type: "boolean",
        description: "Send as text-to-speech. Default: false",
        default: false,
      },
    },
    required: ["channelId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)

      const body: Record<string, unknown> = {
        allowed_mentions: {
          parse: [] as string[],
          roles: [] as string[],
          users: [] as string[],
          replied_user: false,
        },
      }

      if ((args as any).content) body.content = (args as any).content
      if ((args as any).tts) body.tts = (args as any).tts

      if ((args as any).embeds) {
        try {
          body.embeds = JSON.parse((args as any).embeds)
        } catch {
          throw new Error("Invalid embeds JSON. Must be a valid JSON array of embed objects.")
        }
      }

      if ((args as any).replyToMessageId) {
        body.message_reference = {
          message_id: (args as any).replyToMessageId,
          channel_id: (args as any).channelId,
        }
      }

      // Build allowed mentions
      const parse: string[] = []
      if ((args as any).mentionEveryone) parse.push("everyone")
      if ((args as any).mentionRoles ?? true) parse.push("roles")
      if ((args as any).mentionUsers ?? true) parse.push("users")
      ;(body.allowed_mentions as Record<string, unknown>).parse = parse

      const message = (await rest.post(Routes.channelMessages((args as any).channelId), { body })) as Record<string, unknown>

      return {
        success: true,
        id: message.id,
        channel_id: message.channel_id,
        content: message.content,
        timestamp: message.timestamp,
        url: `https://discord.com/channels/${(message as any).guild_id ?? "@me"}/${message.channel_id}/${message.id}`,
      }
    } catch (error) {
      handleDiscordError(error, "send message")
    }
  },
}
