import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { tsToIso } from "./_helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface GetAccessLogsArgs {
  before?: number
  count?: number
  page?: number
  includeRaw?: boolean
}

interface CuratedAccessLog {
  userId: string | null
  username: string | null
  dateFirst: string | null
  dateLast: string | null
  count: number
  ip: string | null
  userAgent: string | null
  isp: string | null
  country: string | null
  region: string | null
}

function extractLog(raw: any): CuratedAccessLog {
  return {
    userId: raw?.user_id ?? null,
    username: raw?.username ?? null,
    dateFirst: tsToIso(raw?.date_first),
    dateLast: tsToIso(raw?.date_last),
    count: raw?.count ?? 0,
    ip: raw?.ip ?? null,
    userAgent: raw?.user_agent ?? null,
    isp: raw?.isp ?? null,
    country: raw?.country ?? null,
    region: raw?.region ?? null,
  }
}

export const getAccessLogs: ToolConfig = {
  description:
    "Get login audit trail for the workspace (paid plans only). Returns { logs, paging }. Retryable. Params: before? (unix seconds), count (1-1000, def 100), page.",
  parameters: {
    type: "object",
    properties: {
      before: { type: "number", description: "Filter to logs before this unix timestamp." },
      count: { type: "number", description: "Per page (1-1000, def 100)." },
      page: { type: "number", description: "Page number." },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { before, count, page, includeRaw} = args as unknown as GetAccessLogsArgs
    const safeCount = sanitizeLimit(count, { max: 1000, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      client.team.accessLogs(sanitiseBody({ before, count: safeCount, page }) as any),
    )
    if (includeRaw) return result
    const logs = ((result as any).logins ?? []) as any[]
    return {
      logs: logs.map(extractLog),
      count: logs.length,
      paging: (result as any).paging ?? null,
    }
  },
}
