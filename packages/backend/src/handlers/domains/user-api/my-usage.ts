/**
 * user-api.my-usage-* — Self-service agent usage queries.
 *
 * Auth: only `ctx.userId` (no role check). The handler forces
 * `userId = ctx.userId` so a user can never query someone else's data.
 *
 * Default `triggerKind='user_message'` to hide autorun / scheduled / event
 * activity that the user didn't directly trigger (decision #8).
 *
 *
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import {
  buildSessionsListPipeline,
  buildTokensPerHourPipeline,
  parseQuery,
} from "../../../services/agent-usage-query-helper"
import type { AgentUsageSession } from "../../../types/database"

export function createMyUsageTokensPerHourHandler(db: Db) {
  return async function myUsageTokensPerHour(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as Record<string, unknown>
    const query = parseQuery(
      { ...data, userId: ctx.userId, triggerKind: data.triggerKind ?? "user_message" },
      { allowEmptyFilters: true },
    )
    query.userId = ctx.userId
    if (!query.triggerKind) query.triggerKind = "user_message"
    const pipeline = buildTokensPerHourPipeline(query)
    const collection = query.timeMetric === "userActive"
      ? "agent_usage_rollups_user_hourly"
      : "agent_usage_rollups_hourly"
    const buckets = await db.collection(collection).aggregate(pipeline).toArray()
    return { filters: query, buckets, bucketTimeZone: query.timeZone, source: "rollup" as const }
  }
}

export function createMyUsageListSessionsHandler(db: Db) {
  return async function myUsageListSessions(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as Record<string, unknown>
    const query = parseQuery(
      { ...data, userId: ctx.userId, triggerKind: data.triggerKind ?? "user_message" },
      { allowEmptyFilters: true },
    )
    query.userId = ctx.userId
    if (!query.triggerKind) query.triggerKind = "user_message"
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
