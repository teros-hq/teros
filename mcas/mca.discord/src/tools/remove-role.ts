import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const removeRole: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Remove a role from a guild member. Requires Manage Roles permission.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      userId: {
        type: "string",
        description: "User ID (snowflake) to remove the role from",
      },
      roleId: {
        type: "string",
        description: "Role ID (snowflake) to remove",
      },
      reason: {
        type: "string",
        description: "Optional audit log reason",
      },
    },
    required: ["guildId", "userId", "roleId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      await rest.delete(Routes.guildMemberRole((args as any).guildId, (args as any).userId, (args as any).roleId), { headers })

      return {
        success: true,
        message: `Role ${(args as any).roleId} removed from user ${(args as any).userId}`,
      }
    } catch (error) {
      handleDiscordError(error, "remove role")
    }
  },
}
