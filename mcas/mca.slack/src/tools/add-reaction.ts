import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateMessageTs } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface AddReactionArgs {
  channel: string
  timestamp: string
  name: string
}

const EMOJI_NAME_RE = /^[a-z0-9_+-]+$/

export const addReaction: ToolConfig = {
  description:
    "Add an emoji reaction to a message. Returns { channel, timestamp, name }. Idempotent (already_reacted raises BUSINESS_RULE). Params: channel, timestamp, name (no colons).",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel id where the message is.",
      },
      timestamp: {
        type: "string",
        description: "Message ts (1234567890.123456).",
      },
      name: {
        type: "string",
        description: "Emoji name without colons (e.g. 'thumbsup', 'fire').",
      },
    },
    required: ["channel", "timestamp", "name"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, timestamp, name } = args as unknown as AddReactionArgs
    validateChannelId(channel, "channel")
    validateMessageTs(timestamp, "timestamp")
    if (!EMOJI_NAME_RE.test(name)) {
      throw new Error(
        `Invalid emoji name "${name}": must be lowercase alnum/underscore/+/-, no colons.`,
      )
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => client.reactions.add({ channel, timestamp, name }))
    return { channel, timestamp, name }
  },
}
