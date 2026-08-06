import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { extractPresence, validateUserId } from "./_helpers"
import { wrapSlackCall } from "./utils"

interface GetUserPresenceArgs {
  userId: string
  includeRaw?: boolean
}

export const getUserPresence: ToolConfig = {
  description:
    "Get presence for a Slack user. Returns { user, presence, online, autoAway, manualAway, connectionCount, lastActivity }. Params: userId.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Slack user id (U... or W...).",
      },
    },
    required: ["userId"],
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { userId, includeRaw} = args as unknown as GetUserPresenceArgs
    validateUserId(userId, "userId")
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() => client.users.getPresence({ user: userId }))
    if (includeRaw) return result
    return extractPresence(userId, result)
  },
}
