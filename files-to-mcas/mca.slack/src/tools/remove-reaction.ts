import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface RemoveReactionArgs {
  channel: string
  timestamp: string
  name: string
}

export const removeReaction: ToolConfig = {
  description: "Remove an emoji reaction from a Slack message.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel ID where the message is located",
      },
      timestamp: {
        type: "string",
        description: "Message timestamp",
      },
      name: {
        type: "string",
        description: "Emoji name without colons (e.g. 'thumbsup')",
      },
    },
    required: ["channel", "timestamp", "name"],
  },
  handler: async (args, context) => {
    const { channel, timestamp, name } = (args as unknown) as RemoveReactionArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.reactions.remove({
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
        message: `Removed :${name}: reaction successfully`,
      }
    } catch (error) {
      handleSlackError(error, "remove reaction")
    }
  },
}
