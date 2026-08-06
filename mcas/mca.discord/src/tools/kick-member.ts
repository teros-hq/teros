import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const kickMember: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Kick a member from a guild. Requires Kick Members permission.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      userId: {
        type: "string",
        description: "User ID (snowflake) of the member to kick",
      },
      reason: {
        type: "string",
        description: "Optional audit log reason for the kick",
      },
    },
    required: ["guildId", "userId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      await rest.delete(Routes.guildMember((args as any).guildId, (args as any).userId), { headers })

      return {
        success: true,
        message: `User ${(args as any).userId} kicked from guild ${(args as any).guildId}`,
        reason: (args as any).reason,
      }
    } catch (error) {
      handleDiscordError(error, "kick member")
    }
  },
}
