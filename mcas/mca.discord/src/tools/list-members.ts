import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const listMembers: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "List members of a guild. Supports pagination via limit and after user ID.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      limit: {
        type: "number",
        description: "Max members to retrieve (1-1000). Default: 100",
        default: 100,
      },
      after: {
        type: "string",
        description: "Get members after this user ID (snowflake) for pagination",
      },
    },
    required: ["guildId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const params = new URLSearchParams()
      if ((args as any).limit) params.set("limit", String(Math.min((args as any).limit, 1000)))
      if ((args as any).after) params.set("after", (args as any).after)

      const qs = params.toString()
      const path = qs
        ? `${Routes.guildMembers((args as any).guildId as `/${string}`)}?${qs}`
        : Routes.guildMembers((args as any).guildId as `/${string}`)
      const members = (await rest.get(path as `/${string}`)) as Array<Record<string, unknown>>

      return {
        members: members.map((m) => ({
          user: m.user
            ? {
                id: (m.user as any).id,
                username: (m.user as any).username,
                global_name: (m.user as any).global_name,
                avatar: (m.user as any).avatar,
                bot: (m.user as any).bot,
              }
            : null,
          nick: m.nick,
          roles: m.roles,
          joined_at: m.joined_at,
          premium_since: m.premium_since,
          deaf: m.deaf,
          mute: m.mute,
          flags: m.flags,
          pending: m.pending,
          communication_disabled_until: m.communication_disabled_until,
        })),
        total: members.length,
      }
    } catch (error) {
      handleDiscordError(error, "list members")
    }
  },
}
