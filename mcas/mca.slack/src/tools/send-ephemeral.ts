import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateUserId } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface SendEphemeralArgs {
  channel: string
  user: string
  text: string
  blocks?: string
  threadTs?: string
}

export const sendEphemeral: ToolConfig = {
  description:
    "Post an ephemeral message visible only to one user in a channel. Returns { channel, user, messageTs }. Not retryable. Params: channel, user (recipient), text, blocks?, threadTs?.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      user: {
        type: "string",
        description: "User id of the recipient (U... / W...). Only they will see it.",
      },
      text: { type: "string", description: "Plain text body (fallback for blocks)." },
      blocks: { type: "string", description: "Optional Block Kit JSON string." },
      threadTs: { type: "string", description: "Parent message ts for ephemeral thread reply." },
    },
    required: ["channel", "user", "text"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, user, text, blocks, threadTs } = args as unknown as SendEphemeralArgs
    validateChannelId(channel, "channel")
    validateUserId(user, "user")
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("text must be a non-empty string.")
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
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.chat.postEphemeral(
        sanitiseBody({
          channel,
          user,
          text,
          blocks: parsedBlocks,
          thread_ts: threadTs,
        }) as any,
      ),
    )
    return {
      channel,
      user,
      messageTs: result.message_ts ?? null,
    }
  },
}
