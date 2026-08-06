import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractChannel, validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface ArchiveChannelArgs {
  channelId: string
}

export const archiveChannel: ToolConfig = {
  description:
    "Archive a channel (read-only afterwards). Returns { id, name } from a follow-up info call. Not retryable. Params: channelId.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Slack channel id (C... / G...).",
      },
    },
    required: ["channelId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId } = args as unknown as ArchiveChannelArgs
    validateChannelId(channelId, "channelId")
    const { botClient: client } = await getSlackSession(context)
    await wrapSlackMutation(() => client.conversations.archive({ channel: channelId }))
    // conversations.archive returns no channel object; fetch a minimal shape so
    // the renderer can show the resolved name without a second LLM call.
    let resolved: any = null
    try {
      const info = await client.conversations.info({ channel: channelId })
      resolved = info.channel ?? null
    } catch {
      // ignore — channel may be archived and inaccessible to the bot
    }
    return resolved
      ? extractChannel(resolved)
      : { id: channelId, name: "", isArchived: true }
  },
}
