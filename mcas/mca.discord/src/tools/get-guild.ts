import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const getGuild: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: "Get detailed information about a specific guild (server) by ID.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      withCounts: {
        type: "boolean",
        description: "Include approximate member and presence counts. Default: false",
        default: false,
      },
    },
    required: ["guildId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const params = new URLSearchParams()
      if ((args as any).withCounts) params.set("with_counts", "true")

      const qs = params.toString()
      const path = qs
        ? `${Routes.guild((args as any).guildId as `/${string}`)}?${qs}`
        : Routes.guild((args as any).guildId as `/${string}`)
      const guild = (await rest.get(path as `/${string}`)) as Record<string, unknown>

      return {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        description: guild.description,
        splash: guild.splash,
        discovery_splash: guild.discovery_splash,
        owner_id: guild.owner_id,
        region: guild.region,
        afk_channel_id: guild.afk_channel_id,
        afk_timeout: guild.afk_timeout,
        widget_enabled: guild.widget_enabled,
        widget_channel_id: guild.widget_channel_id,
        verification_level: guild.verification_level,
        default_message_notifications: guild.default_message_notifications,
        explicit_content_filter: guild.explicit_content_filter,
        mfa_level: guild.mfa_level,
        system_channel_id: guild.system_channel_id,
        system_channel_flags: guild.system_channel_flags,
        rules_channel_id: guild.rules_channel_id,
        max_presences: guild.max_presences,
        max_members: guild.max_members,
        vanity_url_code: guild.vanity_url_code,
        banner: guild.banner,
        premium_tier: guild.premium_tier,
        premium_subscription_count: guild.premium_subscription_count,
        preferred_locale: guild.preferred_locale,
        public_updates_channel_id: guild.public_updates_channel_id,
        max_video_channel_users: guild.max_video_channel_users,
        approximate_member_count: guild.approximate_member_count,
        approximate_presence_count: guild.approximate_presence_count,
        nsfw_level: guild.nsfw_level,
      }
    } catch (error) {
      handleDiscordError(error, "get guild")
    }
  },
}
