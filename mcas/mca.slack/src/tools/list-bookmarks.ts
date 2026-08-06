import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractBookmark, validateChannelId } from "./_helpers"
import { wrapSlackCall } from "./utils"

interface ListBookmarksArgs {
  channel: string
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

export const listBookmarks: ToolConfig = {
  description:
    "List bookmarks attached to a channel. Returns { bookmarks: [{ id, channelId, title, link, emoji, type, dateCreated, dateUpdated, rank }], count }. Retryable. Params: channel.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
    },
    required: ["channel"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, includeRaw} = args as unknown as ListBookmarksArgs
    validateChannelId(channel, "channel")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => client.bookmarks.list({ channel_id: channel }))
    if (includeRaw) return result
    const bookmarks = ((result.bookmarks ?? []) as any[]).map(extractBookmark)
    return { bookmarks, count: bookmarks.length }
  },
}
