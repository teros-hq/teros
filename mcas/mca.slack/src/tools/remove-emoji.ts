import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { wrapSlackMutation } from "./utils"

interface RemoveEmojiArgs {
  name: string
}

export const removeEmoji: ToolConfig = {
  description:
    "Remove a custom workspace emoji. Workspace admin only. Returns { name, removed: true }. Not retryable. Params: name (no colons).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Emoji name (no colons)." },
    },
    required: ["name"],
  },
  annotations: { readOnlyHint: false,
    version: "1.0.0",
    stability: "stable",
    destructiveHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { name } = args as unknown as RemoveEmojiArgs
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("name must be a non-empty string.")
    }
    const { client } = await getSlackSession(context)
    await wrapSlackMutation(() => (client as any).emoji.remove({ name }))
    return { name, removed: true }
  },
}
