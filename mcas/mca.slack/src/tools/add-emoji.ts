import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, wrapSlackMutation } from "./utils"

interface AddEmojiArgs {
  name: string
  url?: string
  aliasFor?: string
}

export const addEmoji: ToolConfig = {
  description:
    "Add a custom workspace emoji. Provide EITHER url (new image) OR aliasFor (alias of existing emoji). Returns { name, isAlias, aliasFor?, ok: true }. Not retryable. Params: name, url? | aliasFor?.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Emoji name (no colons, lowercase, no spaces — e.g. 'teros').",
      },
      url: {
        type: "string",
        description: "URL of the image (PNG/JPG/GIF, max 128KB, square recommended).",
      },
      aliasFor: { type: "string", description: "Existing emoji name to alias (no colons)." },
    },
    required: ["name"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { name, url, aliasFor } = args as unknown as AddEmojiArgs
    if (typeof name !== "string" || !/^[a-z0-9_-]+$/i.test(name)) {
      throw new Error("name must contain only letters, digits, underscores, and hyphens (no colons or spaces).")
    }
    const isAlias = aliasFor !== undefined
    if (isAlias === (url !== undefined)) {
      throw new Error("Provide either url OR aliasFor — not both, not neither.")
    }
    if (url && !/^https?:\/\//.test(url)) {
      throw new Error("url must be an http:// or https:// URL.")
    }
    const { client } = await getSlackSession(context)
    // emoji.add: workspace admins only (Slack docs). Not under admin.* (Enterprise Grid)
    // because it works for any plan with a workspace admin token.
    await wrapSlackMutation(() =>
      (client as any).emoji.add(
        sanitiseBody({ name, url, alias_for: aliasFor }) as any,
      ),
    )
    return { name, isAlias, aliasFor: aliasFor ?? null, ok: true }
  },
}
