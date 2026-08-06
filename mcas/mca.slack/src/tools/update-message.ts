import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractMessage, validateChannelId, validateMessageTs } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface UpdateMessageArgs {
  channel: string
  ts: string
  text?: string
  blocks?: string
  attachments?: string
}

export const updateMessage: ToolConfig = {
  description:
    "Edit an existing message. The token user must be the author. Returns { ts, channel, text, message }. Not retryable. Params: channel, ts, text? or blocks? (at least one required), attachments? (JSON).",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel id where the message lives (C... / G... / D... / M...).",
      },
      ts: {
        type: "string",
        description: 'Timestamp of the message to edit ("1234567890.123456").',
      },
      text: {
        type: "string",
        description: "New plain text body. At least one of text/blocks must be provided.",
      },
      blocks: {
        type: "string",
        description: "New Slack Block Kit JSON string (will be parsed). Replaces existing blocks.",
      },
      attachments: {
        type: "string",
        description: "New attachments JSON string (legacy). Pass [] to clear.",
      },
    },
    required: ["channel", "ts"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, ts, text, blocks, attachments } = args as unknown as UpdateMessageArgs
    validateChannelId(channel, "channel")
    validateMessageTs(ts, "ts")
    if (!text && !blocks) {
      throw new Error("Provide at least one of: text, blocks.")
    }
    let parsedBlocks: unknown[] | undefined
    if (typeof blocks === "string" && blocks.trim().length > 0) {
      try {
        const parsed = JSON.parse(blocks)
        if (!Array.isArray(parsed)) throw new Error("blocks must parse to a JSON array.")
        parsedBlocks = parsed
      } catch (err) {
        throw new Error(
          `Invalid blocks JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    let parsedAttachments: unknown[] | undefined
    if (typeof attachments === "string" && attachments.trim().length > 0) {
      try {
        const parsed = JSON.parse(attachments)
        if (!Array.isArray(parsed)) throw new Error("attachments must parse to a JSON array.")
        parsedAttachments = parsed
      } catch (err) {
        throw new Error(
          `Invalid attachments JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.chat.update(
        sanitiseBody({
          channel,
          ts,
          text,
          blocks: parsedBlocks,
          attachments: parsedAttachments,
        }) as any,
      ),
    )

    return {
      ts: result.ts ?? ts,
      channel: result.channel ?? channel,
      text: result.text ?? text ?? "",
      message: result.message ? extractMessage(result.message, { channel: result.channel ?? channel }) : null,
    }
  },
}
