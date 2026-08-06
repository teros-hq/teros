import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const getMember: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "Get a specific guild member by user ID.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      userId: {
        type: "string",
        description: "User ID (snowflake) of the member",
      },
    },
    required: ["guildId", "userId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const member = (await rest.get(Routes.guildMember((args as any).guildId, (args as any).userId))) as Record<string, unknown>

      return {
        user: member.user
          ? {
              id: (member.user as any).id,
              username: (member.user as any).username,
              global_name: (member.user as any).global_name,
              avatar: (member.user as any).avatar,
              bot: (member.user as any).bot,
            }
          : null,
        nick: member.nick,
        roles: member.roles,
        joined_at: member.joined_at,
        premium_since: member.premium_since,
        deaf: member.deaf,
        mute: member.mute,
        flags: member.flags,
        pending: member.pending,
        communication_disabled_until: member.communication_disabled_until,
      }
    } catch (error) {
      handleDiscordError(error, "get member")
    }
  },
}
