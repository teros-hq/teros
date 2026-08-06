import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const createWebhook: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Create a new webhook in a channel. Requires Manage Webhooks permission. Returns the webhook token for sending messages.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Channel ID (snowflake) to create the webhook in",
      },
      name: {
        type: "string",
        description: "Webhook name (1-80 characters, cannot contain 'clyde' or 'discord')",
      },
      avatar: {
        type: "string",
        description: "Base64-encoded avatar image (PNG/JPEG/GIF, max 128x128)",
      },
      reason: {
        type: "string",
        description: "Optional audit log reason",
      },
    },
    required: ["channelId", "name"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const body: Record<string, unknown> = {
        name: (args as any).name,
      }
      if ((args as any).avatar) body.avatar = (args as any).avatar

      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      const webhook = (await rest.post(Routes.channelWebhooks((args as any).channelId), { body, headers })) as Record<string, unknown>

      return {
        id: webhook.id,
        type: webhook.type,
        guild_id: webhook.guild_id,
        channel_id: webhook.channel_id,
        name: webhook.name,
        avatar: webhook.avatar,
        token: webhook.token,
        url: `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`,
      }
    } catch (error) {
      handleDiscordError(error, "create webhook")
    }
  },
}
