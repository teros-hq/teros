import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface SendThreadReplyArgs {
  channel: string
  threadTs: string
  text: string
  blocks?: string
  broadcast?: boolean
}

export const sendThreadReply: ToolConfig = {
  description: "Reply to a specific message thread in Slack.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel ID where the parent message is located",
      },
      threadTs: {
        type: "string",
        description: "Parent message timestamp (e.g. 1234567890.123456)",
      },
      text: {
        type: "string",
        description: "Reply text",
      },
      blocks: {
        type: "string",
        description: "Optional JSON string of Slack Block Kit blocks",
      },
      broadcast: {
        type: "boolean",
        description: "Also broadcast reply to the channel. Default: false",
      },
    },
    required: ["channel", "threadTs", "text"],
  },
  handler: async (args, context) => {
    const { channel, threadTs, text, blocks, broadcast } = (args as unknown) as SendThreadReplyArgs
    try {
      const { client } = await getSlackSession(context)

      const payload: any = {
        channel,
        thread_ts: threadTs,
        text,
        reply_broadcast: broadcast ?? false,
        as_user: true,
      }

      if (blocks) {
        try {
          payload.blocks = JSON.parse(blocks)
        } catch {
          throw new Error("Invalid blocks JSON")
        }
      }

      const result = await client.chat.postMessage(payload)

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      return {
        success: true,
        channel: result.channel,
        ts: result.ts,
        threadTs,
        broadcast: broadcast ?? false,
        message: "Thread reply sent successfully",
      }
    } catch (error) {
      handleSlackError(error, "send thread reply")
    }
  },
}
