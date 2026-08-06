import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractChannel, validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface UnarchiveChannelArgs {
  channelId: string
}

export const unarchiveChannel: ToolConfig = {
  description:
    "Unarchive a previously archived channel. Returns curated channel. Not retryable. Params: channelId.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Channel id (C... / G...)." },
    },
    required: ["channelId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channelId } = args as unknown as UnarchiveChannelArgs
    validateChannelId(channelId, "channelId")
    const { botClient: client } = await getSlackSession(context)
    await wrapSlackMutation(() => client.conversations.unarchive({ channel: channelId }))
    // unarchive returns ok only; fetch the resolved name for the renderer
    let resolved: any = null
    try {
      const info = await client.conversations.info({ channel: channelId })
      resolved = info.channel ?? null
    } catch {
      // ignore
    }
    return resolved
      ? extractChannel(resolved)
      : { id: channelId, name: "", isPrivate: false, isArchived: false, isMember: false, numMembers: null, topic: "", purpose: "", created: null, creator: null }
  },
}
