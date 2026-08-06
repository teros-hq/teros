/**
 * workspace.usage-* — Workspace-scoped agent usage queries.
 *
 * Auth: workspaceService.canAdmin(workspaceId, ctx.userId). System admin
 * users do not pass through here; they call admin-api.agent-usage-*.
 *
 * Forces `workspaceId` from the request body so a workspace admin cannot
 * accidentally query other workspaces.
 *
 *
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { WorkspaceService } from "../../../services/workspace-service"
import { HandlerError } from "../../../ws-framework/WsRouter"
import {
  buildSessionsListPipeline,
  buildTokensPerHourPipeline,
  parseQuery,
} from "../../../services/agent-usage-query-helper"
import type { AgentUsageSession } from "../../../types/database"

async function requireWorkspaceAdmin(
  workspaceService: WorkspaceService,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const ok = await workspaceService.canAdmin(workspaceId, userId)
  if (!ok) throw new HandlerError("ACCESS_DENIED", "Workspace admin privileges required")
}

export function createWorkspaceUsageTokensPerHourHandler(
  db: Db,
  workspaceService: WorkspaceService,
) {
  return async function workspaceUsageTokensPerHour(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as { workspaceId?: string }
    if (!data.workspaceId) throw new HandlerError("INVALID_INPUT", "workspaceId is required")
    await requireWorkspaceAdmin(workspaceService, data.workspaceId, ctx.userId)
    const query = parseQuery({ ...data, workspaceId: data.workspaceId }, { allowEmptyFilters: true })
    query.workspaceId = data.workspaceId
    const pipeline = buildTokensPerHourPipeline(query)
    const collection = query.timeMetric === "userActive"
      ? "agent_usage_rollups_user_hourly"
      : "agent_usage_rollups_hourly"
    const buckets = await db.collection(collection).aggregate(pipeline).toArray()
    return { filters: query, buckets, bucketTimeZone: query.timeZone, source: "rollup" as const }
  }
}

export function createWorkspaceUsageListSessionsHandler(
  db: Db,
  workspaceService: WorkspaceService,
) {
  return async function workspaceUsageListSessions(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as { workspaceId?: string }
    if (!data.workspaceId) throw new HandlerError("INVALID_INPUT", "workspaceId is required")
    await requireWorkspaceAdmin(workspaceService, data.workspaceId, ctx.userId)
    const query = parseQuery({ ...data, workspaceId: data.workspaceId }, { allowEmptyFilters: true })
    query.workspaceId = data.workspaceId
    const { filter, limit, skip } = buildSessionsListPipeline(query)
    const items = await db
      .collection<AgentUsageSession>("agent_usage_sessions")
      .find(filter)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()
    return { items, limit, skip }
  }
}
