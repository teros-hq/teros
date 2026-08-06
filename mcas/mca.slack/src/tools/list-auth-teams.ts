import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListAuthTeamsArgs {
  includeIcon?: boolean
  limit?: number
  cursor?: string
  includeRaw?: boolean
}

interface CuratedAuthTeam {
  id: string
  name: string
  domain: string | null
  iconUrl: string | null
  enterpriseId: string | null
}

export const listAuthTeams: ToolConfig = {
  description:
    "List Slack workspaces the current token has access to (relevant in Enterprise Grid). Returns { teams, nextCursor, hasMore }. Retryable. Params: includeIcon (def false), limit (1-100, def 100), cursor?.",
  parameters: {
    type: "object",
    properties: {
      includeIcon: { type: "boolean", description: "Include team icons. Default false." },
      limit: { type: "number", description: "Per page (1-100, def 100)." },
      cursor: { type: "string", description: "Pagination cursor." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { includeIcon, limit, cursor, includeRaw} = args as unknown as ListAuthTeamsArgs
    const safeLimit = sanitizeLimit(limit, { max: 100, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      (client as any).auth.teams.list(
        sanitiseBody({
          include_icon: includeIcon ?? false,
          limit: safeLimit,
          cursor,
        }) as any,
      ),
    )
    if (includeRaw) return result
    const rawTeams = ((result as any).teams ?? []) as any[]
    const teams: CuratedAuthTeam[] = rawTeams.map((t) => ({
      id: t?.id ?? "",
      name: t?.name ?? "",
      domain: t?.domain ?? null,
      iconUrl: t?.icon?.image_default ?? t?.icon?.image_88 ?? null,
      enterpriseId: t?.enterprise_id ?? null,
    }))
    return {
      teams,
      count: teams.length,
      nextCursor: (result as any).response_metadata?.next_cursor || null,
      hasMore: Boolean((result as any).response_metadata?.next_cursor),
    }
  },
}
