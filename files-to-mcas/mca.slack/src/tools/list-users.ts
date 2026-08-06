import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface ListUsersArgs {
  limit?: number
  cursor?: string
  includePresence?: boolean
}

export const listUsers: ToolConfig = {
  description: "List users in the Slack workspace. Supports pagination and optional presence.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max users per page (1-200). Default: 100",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor from previous response",
      },
      includePresence: {
        type: "boolean",
        description: "Include user presence status. Default: false",
      },
    },
  },
  handler: async (args, context) => {
    const { limit, cursor, includePresence } = (args as unknown) as ListUsersArgs
    try {
      const { client } = await getSlackSession(context)
      const result = await client.users.list({
        limit: limit ?? 100,
        cursor,
        include_locale: false,
      })

      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error")
      }

      let users = (result.members ?? []).map((u) => ({
        id: u.id,
        name: u.name,
        realName: u.profile?.real_name ?? u.real_name ?? u.name,
        displayName: u.profile?.display_name ?? "",
        email: u.profile?.email ?? "",
        isAdmin: u.is_admin,
        isOwner: u.is_owner,
        isBot: u.is_bot,
        isRestricted: u.is_restricted,
        isUltraRestricted: u.is_ultra_restricted,
        deleted: u.deleted,
        timezone: u.tz ?? "",
        status: u.profile?.status_text ?? "",
        avatarUrl: u.profile?.image_72 ?? "",
        title: u.profile?.title ?? "",
      }))

      if (includePresence && users.length > 0) {
        try {
          const userIds = users.map((u) => u.id).filter(Boolean)
          const presenceResult = await client.users.getPresence({ user: userIds[0] })
          if (presenceResult.ok && userIds[0]) {
            const idx = users.findIndex((u) => u.id === userIds[0])
            if (idx >= 0) {
              (users[idx] as any).presence = presenceResult.presence
            }
          }
        } catch {
          // Presence fetch is best-effort
        }
      }

      return {
        users,
        nextCursor: result.response_metadata?.next_cursor ?? null,
        total: users.length,
      }
    } catch (error) {
      handleSlackError(error, "list users")
    }
  },
}
