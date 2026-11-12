/**
 * admin-api.usage — LLM Usage Metrics (admin)
 *
 * Actions:
 *   admin-api.usage-summary                   → GET /admin/usage/summary
 *   admin-api.usage-by-user                   → GET /admin/usage/by-user
 *   admin-api.usage-by-workspace              → GET /admin/usage/by-workspace
 *   admin-api.usage-by-agent                  → GET /admin/usage/by-agent
 *   admin-api.usage-by-model                  → GET /admin/usage/by-model
 *   admin-api.usage-expensive-conversations   → GET /admin/usage/expensive-conversations
 *   admin-api.usage-timeline                  → GET /admin/usage/timeline
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { HandlerError } from "../../../ws-framework/WsRouter"

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

type Period = "hour" | "day" | "week" | "month"

function getStartOfPeriod(period: Period): Date {
  const now = new Date()
  switch (period) {
    case "hour":
      return new Date(now.getTime() - 60 * 60 * 1000)
    case "day":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000)
    case "week":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case "month":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000)
  }
}

/**
 * Resolve the effective date range for a usage query.
 *
 * Priority: explicit startDate/endDate > legacy period > default (last 24h).
 * Returns a MongoDB-compatible `{ $gte, $lte }` filter and the resolved period
 * label for the response envelope.
 */
function resolveDateRange(data: {
  startDate?: string
  endDate?: string
  period?: Period
}): { dateFilter: { $gte?: Date; $lte?: Date }; period: Period | "custom" } {
  const dateFilter: { $gte?: Date; $lte?: Date } = {}

  if (data.startDate) {
    const d = new Date(data.startDate)
    if (!Number.isNaN(d.getTime())) dateFilter.$gte = d
  } else if (data.period) {
    dateFilter.$gte = getStartOfPeriod(data.period)
  } else {
    // Default: last 24h when no range is specified.
    dateFilter.$gte = getStartOfPeriod("day")
  }

  if (data.endDate) {
    const d = new Date(data.endDate)
    if (!Number.isNaN(d.getTime())) dateFilter.$lte = d
  }

  const period: Period | "custom" = data.startDate || data.endDate ? "custom" : (data.period ?? "day")
  return { dateFilter, period }
}

export function createUsageSummaryHandler(db: Db) {
  return async function usageSummary(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      period?: Period
      startDate?: string
      endDate?: string
      userId?: string
      workspaceId?: string
      agentId?: string
      provider?: string
    }
    const { dateFilter, period } = resolveDateRange(data)

    const summary = await db
      .collection("llm_usage")
      .aggregate([
        {
          $match: {
            ...(data.userId && { userId: data.userId }),
            ...(data.workspaceId && { workspaceId: data.workspaceId }),
            ...(data.agentId && { agentId: data.agentId }),
            ...(data.provider && { provider: data.provider }),
            timestamp: dateFilter,
          },
        },
        {
          $group: {
            _id: null,
            totalGenerations: { $sum: 1 },
            totalPromptTokens: { $sum: "$promptTokens" },
            totalCompletionTokens: { $sum: "$completionTokens" },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$costTotal" },
            totalInputCost: { $sum: "$costInput" },
            totalOutputCost: { $sum: "$costOutput" },
            totalCacheReadTokens: { $sum: { $ifNull: ["$cacheReadTokens", 0] } },
            totalCacheWriteTokens: { $sum: { $ifNull: ["$cacheWriteTokens", 0] } },
          },
        },
      ])
      .toArray()

    const result = summary[0] || {
      totalGenerations: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      totalInputCost: 0,
      totalOutputCost: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    }

    return {
      period,
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      filters: {
        userId: data.userId,
        workspaceId: data.workspaceId,
        agentId: data.agentId,
        provider: data.provider,
      },
      summary: result,
    }
  }
}

export function createUsageByUserHandler(db: Db) {
  return async function usageByUser(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      period?: Period
      limit?: number
      startDate?: string
      endDate?: string
    }
    const { dateFilter, period } = resolveDateRange(data)
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: dateFilter } },
        {
          $group: {
            _id: "$userId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$costTotal" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, startDate: data.startDate ?? null, endDate: data.endDate ?? null, users: results }
  }
}

export function createUsageByWorkspaceHandler(db: Db) {
  return async function usageByWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      period?: Period
      limit?: number
      startDate?: string
      endDate?: string
    }
    const { dateFilter, period } = resolveDateRange(data)
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: dateFilter, workspaceId: { $ne: null } } },
        {
          $group: {
            _id: "$workspaceId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$costTotal" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, startDate: data.startDate ?? null, endDate: data.endDate ?? null, workspaces: results }
  }
}

export function createUsageByAgentHandler(db: Db) {
  return async function usageByAgent(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      period?: Period
      limit?: number
      startDate?: string
      endDate?: string
    }
    const { dateFilter, period } = resolveDateRange(data)
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: dateFilter } },
        {
          $group: {
            _id: "$agentId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$costTotal" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, startDate: data.startDate ?? null, endDate: data.endDate ?? null, agents: results }
  }
}

export function createUsageByModelHandler(db: Db) {
  return async function usageByModel(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      period?: Period
      limit?: number
      startDate?: string
      endDate?: string
    }
    const { dateFilter, period } = resolveDateRange(data)
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: dateFilter } },
        {
          $group: {
            _id: { provider: "$provider", model: "$actualModel" },
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$costTotal" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, startDate: data.startDate ?? null, endDate: data.endDate ?? null, models: results }
  }
}

export function createUsageExpensiveConversationsHandler(db: Db) {
  return async function usageExpensiveConversations(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      period?: Period
      limit?: number
      startDate?: string
      endDate?: string
    }
    const { dateFilter, period } = resolveDateRange({
      ...data,
      // Preserve the original default of "week" for this endpoint.
      period: data.startDate || data.endDate ? undefined : (data.period ?? "week"),
    })
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: dateFilter } },
        {
          $group: {
            _id: "$channelId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$costTotal" },
            userId: { $first: "$userId" },
            agentId: { $first: "$agentId" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, startDate: data.startDate ?? null, endDate: data.endDate ?? null, conversations: results }
  }
}

type Granularity = "hour" | "day" | "week" | "month"

export function createUsageTimelineHandler(db: Db) {
  return async function usageTimeline(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      granularity?: Granularity
      startDate?: string
      endDate?: string
      // Legacy params (backward compat)
      period?: Period
      groupBy?: Granularity
    }

    // Resolve granularity: prefer "granularity" param, fall back to legacy "groupBy", default "day"
    const granularity: Granularity = data.granularity ?? data.groupBy ?? "day"

    // Resolve date range: use explicit startDate/endDate if provided.
    // Fall back to legacy "period" param for backward compat.
    // If neither is provided, default to all available data (no lower bound).
    const dateFilter: { $gte?: Date; $lte?: Date } = {}

    if (data.startDate) {
      dateFilter.$gte = new Date(data.startDate)
    } else if (data.period) {
      dateFilter.$gte = getStartOfPeriod(data.period)
    }

    if (data.endDate) {
      dateFilter.$lte = new Date(data.endDate)
    }

    const matchStage: Record<string, unknown> = {}
    if (Object.keys(dateFilter).length > 0) {
      matchStage.hourBucket = dateFilter
    }

    const results = await db
      .collection("agent_usage_rollups_hourly")
      .aggregate([
        ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
        {
          $group: {
            _id: { $dateTrunc: { date: "$hourBucket", unit: granularity } },
            sessionCount: { $sum: "$sessionCount" },
            completedCount: { $sum: "$completedCount" },
            abortedCount: { $sum: "$abortedCount" },
            erroredCount: { $sum: "$erroredCount" },
            timedOutCount: { $sum: "$timedOutCount" },
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
            totalTokens: { $sum: "$totalTokens" },
            cachedReadTokens: { $sum: "$cachedReadTokens" },
            cachedWriteTokens: { $sum: "$cachedWriteTokens" },
            costUsd: { $sum: "$costUsd" },
            agentActiveMs: { $sum: "$agentActiveMs" },
            rollupCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray()

    return {
      granularity,
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      timeline: results,
    }
  }
}
