import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const assignRole: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Add a role to a guild member. Requires Manage Roles permission with the bot's role above the target role.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      userId: {
        type: "string",
        description: "User ID (snowflake) to assign the role to",
      },
      roleId: {
        type: "string",
        description: "Role ID (snowflake) to assign",
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

      await rest.put(Routes.guildMemberRole((args as any).guildId, (args as any).userId, (args as any).roleId), { headers })

      return {
        success: true,
        message: `Role ${(args as any).roleId} assigned to user ${(args as any).userId}`,
      }
    } catch (error) {
      handleDiscordError(error, "assign role")
    }
  },
}
