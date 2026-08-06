import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { tsToIso, validateChannelId } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface ScheduleMessageArgs {
  channel: string
  text: string
  postAt: number
  blocks?: string
  threadTs?: string
  unfurlLinks?: boolean
  unfurlMedia?: boolean
}

export const scheduleMessage: ToolConfig = {
  description:
    "Schedule a message to be posted at a future unix-seconds timestamp. Returns { channel, scheduledMessageId, postAt }. Slack rejects postAt > 120 days ahead. Not retryable. Params: channel, text, postAt (unix seconds), blocks?, threadTs?, unfurlLinks (def true), unfurlMedia (def true).",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id or user id (DM)." },
      text: { type: "string", description: "Plain text body (fallback for blocks)." },
      postAt: {
        type: "number",
        description: "Unix seconds when the message should post. Must be future and ≤120 days ahead.",
      },
      blocks: { type: "string", description: "Optional Slack Block Kit JSON string." },
      threadTs: { type: "string", description: "Parent message ts for thread reply." },
      unfurlLinks: { type: "boolean", description: "Unfurl links. Default true." },
      unfurlMedia: { type: "boolean", description: "Unfurl media. Default true." },
    },
    required: ["channel", "text", "postAt"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, text, postAt, blocks, threadTs, unfurlLinks, unfurlMedia } =
      args as unknown as ScheduleMessageArgs
    validateChannelId(channel, "channel")
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("text must be a non-empty string.")
    }
    if (typeof postAt !== "number" || !Number.isFinite(postAt)) {
      throw new Error("postAt must be a unix-seconds number.")
    }
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (postAt <= nowSeconds) {
      throw new Error(`postAt must be in the future (now=${nowSeconds}, got=${postAt}).`)
    }
    const max = nowSeconds + 120 * 24 * 60 * 60
    if (postAt > max) {
      throw new Error(`postAt cannot be more than 120 days ahead (max=${max}, got=${postAt}).`)
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
      client.chat.scheduleMessage(
        sanitiseBody({
          channel,
          text,
          post_at: postAt,
          blocks: parsedBlocks,
          thread_ts: threadTs,
          unfurl_links: unfurlLinks ?? true,
          unfurl_media: unfurlMedia ?? true,
        }) as any,
      ),
    )

    return {
      channel: result.channel ?? channel,
      scheduledMessageId: result.scheduled_message_id ?? "",
      postAt,
      postAtIso: tsToIso(postAt),
    }
  },
}
