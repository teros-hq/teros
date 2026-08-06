import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface DeleteScheduledMessageArgs {
  channel: string
  scheduledMessageId: string
  asUser?: boolean
}

export const deleteScheduledMessage: ToolConfig = {
  description:
    "Cancel a scheduled message. Returns { channel, scheduledMessageId, deleted: true }. Not retryable. Params: channel, scheduledMessageId, asUser? (def true).",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id where the message was scheduled." },
      scheduledMessageId: {
        type: "string",
        description: "Id returned by chat.scheduleMessage / list-scheduled-messages.",
      },
      asUser: { type: "boolean", description: "Delete as the authenticated user (default true)." },
    },
    required: ["channel", "scheduledMessageId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, scheduledMessageId, asUser } = args as unknown as DeleteScheduledMessageArgs
    validateChannelId(channel, "channel")
    if (typeof scheduledMessageId !== "string" || scheduledMessageId.trim().length === 0) {
      throw new Error("scheduledMessageId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      client.chat.deleteScheduledMessage({
        channel,
        scheduled_message_id: scheduledMessageId,
        as_user: asUser ?? true,
      }),
    )
    return { channel, scheduledMessageId, deleted: true }
  },
}
