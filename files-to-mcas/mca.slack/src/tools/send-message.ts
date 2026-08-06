import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface SendMessageArgs {
  channel: string
  text: string
  blocks?: string
  threadTs?: string
  asUser?: boolean
  unfurlLinks?: boolean
}

export const sendMessage: ToolConfig = {
  description: "Send a message to a Slack channel, DM, or user. Supports blocks and attachments.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel ID (C...), user ID (U... for DM), or channel name (#general). For DMs use the user's ID.",
      },
      text: {
        type: "string",
        description: "Message text. Required fallback if blocks not provided.",
      },
      blocks: {
        type: "string",
        description: "Optional JSON string of Slack Block Kit blocks for rich formatting.",
      },
      threadTs: {
        type: "string",
        description: "Optional thread timestamp to reply in a thread. Format: 1234567890.123456",
      },
      asUser: {
        type: "boolean",
        description: "Post as the authenticated user. Default: true",
      },
      unfurlLinks: {
        type: "boolean",
        description: "Enable link unfurling. Default: true",
      },
    },
    required: ["channel", "text"],
  },
  handler: async (args, context) => {
    const { channel, text, blocks, threadTs, asUser, unfurlLinks } = (args as unknown) as SendMessageArgs
    try {
      const { client } = await getSlackSession(context)

      const payload: any = {
        channel,
        text,
        as_user: asUser ?? true,
        unfurl_links: unfurlLinks ?? true,
      }

      if (threadTs) {
        payload.thread_ts = threadTs
      }

      if (blocks) {
        try {
          payload.blocks = JSON.parse(blocks)
        } catch {
          throw new Error("Invalid blocks JSON. Must be a valid JSON array of Block Kit blocks.")
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
        message: "Message sent successfully",
        permalink: `https://slack.com/app_redirect?channel=${result.channel}&message=${result.ts}`,
      }
    } catch (error) {
      handleSlackError(error, "send message")
    }
  },
}
