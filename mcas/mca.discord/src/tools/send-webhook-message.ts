import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"

export const sendWebhookMessage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Send a message via a webhook using the webhook URL. Supports text, embeds, and usernames.",
  parameters: {
    type: "object",
    properties: {
      webhookId: {
        type: "string",
        description: "Webhook ID (snowflake)",
      },
      webhookToken: {
        type: "string",
        description: "Webhook token (from create-webhook response)",
      },
      content: {
        type: "string",
        description: "Message text content (max 2000 characters)",
      },
      username: {
        type: "string",
        description: "Override the webhook's default username",
      },
      avatarUrl: {
        type: "string",
        description: "Override the webhook's default avatar URL",
      },
      embeds: {
        type: "string",
        description: "Optional JSON string of embed objects array",
      },
      threadId: {
        type: "string",
        description: "Optional thread ID to send the message in a forum thread",
      },
    },
    required: ["webhookId", "webhookToken"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)

      const body: Record<string, unknown> = {}
      if ((args as any).content) body.content = (args as any).content
      if ((args as any).username) body.username = (args as any).username
      if ((args as any).avatarUrl) body.avatar_url = (args as any).avatarUrl
      if ((args as any).embeds) {
        try {
          body.embeds = JSON.parse((args as any).embeds)
        } catch {
          throw new Error("Invalid embeds JSON. Must be a valid JSON array of embed objects.")
        }
      }

      // Use raw fetch for webhook since it doesn't need auth
      const url = `https://discord.com/api/v10/webhooks/${(args as any).webhookId}/${(args as any).webhookToken}${(args as any).threadId ? `?thread_id=${(args as any).threadId}` : ""}`
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Webhook request failed: ${response.status} ${errorText}`)
      }

      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>

      return {
        success: true,
        id: data.id,
        channel_id: data.channel_id,
        content: data.content,
        message: "Webhook message sent successfully",
      }
    } catch (error) {
      handleDiscordError(error, "send webhook message")
    }
  },
}
