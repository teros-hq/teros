import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface LeaveChannelArgs {
  channelId: string
}

export const leaveChannel: ToolConfig = {
  description:
    "Leave a public or private channel. Returns { channelId, notInChannel }. Not retryable. Params: channelId.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Slack channel id (C... / G...)." },
    },
    required: ["channelId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId } = args as unknown as LeaveChannelArgs
    validateChannelId(channelId, "channelId")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.conversations.leave({ channel: channelId }),
    )
    return {
      channelId,
      notInChannel: (result as any).not_in_channel ?? false,
    }
  },
}
