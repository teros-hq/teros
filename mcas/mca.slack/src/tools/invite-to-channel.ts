import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractChannel, validateChannelId, validateUserId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface InviteToChannelArgs {
  channelId: string
  userIds: string[]
}

export const inviteToChannel: ToolConfig = {
  description:
    "Invite users to a channel. Returns { channel, invitedUserIds, alreadyInChannel? }. Not retryable. Params: channelId, userIds[].",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel id (C... / G...).",
      },
      userIds: {
        type: "array",
        items: { type: "string" },
        description: "Slack user ids (U... / W...) to invite.",
      },
    },
    required: ["channelId", "userIds"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, userIds } = args as unknown as InviteToChannelArgs
    validateChannelId(channelId, "channelId")
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new Error("userIds must be a non-empty array of Slack user ids.")
    }
    userIds.forEach((id, i) => validateUserId(id, `userIds[${i}]`))

    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.conversations.invite({ channel: channelId, users: userIds.join(",") }),
    )
    return {
      channel: result.channel ? extractChannel(result.channel) : { id: channelId },
      invitedUserIds: userIds,
      alreadyInChannel: (result as any).errors?.length ? (result as any).errors : undefined,
    }
  },
}
