import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface InviteToChannelArgs {
  channelId: string
  userIds: string[]
}

export const inviteToChannel: ToolConfig = {
  description: "Invite one or more users to a Slack channel.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel ID",
      },
      userIds: {
        type: "array",
        items: { type: "string" },
        description: "Array of Slack user IDs to invite (e.g. ['U1234567890'])",
      },
    },
    required: ["channelId", "userIds"],
  },
  handler: async (args, context) => {
    const { channelId, userIds } = (args as unknown) as InviteToChannelArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.conversations.invite({
        channel: channelId,
        users: userIds.join(","),
      })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      return {
        success: true,
        channelId,
        invitedUsers: userIds,
        alreadyInChannel: (result as any).already_in_channel ?? [],
      }
    } catch (error) {
      handleSlackError(error, "invite to channel")
    }
  },
}
