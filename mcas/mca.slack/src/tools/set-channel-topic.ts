import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface SetChannelTopicArgs {
  channelId: string
  topic: string
}

export const setChannelTopic: ToolConfig = {
  description:
    "Set the topic of a channel (short description in the channel header). Max 250 chars. Returns { channelId, topic }. Not retryable. Params: channelId, topic.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id." },
      topic: { type: "string", description: "Channel topic (≤250 chars)." },
    },
    required: ["channelId", "topic"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, topic } = args as unknown as SetChannelTopicArgs
    validateChannelId(channelId, "channelId")
    if (typeof topic !== "string") {
      throw new Error("topic must be a string.")
    }
    if (topic.length > 250) {
      throw new Error(`topic too long (max 250 chars, got ${topic.length}).`)
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.conversations.setTopic({ channel: channelId, topic }),
    )
    return {
      channelId,
      topic: (result as any).topic ?? topic,
    }
  },
}
