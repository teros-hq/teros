import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const deleteChannel: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description: "Delete a channel or close a DM. Requires Manage Channels permission for guild channels.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Channel ID (snowflake) to delete",
      },
      reason: {
        type: "string",
        description: "Optional audit log reason",
      },
    },
    required: ["channelId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      const channel = (await rest.delete(Routes.channel((args as any).channelId), { headers })) as Record<string, unknown>

      return {
        success: true,
        id: channel.id,
        name: channel.name,
        type: channel.type,
        message: "Channel deleted successfully",
      }
    } catch (error) {
      handleDiscordError(error, "delete channel")
    }
  },
}
