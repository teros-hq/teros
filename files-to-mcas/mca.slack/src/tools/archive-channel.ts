import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface ArchiveChannelArgs {
  channelId: string
}

export const archiveChannel: ToolConfig = {
  description: "Archive (close) a Slack channel. Archived channels are read-only.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel ID to archive",
      },
    },
    required: ["channelId"],
  },
  handler: async (args, context) => {
    const { channelId } = (args as unknown) as ArchiveChannelArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.conversations.archive({ channel: channelId })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      return { success: true, channelId, message: "Channel archived successfully" }
    } catch (error) {
      handleSlackError(error, "archive channel")
    }
  },
}
