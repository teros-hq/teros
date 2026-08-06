import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const deleteMessage: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description: "Delete a message from a channel. Requires Manage Messages permission if not the message author.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Channel ID (snowflake)",
      },
      messageId: {
        type: "string",
        description: "Message ID (snowflake) to delete",
      },
      reason: {
        type: "string",
        description: "Optional audit log reason",
      },
    },
    required: ["channelId", "messageId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      await rest.delete(Routes.channelMessage((args as any).channelId, (args as any).messageId), { headers })

      return {
        success: true,
        message: `Message ${(args as any).messageId} deleted from channel ${(args as any).channelId}`,
      }
    } catch (error) {
      handleDiscordError(error, "delete message")
    }
  },
}
