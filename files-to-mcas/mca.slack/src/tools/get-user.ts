import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession, handleSlackError } from "../lib"

interface GetUserArgs {
  userId?: string
  email?: string
}

export const getUser: ToolConfig = {
  description: "Get detailed information about a specific Slack user by ID or email.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Slack user ID (e.g. U1234567890). Mutually exclusive with email.",
      },
      email: {
        type: "string",
        description: "User email to look up. Mutually exclusive with userId.",
      },
    },
  },
  handler: async (args, context) => {
    const { userId, email } = (args as unknown) as GetUserArgs
    try {
      const { client } = await getSlackSession(context)

      let user: any
      if (userId) {
        const result = await client.users.info({ user: userId })
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error")
        }
        user = result.user
      } else if (email) {
        const result = await client.users.lookupByEmail({ email })
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error")
        }
        user = result.user
      } else {
        throw new Error("Either userId or email must be provided")
      }

      return {
        id: user.id,
        name: user.name,
        realName: user.profile?.real_name ?? user.real_name ?? user.name,
        displayName: user.profile?.display_name ?? "",
        email: user.profile?.email ?? "",
        phone: user.profile?.phone ?? "",
        isAdmin: user.is_admin,
        isOwner: user.is_owner,
        isBot: user.is_bot,
        isRestricted: user.is_restricted,
        deleted: user.deleted,
        timezone: user.tz ?? "",
        status: user.profile?.status_text ?? "",
        statusEmoji: user.profile?.status_emoji ?? "",
        avatarUrl: user.profile?.image_192 ?? user.profile?.image_72 ?? "",
        title: user.profile?.title ?? "",
        teamId: user.team_id,
      }
    } catch (error) {
      handleSlackError(error, "get user")
    }
  },
}
