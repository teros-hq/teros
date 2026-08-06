import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractChannel, validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface JoinChannelArgs {
  channelId: string
}

export const joinChannel: ToolConfig = {
  description:
    "Join a public channel. Returns the curated channel. Idempotent (already_in_channel raises BUSINESS_RULE). Params: channelId.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel id (C...).",
      },
    },
    required: ["channelId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId } = args as unknown as JoinChannelArgs
    validateChannelId(channelId, "channelId")
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.conversations.join({ channel: channelId }),
    )
    return result.channel ? extractChannel(result.channel) : { id: channelId }
  },
}
