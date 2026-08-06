import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateUserId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface KickFromChannelArgs {
  channelId: string
  userId: string
}

export const kickFromChannel: ToolConfig = {
  description:
    "Remove a user from a channel. Requires admin or channel owner permissions. Returns { channelId, userId, kicked: true }. Not retryable. Params: channelId, userId.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id." },
      userId: { type: "string", description: "User id (U... / W...) to remove." },
    },
    required: ["channelId", "userId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, userId } = args as unknown as KickFromChannelArgs
    validateChannelId(channelId, "channelId")
    validateUserId(userId, "userId")
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => client.conversations.kick({ channel: channelId, user: userId }))
    return { channelId, userId, kicked: true }
  },
}
