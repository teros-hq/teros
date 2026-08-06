import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateMessageTs } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface UnpinMessageArgs {
  channel: string
  timestamp: string
}

export const unpinMessage: ToolConfig = {
  description:
    "Unpin a message. Returns { channel, timestamp, unpinned: true }. Idempotent (no_pin not treated as error). Params: channel, timestamp.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      timestamp: { type: "string", description: "Message timestamp." },
    },
    required: ["channel", "timestamp"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, timestamp } = args as unknown as UnpinMessageArgs
    validateChannelId(channel, "channel")
    validateMessageTs(timestamp, "timestamp")
    const { client } = await getSlackSession(context)
    try {
      await wrapSlackMutation(() => client.pins.remove({ channel, timestamp }))
    } catch (e: any) {
      const code = e?.upstreamMessage ?? e?.message ?? ""
      if (!code.includes("no_pin")) throw e
    }
    return { channel, timestamp, unpinned: true }
  },
}
