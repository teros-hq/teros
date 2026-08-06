import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const listGuilds: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "List guilds (servers) the bot/user is a member of. Supports pagination.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max guilds per page (1-200). Default: 100",
        default: 100,
      },
      before: {
        type: "string",
        description: "Get guilds before this guild ID (for pagination)",
      },
      after: {
        type: "string",
        description: "Get guilds after this guild ID (for pagination)",
      },
      withCounts: {
        type: "boolean",
        description: "Include approximate member and presence counts. Default: false",
        default: false,
      },
    },
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const params = new URLSearchParams()
      if ((args as any).limit) params.set("limit", String((args as any).limit))
      if ((args as any).before) params.set("before", (args as any).before)
      if ((args as any).after) params.set("after", (args as any).after)
      if ((args as any).withCounts) params.set("with_counts", "true")

      const qs = params.toString()
      const basePath = Routes.userGuilds() as `/${string}`
      const path = qs ? `${basePath}?${qs}` : basePath
      const guilds = (await rest.get(path as `/${string}`)) as Array<Record<string, unknown>>

      return {
        guilds: guilds.map((g) => ({
          id: g.id,
          name: g.name,
          icon: g.icon,
          owner: g.owner,
          permissions: g.permissions,
          approximate_member_count: g.approximate_member_count,
          approximate_presence_count: g.approximate_presence_count,
        })),
        total: guilds.length,
      }
    } catch (error) {
      handleDiscordError(error, "list guilds")
    }
  },
}
