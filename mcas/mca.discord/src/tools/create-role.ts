import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getDiscordSession, handleDiscordError } from "../lib"
import { Routes } from "discord.js"

export const createRole: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: "Create a new role in a guild. Requires Manage Roles permission.",
  parameters: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Guild ID (snowflake)",
      },
      name: {
        type: "string",
        description: "Role name (max 100 characters)",
        default: "new role",
      },
      color: {
        type: "number",
        description: "Role color as integer (0 = no color). Use RGB integer value.",
        default: 0,
      },
      hoist: {
        type: "boolean",
        description: "Display role members separately in online list. Default: false",
        default: false,
      },
      icon: {
        type: "string",
        description: "Base64-encoded role icon image (PNG/JPEG, max 256x256)",
      },
      unicodeEmoji: {
        type: "string",
        description: "Unicode emoji to use as role icon",
      },
      mentionable: {
        type: "boolean",
        description: "Allow anyone to @mention this role. Default: false",
        default: false,
      },
      permissions: {
        type: "string",
        description: "Permission bitfield as string. Default: '0'",
        default: "0",
      },
      reason: {
        type: "string",
        description: "Optional audit log reason",
      },
    },
    required: ["guildId"],
  },
  handler: async (args, context) => {
    try {
      const { rest } = await getDiscordSession(context)
      const body: Record<string, unknown> = {
        name: (args as any).name ?? "new role",
        color: (args as any).color ?? 0,
        hoist: (args as any).hoist ?? false,
        mentionable: (args as any).mentionable ?? false,
        permissions: (args as any).permissions ?? "0",
      }
      if ((args as any).icon) body.icon = (args as any).icon
      if ((args as any).unicodeEmoji) body.unicode_emoji = (args as any).unicodeEmoji

      const headers: Record<string, string> = {}
      if ((args as any).reason) headers["X-Audit-Log-Reason"] = (args as any).reason

      const role = (await rest.post(Routes.guildRoles((args as any).guildId), { body, headers })) as Record<string, unknown>

      return {
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        icon: role.icon,
        unicode_emoji: role.unicode_emoji,
        position: role.position,
        permissions: role.permissions,
        managed: role.managed,
        mentionable: role.mentionable,
        flags: role.flags,
      }
    } catch (error) {
      handleDiscordError(error, "create role")
    }
  },
}
