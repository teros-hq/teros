import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { validateChannelId } from "./_helpers"
import { wrapSlackMutation } from "./utils"

interface RemoveBookmarkArgs {
  channel: string
  bookmarkId: string
}

export const removeBookmark: ToolConfig = {
  description:
    "Remove a channel bookmark by id. Returns { channel, bookmarkId, removed: true }. Not retryable. Params: channel, bookmarkId.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      bookmarkId: { type: "string", description: "Bookmark id from add-bookmark / list-bookmarks." },
    },
    required: ["channel", "bookmarkId"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, bookmarkId } = args as unknown as RemoveBookmarkArgs
    validateChannelId(channel, "channel")
    if (typeof bookmarkId !== "string" || bookmarkId.trim().length === 0) {
      throw new Error("bookmarkId must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() =>
      client.bookmarks.remove({ channel_id: channel, bookmark_id: bookmarkId }),
    )
    return { channel, bookmarkId, removed: true }
  },
}
