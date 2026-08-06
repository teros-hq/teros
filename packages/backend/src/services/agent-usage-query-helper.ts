/**
 * Shared query helper for agent-usage queries.
 *
 * Used by:
 *   - admin-api.agent-usage-* (no scoping)
 *   - workspace.usage-*       (forces workspaceId)
 *   - user-api.my-usage-*     (forces userId = ctx.userId, default triggerKind='user_message')
 *
 *
 */

import type { Filter } from "mongodb"
import { HandlerError } from "../ws-framework/WsRouter"
import type {
  AgentUsageSession,
  AgentUsageTriggerKind,
  LLMUsage,
  ToolExecution,
} from "../types/database"
import { EXCLUDE_DEMO_SEED } from "./agent-usage-demo-filter"

/**
 * Coerce a scalar filter value to a plain string before it reaches a Mongo
 * `$match`/`find` clause. A non-string (e.g. `{ $ne: null }`) would be a NoSQL
 * operator injection, so it collapses to `undefined` (ignored). Shared by
 * `parseQuery` and any handler that filters by raw ids without going through it
 * (TER-616/R8.4, A6.2).
 */
export function coerceIdFilter(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

export interface AgentUsageQuery {
  userId?: string
  agentId?: string
  workspaceId?: string
  provider?: LLMUsage["provider"]
  triggerKind?: AgentUsageTriggerKind
  from: Date
  to: Date
  groupBy: "hour" | "day" | "week"
  timeMetric: "userActive" | "agentActive"
  /**
   * Collapse the per-(user×agent×provider×workspace) rows to ONE row per time
   * bucket — the shape the KPI/quota path needs (it re-collapses client-side
   * anyway). Cuts the result from O(groups×buckets) to O(buckets): 144k rows →
   * 30 at 30d ×100 (A4.6). `userActive` is already bucket-only; this extends it
   * to `agentActive`.
   */
  collapseGroups?: boolean
  statuses?: AgentUsageSession["status"][]
  timeZone: string
  format: "native" | "otel"
  limit: number
  skip: number
}

export function parseQuery(
  raw: unknown,
  opts: { allowEmptyFilters: boolean },
): AgentUsageQuery {
  const data = (raw ?? {}) as Record<string, unknown>
  const fromStr = data.from as string | undefined
  const toStr = data.to as string | undefined
  if (!fromStr || !toStr) {
    throw new HandlerError("INVALID_INPUT", "from and to are required (ISO date)")
  }
  const from = new Date(fromStr)
  const to = new Date(toStr)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HandlerError("INVALID_INPUT", "from/to must be valid ISO dates")
  }
  if (from >= to) {
    throw new HandlerError("INVALID_INPUT", "from must be < to")
  }

  // Coerce scalar filters to plain strings — these flow straight into Mongo
  // `$match` clauses, so an object like `{ $ne: null }` would be a NoSQL
  // operator injection. Defense-in-depth for EVERY admin handler that calls
  // parseQuery (TER-616/R8.4). Non-strings become `undefined` (ignored).
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
  const filters = {
    userId: str(data.userId),
    agentId: str(data.agentId),
    workspaceId: str(data.workspaceId),
    provider: str(data.provider) as LLMUsage["provider"] | undefined,
  }
  const hasFilter = Object.values(filters).some((v) => !!v)
  if (!opts.allowEmptyFilters && !hasFilter) {
    throw new HandlerError(
      "INVALID_INPUT",
      "At least one of userId/agentId/workspaceId/provider is required",
    )
  }

  return {
    ...filters,
    triggerKind: str(data.triggerKind) as AgentUsageTriggerKind | undefined,
    from,
    to,
    groupBy: (data.groupBy as AgentUsageQuery["groupBy"]) ?? "hour",
    timeMetric: (data.timeMetric as AgentUsageQuery["timeMetric"]) ?? "agentActive",
    collapseGroups: data.collapseGroups === true,
    // Keep only string members — a status filter also reaches `$match`/`$in`.
    statuses: Array.isArray(data.statuses)
      ? (data.statuses.filter((s) => typeof s === "string") as AgentUsageSession["status"][])
      : undefined,
    timeZone: str(data.timeZone) ?? "UTC",
    format: (data.format as AgentUsageQuery["format"]) ?? "native",
    limit: clampLimit(data.limit),
    skip: clampSkip(data.skip),
  }
}

/**
 * Aggregation pipeline against agent_usage_rollups_hourly (timeMetric='agentActive')
 * or agent_usage_rollups_user_hourly (timeMetric='userActive').
 *
 * In both cases the bucket is UTC (decision #25) and the response includes the
 * timezone label so the frontend can render local times without re-bucketing.
 */
export function buildTokensPerHourPipeline(query: AgentUsageQuery): object[] {
  const groupUnit = query.groupBy === "hour" ? "hour" : query.groupBy === "day" ? "day" : "week"

  const isUserMetric = query.timeMetric === "userActive"
  // Bucket-only output when the metric is userActive (never carried the dims) or
  // the caller asked to collapse groups for the KPI/quota path (A4.6).
  const bucketOnly = isUserMetric || query.collapseGroups === true
  const match: Record<string, unknown> = {
    hourBucket: { $gte: query.from, $lt: query.to },
    ...EXCLUDE_DEMO_SEED,
  }
  if (query.userId) match["groupKey.userId"] = query.userId
  if (query.workspaceId) match["groupKey.workspaceId"] = query.workspaceId
  if (!isUserMetric) {
    if (query.agentId) match["groupKey.agentId"] = query.agentId
    if (query.provider) match["groupKey.provider"] = query.provider
  }

  return [
    { $match: match },
    {
      $group: {
        _id: {
          bucket: {
            $dateTrunc: {
              date: "$hourBucket",
              unit: groupUnit,
              timezone: "UTC",
            },
          },
          ...(bucketOnly
            ? {}
            : {
                userId: "$groupKey.userId",
                agentId: "$groupKey.agentId",
                provider: "$groupKey.provider",
                workspaceId: "$groupKey.workspaceId",
              }),
        },
        inputTokens: { $sum: "$inputTokens" },
        outputTokens: { $sum: "$outputTokens" },
        cachedReadTokens: { $sum: "$cachedReadTokens" },
        totalTokens: { $sum: "$totalTokens" },
        costUsd: { $sum: "$costUsd" },
        activeMs: { $sum: isUserMetric ? "$userActiveMs" : "$agentActiveMs" },
        sessionCount: { $sum: "$sessionCount" },
      },
    },
    {
      $project: {
        _id: 0,
        bucket: "$_id.bucket",
        groupKey: bucketOnly
          ? {}
          : {
              userId: "$_id.userId",
              agentId: "$_id.agentId",
              provider: "$_id.provider",
              workspaceId: "$_id.workspaceId",
            },
        inputTokens: 1,
        outputTokens: 1,
        cachedReadTokens: 1,
        totalTokens: 1,
        costUsd: 1,
        activeMs: 1,
        activeHours: { $divide: ["$activeMs", 3_600_000] },
        sessionCount: 1,
        tokensPerActiveHour: {
          $cond: [
            { $gt: ["$activeMs", 0] },
            { $divide: ["$totalTokens", { $divide: ["$activeMs", 3_600_000] }] },
            null,
          ],
        },
      },
    },
    { $sort: { bucket: 1 } },
  ]
}

export function buildSessionsListPipeline(query: AgentUsageQuery): {
  filter: Filter<AgentUsageSession>
  limit: number
  skip: number
} {
  const filter: Filter<AgentUsageSession> = {
    startedAt: { $gte: query.from, $lt: query.to },
    ...EXCLUDE_DEMO_SEED,
  }
  if (query.userId) filter.userId = query.userId
  if (query.agentId) filter.agentId = query.agentId
  if (query.workspaceId) filter.workspaceId = query.workspaceId
  if (query.provider) filter.provider = query.provider
  if (query.triggerKind) filter.triggerKind = query.triggerKind
  if (query.statuses && query.statuses.length > 0) filter.status = { $in: query.statuses }
  return { filter, limit: query.limit, skip: query.skip }
}

export function buildToolExecutionsListPipeline(query: AgentUsageQuery): {
  filter: Filter<ToolExecution>
  limit: number
  skip: number
} {
  const filter: Filter<ToolExecution> = {
    startedAt: { $gte: query.from, $lt: query.to },
    ...EXCLUDE_DEMO_SEED,
  }
  if (query.userId) filter.userId = query.userId
  if (query.agentId) filter.agentId = query.agentId
  if (query.workspaceId) filter.workspaceId = query.workspaceId
  return { filter, limit: query.limit, skip: query.skip }
}

/** Wire shape of one `-tokens-per-hour` bucket row (rollup pipeline output). */
export interface TokensBucketRow {
  bucket: Date
  groupKey: {
    userId?: string
    agentId?: string
    provider?: string
    workspaceId?: string
  }
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  totalTokens: number
  costUsd: number
  activeMs: number
  activeHours: number
  sessionCount: number
  tokensPerActiveHour: number | null
}

/**
 * UTC bucket truncation matching the `$dateTrunc` used by the rollup pipeline
 * (week starts Sunday — Mongo's default). Keeping both truncations identical is
 * what makes merging live rows into rollup rows safe.
 */
export function truncateToBucket(date: Date, unit: AgentUsageQuery["groupBy"]): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()),
  )
  if (unit === "hour") return d
  d.setUTCHours(0)
  if (unit === "day") return d
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d
}

/**
 * Aggregate LIVE (in-progress hour) sessions into `-tokens-per-hour` bucket rows
 * (TER-645 pattern, extended from model-health to the token/KPI query). The
 * rollup job only writes CLOSED hours, so without this the KPIs read 0 for the
 * current hour — with period=1h the dashboard showed zeros while the sessions
 * table listed live sessions.
 *
 * Sessions contribute WHOLE (fraction 1) to their `startedAt` bucket — same
 * approximation as `loadLiveHourModelHealth`; exact split math only matters for
 * closed hours, which the rollup owns. A still-running session (durationMs
 * null) counts `now − startedAt` as active time.
 */
export function buildLiveTokensBuckets(
  sessions: Pick<
    AgentUsageSession,
    | "userId"
    | "agentId"
    | "workspaceId"
    | "provider"
    | "startedAt"
    | "durationMs"
    | "inputTokens"
    | "outputTokens"
    | "cachedReadTokens"
    | "totalTokens"
    | "costUsd"
  >[],
  groupBy: AgentUsageQuery["groupBy"],
  now: Date,
): TokensBucketRow[] {
  const acc = new Map<string, TokensBucketRow>()
  for (const s of sessions) {
    // Queued sessions have no execution anchor (startedAt=null, TER-650/G1): no
    // billable tokens/active time, so they don't belong in the analytics buckets
    // (mirrors the billing rollup's startedAt-based overlap filter).
    if (!s.startedAt) continue
    const bucket = truncateToBucket(s.startedAt, groupBy)
    const groupKey = {
      userId: s.userId,
      agentId: s.agentId,
      provider: s.provider,
      workspaceId: s.workspaceId,
    }
    const key = `${bucket.getTime()}|${s.userId}|${s.agentId}|${s.provider}|${s.workspaceId}`
    const row =
      acc.get(key) ??
      ({
        bucket,
        groupKey,
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        activeMs: 0,
        activeHours: 0,
        sessionCount: 0,
        tokensPerActiveHour: null,
      } satisfies TokensBucketRow)
    row.inputTokens += s.inputTokens || 0
    row.outputTokens += s.outputTokens || 0
    row.cachedReadTokens += s.cachedReadTokens || 0
    row.totalTokens += s.totalTokens || 0
    row.costUsd += s.costUsd || 0
    row.activeMs += Math.max(0, s.durationMs ?? now.getTime() - s.startedAt.getTime())
    row.sessionCount += 1
    acc.set(key, row)
  }
  return [...acc.values()].map(finishBucketRow).sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
}

/**
 * Merge live rows into the rollup rows, summing rows that share
 * `(bucket, groupKey)` — with `groupBy: 'day'` the in-progress hour lands in a
 * day bucket that already has closed hours, and emitting a duplicate row would
 * double-render that groupKey downstream.
 */
export function mergeTokensBucketRows(
  rollupRows: TokensBucketRow[],
  liveRows: TokensBucketRow[],
): TokensBucketRow[] {
  if (liveRows.length === 0) return rollupRows
  const keyOf = (r: TokensBucketRow) =>
    `${new Date(r.bucket).getTime()}|${r.groupKey?.userId}|${r.groupKey?.agentId}|${r.groupKey?.provider}|${r.groupKey?.workspaceId}`
  const merged = new Map<string, TokensBucketRow>()
  for (const r of rollupRows) merged.set(keyOf(r), { ...r })
  for (const live of liveRows) {
    const key = keyOf(live)
    const base = merged.get(key)
    if (!base) {
      merged.set(key, { ...live })
      continue
    }
    base.inputTokens += live.inputTokens
    base.outputTokens += live.outputTokens
    base.cachedReadTokens += live.cachedReadTokens
    base.totalTokens += live.totalTokens
    base.costUsd += live.costUsd
    base.activeMs += live.activeMs
    base.sessionCount += live.sessionCount
    finishBucketRow(base)
  }
  return [...merged.values()].sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime())
}

/** Recompute the derived fields after summing the additive ones. */
function finishBucketRow(row: TokensBucketRow): TokensBucketRow {
  row.activeHours = row.activeMs / 3_600_000
  row.tokensPerActiveHour = row.activeMs > 0 ? row.totalTokens / (row.activeMs / 3_600_000) : null
  return row
}

function clampLimit(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(500, Math.floor(n))
}

function clampSkip(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}
