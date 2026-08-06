import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateMessageTs } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface MarkChannelReadArgs {
  channelId: string
  timestamp: string
}

export const markChannelRead: ToolConfig = {
  description:
    "Mark all messages in a channel up to and including `timestamp` as read for the authed user. Returns { channelId, timestamp, marked: true }. Idempotent. Params: channelId, timestamp.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id." },
      timestamp: {
        type: "string",
        description: 'Message ts as the read cursor ("1234567890.123456").',
      },
    },
    required: ["channelId", "timestamp"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, timestamp } = args as unknown as MarkChannelReadArgs
    validateChannelId(channelId, "channelId")
    validateMessageTs(timestamp, "timestamp")
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => client.conversations.mark({ channel: channelId, ts: timestamp }))
    return { channelId, timestamp, marked: true }
  },
}
