import type { ToolConfig } from "@teros/mca-sdk"
import { getSlackSession } from "../lib"
import { tsToIso } from "./_helpers"
import { sanitiseBody, sanitizeLimit, wrapSlackCall } from "./utils"

interface GetIntegrationLogsArgs {
  appId?: string
  changeType?: string
  serviceId?: string
  user?: string
  count?: number
  page?: number
  includeRaw?: boolean
}

interface CuratedIntegrationLog {
  service: string | null
  serviceId: string | null
  app: string | null
  appType: string | null
  appId: string | null
  date: string | null
  changeType: string
  user: string | null
  userName: string | null
  channel: string | null
  scope: string | null
  reason: string | null
}

function extractIntegrationLog(raw: any): CuratedIntegrationLog {
  return {
    service: raw?.service_type ?? null,
    serviceId: raw?.service_id ?? null,
    app: raw?.app_type ?? null,
    appType: raw?.app_type ?? null,
    appId: raw?.app_id ?? null,
    date: tsToIso(raw?.date),
    changeType: raw?.change_type ?? "",
    user: raw?.user_id ?? null,
    userName: raw?.user_name ?? null,
    channel: raw?.channel ?? null,
    scope: raw?.scope ?? null,
    reason: raw?.reason ?? null,
  }
}

export const getIntegrationLogs: ToolConfig = {
  description:
    "Get integration audit trail (apps installed/uninstalled/scope changes). Paid plans only. Returns { logs, paging }. Retryable. Params: appId?, changeType? (added|removed|enabled|disabled|updated|expanded), serviceId?, user?, count (1-1000, def 100), page.",
  parameters: {
    type: "object",
    properties: {
      appId: { type: "string" },
      changeType: {
        type: "string",
        description: "Filter by change type.",
      },
      serviceId: { type: "string" },
      user: { type: "string" },
      count: { type: "number" },
      page: { type: "number" },
    },
  },
  annotations: {
    version: "1.0.0",
    stability: "stable",
    readOnlyHint: true,
    openWorldHint: true,
  } as any,
  handler: async (args, context) => {
    const { appId, changeType, serviceId, user, count, page, includeRaw} = args as unknown as GetIntegrationLogsArgs
    const safeCount = sanitizeLimit(count, { max: 1000, default: 100 })
    const { client } = await getSlackSession(context)
    const result = await wrapSlackCall(() =>
      (client as any).team.integrationLogs(
        sanitiseBody({
          app_id: appId,
          change_type: changeType,
          service_id: serviceId,
          user,
          count: safeCount,
          page,
        }) as any,
      ),
    )
    if (includeRaw) return result
    const logs = ((result as any).logs ?? []) as any[]
    return {
      logs: logs.map(extractIntegrationLog),
      count: logs.length,
      paging: (result as any).paging ?? null,
    }
  },
}
