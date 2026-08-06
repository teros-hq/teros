import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface JoinChannelArgs {
  channelId: string
}

export const joinChannel: ToolConfig = {
  description: "Join a Slack public channel by ID or name.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel ID (e.g. C1234567890)",
      },
    },
    required: ["channelId"],
  },
  handler: async (args, context) => {
    const { channelId } = (args as unknown) as JoinChannelArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.conversations.join({ channel: channelId })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      return { success: true, channelId, message: "Joined channel successfully" }
    } catch (error) {
      handleSlackError(error, "join channel")
    }
  },
}
