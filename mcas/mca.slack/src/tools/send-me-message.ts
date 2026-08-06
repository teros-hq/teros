import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface SendMeMessageArgs {
  channel: string
  text: string
}

export const sendMeMessage: ToolConfig = {
  description:
    "Send a /me action message (third-person italic in Slack UI). Returns { ts, channel }. Not retryable. Params: channel, text.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      text: { type: "string", description: 'Action text (e.g. "is testing the feature").' },
    },
    required: ["channel", "text"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, text } = args as unknown as SendMeMessageArgs
    validateChannelId(channel, "channel")
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("text must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() => client.chat.meMessage({ channel, text }))
    return {
      ts: result.ts ?? "",
      channel: result.channel ?? channel,
    }
  },
}
