import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes, ChannelType } from "discord.js"

export const createChannel: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Create a new channel in a guild. Supports text, voice, category, announcement, and forum channels.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      name: {
        type: "string",
        description: "Channel name (1-100 characters)",
      },
      type: {
        type: "string",
        enum: ["text", "voice", "category", "announcement", "forum", "stage"],
        description: "Channel type. Default: text",
        default: "text",
      },
      topic: {
        type: "string",
        description: "Channel topic/description (max 1024 chars for text, 4096 for forum)",
      },
      parentId: {
        type: "string",
        description: "Parent category channel ID",
      },
      nsfw: {
        type: "boolean",
        description: "Mark channel as NSFW. Default: false",
        default: false,
      },
      rateLimitPerUser: {
        type: "number",
        description: "Slowmode in seconds (0-21600). Default: 0",
        default: 0,
      },
      bitrate: {
        type: "number",
        description: "Voice channel bitrate in bits (8000-96000/128000 for boosted guilds)",
      },
      userLimit: {
        type: "number",
        description: "Voice channel user limit (0-99, 0 = unlimited). Default: 0",
        default: 0,
      },
      position: {
        type: "number",
        description: "Sorting position of the channel",
      },
    },
    required: ["guildId", "name"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)

      const typeMap: Record<string, number> = {
        text: ChannelType.GuildText,
        voice: ChannelType.GuildVoice,
        category: ChannelType.GuildCategory,
        announcement: ChannelType.GuildAnnouncement,
        forum: ChannelType.GuildForum,
        stage: ChannelType.GuildStageVoice,
      }

      const body: Record<string, unknown> = {
        name: (args as any).name,
        type: typeMap[(args as any).type] ?? ChannelType.GuildText,
        nsfw: (args as any).nsfw,
      }

      if ((args as any).topic) body.topic = (args as any).topic
      if ((args as any).parentId) body.parent_id = (args as any).parentId
      if ((args as any).rateLimitPerUser !== undefined) body.rate_limit_per_user = (args as any).rateLimitPerUser
      if ((args as any).bitrate) body.bitrate = (args as any).bitrate
      if ((args as any).userLimit !== undefined) body.user_limit = (args as any).userLimit
      if ((args as any).position !== undefined) body.position = (args as any).position

      const channel = (await rest.post(Routes.guildChannels((args as any).guildId), { body })) as Record<string, unknown>

      return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        guild_id: channel.guild_id,
        parent_id: channel.parent_id,
        nsfw: channel.nsfw,
        topic: channel.topic,
        rate_limit_per_user: channel.rate_limit_per_user,
        bitrate: channel.bitrate,
        user_limit: channel.user_limit,
        position: channel.position,
      }
    } catch (error) {
      handleDiscordError(error, "create channel")
    }
  },
}
