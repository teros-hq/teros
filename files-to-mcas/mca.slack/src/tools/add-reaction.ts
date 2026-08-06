import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface AddReactionArgs {
  channel: string
  timestamp: string
  name: string
}

export const addReaction: ToolConfig = {
  description: "Add an emoji reaction to a Slack message.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel ID where the message is located",
      },
      timestamp: {
        type: "string",
        description: "Message timestamp to react to (e.g. 1234567890.123456)",
      },
      name: {
        type: "string",
        description: "Emoji name without colons (e.g. 'thumbsup', 'fire')",
      },
    },
    required: ["channel", "timestamp", "name"],
  },
  handler: async (args, context) => {
    const { channel, timestamp, name } = (args as unknown) as AddReactionArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.reactions.add({
        channel,
        timestamp,
        name,
      })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      return {
        success: true,
        channel,
        timestamp,
        reaction: name,
        message: `Added :${name}: reaction successfully`,
      }
    } catch (error) {
      handleSlackError(error, "add reaction")
    }
  },
}
