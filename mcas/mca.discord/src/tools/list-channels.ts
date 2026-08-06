import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const listChannels: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "List channels in a guild. Returns text, voice, category, and other channel types.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
    },
    required: ["guildId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const channels = (await rest.get(Routes.guildChannels((args as any).guildId))) as Array<Record<string, unknown>>

      return {
        channels: channels.map((ch) => ({
          id: ch.id,
          type: ch.type,
          name: ch.name,
          position: ch.position,
          parent_id: ch.parent_id,
          nsfw: ch.nsfw,
          topic: ch.topic,
          bitrate: ch.bitrate,
          user_limit: ch.user_limit,
          rate_limit_per_user: ch.rate_limit_per_user,
          last_message_id: ch.last_message_id,
          permission_overwrites: ch.permission_overwrites,
        })),
        total: channels.length,
      }
    } catch (error) {
      handleDiscordError(error, "list channels")
    }
  },
}
