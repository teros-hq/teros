import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { tsToIso } from "./_helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface ListConnectInvitesArgs {
  count?: number
  limit?: number
  cursor?: string
  teamId?: string
  includeRaw?: boolean
}

interface CuratedConnectInvite {
  inviteId: string
  status: string | null
  channel: string | null
  teamId: string | null
  invitedTeamId: string | null
  invitedUser: string | null
  dateCreated: string | null
  expirationAt: string | null
}

function extractInvite(raw: any): CuratedConnectInvite {
  return {
    inviteId: raw?.invite_id ?? raw?.id ?? "",
    status: raw?.status ?? null,
    channel: raw?.channel?.id ?? raw?.channel_id ?? null,
    teamId: raw?.team_id ?? null,
    invitedTeamId: raw?.invited_team_id ?? null,
    invitedUser: raw?.invited_user ?? null,
    dateCreated: tsToIso(raw?.date_created),
    expirationAt: tsToIso(raw?.expiration_ts),
  }
}

export const listConnectInvites: ToolConfig = {
  description:
    "List pending Slack Connect (cross-workspace) channel invites. Returns { invites, nextCursor, hasMore }. Retryable. Params: count (1-100, def 50), cursor?, teamId?.",
  parameters: {
    type: "object",
    properties: {
      count: { type: "number", description: "Per page (1-100, def 50)." },
      cursor: { type: "string" },
      teamId: { type: "string", description: "Filter by team id." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { count, limit, cursor, teamId, includeRaw} = args as unknown as ListConnectInvitesArgs
    const safeCount = sanitizeLimit(limit ?? count, { max: 100, default: 50 })
    const { botClient: client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      (client as any).conversations.listConnectInvites(
        sanitiseBody({ count: safeCount, cursor, team_id: teamId }) as any,
      ),
    )
    if (includeRaw) return result
    const invites = (((result as any).invites ?? []) as any[]).map(extractInvite)
    return {
      invites,
      count: invites.length,
      nextCursor: (result as any).response_metadata?.next_cursor || null,
      hasMore: Boolean((result as any).response_metadata?.next_cursor),
    }
  },
}
