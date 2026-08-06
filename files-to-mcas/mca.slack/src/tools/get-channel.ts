import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface GetChannelArgs {
  channelId: string
}

export const getChannel: ToolConfig = {
  description: "Get detailed information about a specific Slack channel by ID.",
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
    const { channelId } = (args as unknown) as GetChannelArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.conversations.info({ channel: channelId })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const ch = result.channel!
      return {
        id: ch.id,
        name: ch.name,
        isPrivate: ch.is_private,
        isArchived: ch.is_archived,
        isMember: ch.is_member,
        numMembers: ch.num_members,
        topic: ch.topic?.value ?? "",
        purpose: ch.purpose?.value ?? "",
        created: ch.created,
        creator: ch.creator,
        contextTeamId: ch.context_team_id,
      }
    } catch (error) {
      handleSlackError(error, "get channel info")
    }
  },
}
