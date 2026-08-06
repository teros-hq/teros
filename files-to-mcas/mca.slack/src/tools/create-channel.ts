import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface CreateChannelArgs {
  name: string
  isPrivate?: boolean
  description?: string
}

export const createChannel: ToolConfig = {
  description: "Create a new public or private Slack channel.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Channel name (lowercase, no spaces, max 80 chars). Will be normalized.",
      },
      isPrivate: {
        type: "boolean",
        description: "Create as private channel. Default: false",
      },
      description: {
        type: "string",
        description: "Optional channel topic/description",
      },
    },
    required: ["name"],
  },
  handler: async (args, context) => {
    const { name, isPrivate, description } = (args as unknown) as CreateChannelArgs
    try {
      const { client } = await getSlackSession(context)
      const normalizedName = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 80)

      const result = isPrivate
        ? await client.conversations.create({ name: normalizedName, is_private: true })
        : await client.conversations.create({ name: normalizedName })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      const ch = result.channel!

      if (description) {
        try {
          await client.conversations.setTopic({ channel: ch.id!, topic: description })
        } catch {
          // Non-fatal: channel created but topic not set
        }
      }

      return {
        id: ch.id,
        name: ch.name,
        isPrivate: ch.is_private,
        created: ch.created,
        url: `https://slack.com/app_redirect?channel=${ch.id}`,
        success: true,
      }
    } catch (error) {
      handleSlackError(error, "create channel")
    }
  },
}
