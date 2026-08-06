import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const timeoutMember: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Timeout (mute) a guild member for a specified duration. Requires Moderate Members permission.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      userId: {
        type: "string",
        description: "User ID (snowflake) of the member to timeout",
      },
      durationMinutes: {
        type: "number",
        description: "Timeout duration in minutes (max 40320 = 28 days). Default: 60",
        default: 60,
      },
      reason: {
        type: "string",
        description: "Optional audit log reason",
      },
    },
    required: ["guildId", "userId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const durationMs = Math.min(((args as any).durationMinutes ?? 60) * 60 * 1000, 28 * 24 * 60 * 60 * 1000)
      const timeoutUntil = new Date(Date.now() + durationMs).toISOString()

      const body: Record<string, unknown> = {
        communication_disabled_until: timeoutUntil,
      }

      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      const member = (await rest.patch(Routes.guildMember((args as any).guildId, (args as any).userId), { body, headers })) as Record<string, unknown>

      return {
        success: true,
        message: `User ${(args as any).userId} timed out until ${timeoutUntil}`,
        communication_disabled_until: member.communication_disabled_until,
        reason: (args as any).reason,
      }
    } catch (error) {
      handleDiscordError(error, "timeout member")
    }
  },
}
