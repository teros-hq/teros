import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractChannel, validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface RenameChannelArgs {
  channelId: string
  name: string
}

export const renameChannel: ToolConfig = {
  description:
    "Rename a channel. Name must be ≤80 chars, lowercase, no spaces/periods (Slack normalizes). Returns curated channel. Not retryable. Params: channelId, name.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id (C... / G...)." },
      name: {
        type: "string",
        description: "New name. Slack lowercases and strips invalid chars automatically.",
      },
    },
    required: ["channelId", "name"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId, name } = args as unknown as RenameChannelArgs
    validateChannelId(channelId, "channelId")
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("name must be a non-empty string.")
    }
    if (name.length > 80) {
      throw new Error(`name too long (max 80 chars, got ${name.length}).`)
    }
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.conversations.rename({ channel: channelId, name }),
    )
    return result.channel
      ? extractChannel(result.channel)
      : { id: channelId, name, isPrivate: false, isArchived: false, isMember: true, numMembers: null, topic: "", purpose: "", created: null, creator: null }
  },
}
