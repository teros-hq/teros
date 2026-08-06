import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const listWebhooks: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "List webhooks in a guild or channel. Requires Manage Webhooks permission.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake) to list all webhooks in the guild",
      },
      channelId: {
        type: "string",
        description: "Channel ID (snowflake) to list webhooks in a specific channel",
      },
    },
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      let webhooks: Array<Record<string, unknown>>

      if ((args as any).channelId) {
        webhooks = (await rest.get(Routes.channelWebhooks((args as any).channelId))) as Array<Record<string, unknown>>
      } else if ((args as any).guildId) {
        webhooks = (await rest.get(Routes.guildWebhooks((args as any).guildId))) as Array<Record<string, unknown>>
      } else {
        throw new Error("Either guildId or channelId is required")
      }

      return {
        webhooks: webhooks.map((w) => ({
          id: w.id,
          type: w.type,
          guild_id: w.guild_id,
          channel_id: w.channel_id,
          name: w.name,
          avatar: w.avatar,
          token: w.token,
          application_id: w.application_id,
          user: w.user
            ? {
                id: (w.user as any).id,
                username: (w.user as any).username,
                global_name: (w.user as any).global_name,
              }
            : null,
        })),
        total: webhooks.length,
      }
    } catch (error) {
      handleDiscordError(error, "list webhooks")
    }
  },
}
