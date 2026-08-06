import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { USER_COMPACT_FIELDS } from "./_fields"
import { extractUser } from "./_helpers"
import { resolveFieldsList, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListUsersArgs {
  limit?: number
  cursor?: string
  includeDeleted?: boolean
  includeBots?: boolean
  fields?: string[]
  includeRaw?: boolean
}

export const listUsers: ToolConfig = {
  description:
    "List workspace users. Returns curated rows { id, name, realName, displayName, email, imageUrl, isBot, isAdmin, isOwner, deleted, tz } + nextCursor. Params: limit (1-200, def 100), cursor, includeDeleted (def false), includeBots (def true), fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Results per page. Min 1, max 200, default 100.",
      },
      cursor: {
        type: "string",
        description: "Slack cursor from previous response.nextCursor.",
      },
      includeDeleted: {
        type: "boolean",
        description: "Include deactivated users. Default false.",
      },
      includeBots: {
        type: "boolean",
        description: "Include bot users. Default true.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Slack user objects. Default false.",
      },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { limit, cursor, includeDeleted, includeBots, fields, includeRaw } = args as ListUsersArgs
    const pageSize = sanitizeLimit(limit, { max: 200, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.users.list({
        limit: pageSize,
        cursor,
        include_locale: false,
      }),
    )

    let rawUsers = result.members ?? []
    if (includeDeleted !== true) {
      rawUsers = rawUsers.filter((u) => !u.deleted)
    }
    if (includeBots === false) {
      rawUsers = rawUsers.filter((u) => !u.is_bot)
    }
    const shaped = rawUsers.map(extractUser)
    const users = resolveFieldsList(shaped as any, rawUsers, {
      includeRaw,
      fields,
      defaultFields: USER_COMPACT_FIELDS,
    })

    return {
      users,
      total: users.length,
      hasMore: !!result.response_metadata?.next_cursor,
      nextCursor: result.response_metadata?.next_cursor || null,
    }
  },
}
