import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const addReaction: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Add a reaction (emoji) to a message. Use Unicode emoji or custom emoji format name:id.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Channel ID (snowflake)",
      },
      messageId: {
        type: "string",
        description: "Message ID (snowflake)",
      },
      emoji: {
        type: "string",
        description: "Emoji to react with. Unicode emoji (e.g. 👍) or custom emoji name:id format",
      },
    },
    required: ["channelId", "messageId", "emoji"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      // URL-encode the emoji
      const encodedEmoji = encodeURIComponent((args as any).emoji as string)
      await rest.put(
        Routes.channelMessageReaction(
          (args as any).channelId as `/${string}`,
          (args as any).messageId as `/${string}`,
          encodedEmoji as `/${string}`,
        ),
      )

      return {
        success: true,
        message: `Reaction ${args.emoji} added to message ${args.messageId}`,
      }
    } catch (error) {
      handleDiscordError(error, "add reaction")
    }
  },
}
