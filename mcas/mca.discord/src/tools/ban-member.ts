import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const banMember: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Ban a member from a guild. Optionally delete their message history. Requires Ban Members permission.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      userId: {
        type: "string",
        description: "User ID (snowflake) of the member to ban",
      },
      deleteMessageSeconds: {
        type: "number",
        description: "Number of seconds to delete messages for (0-604800, 7 days max). Default: 0",
        default: 0,
      },
      reason: {
        type: "string",
        description: "Optional audit log reason for the ban",
      },
    },
    required: ["guildId", "userId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const body: Record<string, unknown> = {
        delete_message_seconds: Math.min((args as any).deleteMessageSeconds ?? 0, 604800),
      }

      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      await rest.put(Routes.guildBan((args as any).guildId, (args as any).userId), { body, headers })

      return {
        success: true,
        message: `User ${(args as any).userId} banned from guild ${(args as any).guildId}`,
        deleteMessageSeconds: (args as any).deleteMessageSeconds ?? 0,
        reason: (args as any).reason,
      }
    } catch (error) {
      handleDiscordError(error, "ban member")
    }
  },
}
