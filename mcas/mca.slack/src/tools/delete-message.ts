import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId, validateMessageTs } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface DeleteMessageArgs {
  channel: string
  ts: string
  asUser?: boolean
}

export const deleteMessage: ToolConfig = {
  description:
    "Delete a message. The token user must be author or workspace admin. Returns { channel, ts, deleted: true }. Not retryable. Params: channel, ts, asUser? (default true — deletes as the user; false impersonates the workspace).",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel id where the message lives.",
      },
      ts: {
        type: "string",
        description: 'Timestamp of the message to delete.',
      },
      asUser: {
        type: "boolean",
        description: "Delete as the authenticated user (default true). Set false only if the token has admin scope.",
      },
    },
    required: ["channel", "ts"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, ts, asUser } = args as unknown as DeleteMessageArgs
    validateChannelId(channel, "channel")
    validateMessageTs(ts, "ts")
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      client.chat.delete({ channel, ts, as_user: asUser ?? true }),
    )
    return { channel, ts, deleted: true }
  },
}
