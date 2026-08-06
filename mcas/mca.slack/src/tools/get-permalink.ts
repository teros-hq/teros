import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateMessageTs } from "./_helpers"
import { wrapSlackCall } from "./utils"

interface GetPermalinkArgs {
  channel: string
  ts: string
  includeRaw?: boolean
}

export const getPermalink: ToolConfig = {
  description:
    "Get a permanent URL for a message. Returns { channel, ts, permalink }. Idempotent, retryable. Params: channel, ts.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      ts: { type: "string", description: 'Message timestamp.' },
    },
    required: ["channel", "ts"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, ts, includeRaw} = args as unknown as GetPermalinkArgs
    validateChannelId(channel, "channel")
    validateMessageTs(ts, "ts")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.chat.getPermalink({ channel, message_ts: ts }),
    )
    if (includeRaw) return result
    return {
      channel,
      ts,
      permalink: result.permalink ?? null,
    }
  },
}
