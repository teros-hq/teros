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

export function createUsageSummaryHandler(db: Db) {
  return async function usageSummary(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      period?: Period
      userId?: string
      workspaceId?: string
      agentId?: string
      provider?: string
    }
    const period = data.period ?? "day"

    const summary = await db
      .collection("llm_usage")
      .aggregate([
        {
          $match: {
            ...(data.userId && { userId: data.userId }),
            ...(data.workspaceId && { workspaceId: data.workspaceId }),
            ...(data.agentId && { agentId: data.agentId }),
            ...(data.provider && { provider: data.provider }),
            timestamp: { $gte: getStartOfPeriod(period) },
          },
        },
        {
          $group: {
            _id: null,
            totalGenerations: { $sum: 1 },
            totalPromptTokens: { $sum: "$promptTokens" },
            totalCompletionTokens: { $sum: "$completionTokens" },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$totalCost" },
            totalInputCost: { $sum: "$inputCost" },
            totalOutputCost: { $sum: "$outputCost" },
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
    const data = (rawData ?? {}) as { period?: Period; limit?: number }
    const period = data.period ?? "day"
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: { $gte: getStartOfPeriod(period) } } },
        {
          $group: {
            _id: "$userId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$totalCost" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, users: results }
  }
}

export function createUsageByWorkspaceHandler(db: Db) {
  return async function usageByWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { period?: Period; limit?: number }
    const period = data.period ?? "day"
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: { $gte: getStartOfPeriod(period) }, workspaceId: { $ne: null } } },
        {
          $group: {
            _id: "$workspaceId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$totalCost" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, workspaces: results }
  }
}

export function createUsageByAgentHandler(db: Db) {
  return async function usageByAgent(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { period?: Period; limit?: number }
    const period = data.period ?? "day"
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: { $gte: getStartOfPeriod(period) } } },
        {
          $group: {
            _id: "$agentId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$totalCost" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, agents: results }
  }
}

export function createUsageByModelHandler(db: Db) {
  return async function usageByModel(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { period?: Period; limit?: number }
    const period = data.period ?? "day"
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: { $gte: getStartOfPeriod(period) } } },
        {
          $group: {
            _id: { provider: "$provider", model: "$actualModel" },
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$totalCost" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, models: results }
  }
}

export function createUsageExpensiveConversationsHandler(db: Db) {
  return async function usageExpensiveConversations(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { period?: Period; limit?: number }
    const period = data.period ?? "week"
    const limit = data.limit ?? 10

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: { $gte: getStartOfPeriod(period) } } },
        {
          $group: {
            _id: "$channelId",
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$totalCost" },
            userId: { $first: "$userId" },
            agentId: { $first: "$agentId" },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: limit },
      ])
      .toArray()

    return { period, conversations: results }
  }
}

export function createUsageTimelineHandler(db: Db) {
  return async function usageTimeline(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { period?: Period; groupBy?: "hour" | "day" }
    const period = data.period ?? "day"
    const groupBy = data.groupBy ?? "hour"

    const results = await db
      .collection("llm_usage")
      .aggregate([
        { $match: { timestamp: { $gte: getStartOfPeriod(period) } } },
        {
          $group: {
            _id: { $dateTrunc: { date: "$timestamp", unit: groupBy } },
            generations: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            totalCost: { $sum: "$totalCost" },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray()

    return { period, groupBy, timeline: results }
  }
}
