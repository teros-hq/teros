import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const listRoles: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "List all roles in a guild, ordered by position (highest first).",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
    },
    required: ["guildId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const roles = (await rest.get(Routes.guildRoles((args as any).guildId))) as Array<Record<string, unknown>>

      return {
        roles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          color: r.color,
          hoist: r.hoist,
          icon: r.icon,
          unicode_emoji: r.unicode_emoji,
          position: r.position,
          permissions: r.permissions,
          managed: r.managed,
          mentionable: r.mentionable,
          tags: r.tags,
          flags: r.flags,
        })),
        total: roles.length,
      }
    } catch (error) {
      handleDiscordError(error, "list roles")
    }
  },
}
