import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface SetChannelPurposeArgs {
  channelId: string
  purpose: string
}

export const setChannelPurpose: ToolConfig = {
  description:
    "Set the purpose of a channel (long-form description shown in details). Max 250 chars. Returns { channelId, purpose }. Not retryable. Params: channelId, purpose.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id." },
      purpose: { type: "string", description: "Channel purpose (≤250 chars)." },
    },
    required: ["channelId", "purpose"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, purpose } = args as unknown as SetChannelPurposeArgs
    validateChannelId(channelId, "channelId")
    if (typeof purpose !== "string") {
      throw new Error("purpose must be a string.")
    }
    if (purpose.length > 250) {
      throw new Error(`purpose too long (max 250 chars, got ${purpose.length}).`)
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.conversations.setPurpose({ channel: channelId, purpose }),
    )
    return {
      channelId,
      purpose: (result as any).purpose ?? purpose,
    }
  },
}
