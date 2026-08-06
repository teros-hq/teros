import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractBookmark, validateChannelId } from "./_helpers"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface AddBookmarkArgs {
  channel: string
  title: string
  link: string
  emoji?: string
}

export const addBookmark: ToolConfig = {
  description:
    "Add a bookmark to a channel (links shown in the channel header). Returns the curated bookmark. Not retryable. Params: channel, title, link (URL), emoji? (e.g. ':notebook:').",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel id." },
      title: { type: "string", description: "Display title." },
      link: { type: "string", description: "URL the bookmark points to (http/https only)." },
      emoji: { type: "string", description: "Optional emoji shortcode for the bookmark icon." },
    },
    required: ["channel", "title", "link"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { channel, title, link, emoji } = args as unknown as AddBookmarkArgs
    validateChannelId(channel, "channel")
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new Error("title must be a non-empty string.")
    }
    if (typeof link !== "string" || !/^https?:\/\//.test(link)) {
      throw new Error("link must be an http:// or https:// URL.")
    }
    const { client } = await getSlackSession(context)
    const result = await wrapSlackMutation(() =>
      client.bookmarks.add(
        sanitiseBody({ channel_id: channel, title, link, type: "link", emoji }) as any,
      ),
    )
    return result.bookmark ? extractBookmark(result.bookmark) : null
  },
}
