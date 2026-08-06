import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface GetUserPresenceArgs {
  userId: string
}

export const getUserPresence: ToolConfig = {
  description: "Get the online/presence status of a Slack user.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Slack user ID (e.g. U1234567890)",
      },
    },
    required: ["userId"],
  },
  handler: async (args, context) => {
    const { userId } = (args as unknown) as GetUserPresenceArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.users.getPresence({ user: userId })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      return {
        userId,
        presence: result.presence,
        online: result.online,
        autoAway: result.auto_away,
        manualAway: result.manual_away,
        connectionCount: result.connection_count,
        lastActivity: result.last_activity,
      }
    } catch (error) {
      handleSlackError(error, "get user presence")
    }
  },
}
