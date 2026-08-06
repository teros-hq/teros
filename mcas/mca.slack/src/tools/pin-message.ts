import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateMessageTs } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface PinMessageArgs {
  channel: string
  timestamp: string
}

export const pinMessage: ToolConfig = {
  description:
    "Pin a message to a channel. Returns { channel, timestamp, pinned: true }. Idempotent (already_pinned not treated as error). Params: channel, timestamp.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id (C... / G... / D... / M...)." },
      timestamp: { type: "string", description: 'Message timestamp ("1234567890.123456").' },
    },
    required: ["channel", "timestamp"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, timestamp } = args as unknown as PinMessageArgs
    validateChannelId(channel, "channel")
    validateMessageTs(timestamp, "timestamp")
    const { client } = await getSlackSession(context)
    try {
      await wrapSlackMutation(() => client.pins.add({ channel, timestamp }))
    } catch (e: any) {
      // Slack returns "already_pinned" when item is already pinned — treat as success (idempotent).
      const code = e?.upstreamMessage ?? e?.message ?? ""
      if (!code.includes("already_pinned")) throw e
    }
    return { channel, timestamp, pinned: true }
  },
}
