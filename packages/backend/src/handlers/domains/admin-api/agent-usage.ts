/**
 * admin-api.agent-usage-* — Agent usage queries (system admin).
 *
 * Actions:
 *   admin-api.agent-usage-tokens-per-hour   — buckets per (user×agent×provider) or per (user)
 *   admin-api.agent-usage-list-sessions     — paginated raw sessions
 *   admin-api.agent-usage-tool-executions-list — paginated tool executions
 *   admin-api.agent-usage-health            — buffer + reconciler + rollup metrics
 *
 * Auth: requireSystemAdmin (users.role ∈ {'admin','super'}).
 *
 *
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { getSystemRole, requireSystemAdmin } from "../../../auth/auth-helpers"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { recordSessionDetailAccess } from "../../../services/agent-usage-access-log"
import {
  type AgentUsageQuery,
  type TokensBucketRow,
  buildLiveTokensBuckets,
  buildSessionsListPipeline,
  buildToolExecutionsListPipeline,
  buildTokensPerHourPipeline,
  coerceIdFilter,
  mergeTokensBucketRows,
  parseQuery,
} from "../../../services/agent-usage-query-helper"
import { EXCLUDE_DEMO_SEED } from "../../../services/agent-usage-demo-filter"
import type { AgentUsageReconciler } from "../../../services/agent-usage-reconciler"
import type { AgentUsageRollupJob } from "../../../services/agent-usage-rollup-job"
import { floorToMinute, TtlCache } from "../../../services/ttl-cache"
import type { UsageEventBuffer } from "../../../services/usage-event-buffer"
import type {
  AgentUsageRollupHourly,
  AgentUsageSession,
  LLMUsage,
  MessageFeedback,
  ModelHealthEntry,
  ToolExecution,
} from "../../../types/database"
import { toOtelGenAI } from "../../../services/agent-usage-otel-mapper"
import {
  assembleSessionTrace,
  type TraceChannelMessage,
} from "../../../services/session-trace-assembler"
import { traceIdFor } from "../../../services/otel-span-builder"
import type {
  LatitudeSignalBadge,
  LatitudeSignalIndex,
} from "../../../services/latitude-signal-index"
import {
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
  getEffectiveLimit,
} from "../../../models/billing"
import {
  aggregateModelHealth,
  aggregateModelHealthByHour,
  applyThroughputToSummaries,
  applyThumbsToSummaries,
  buildModelHealthFromSessions,
  type ThumbsByKey,
} from "../../../services/model-health-aggregator"
import { buildModelHealthMergePipeline } from "../../../services/model-health-merge-pipeline"
import { getUpstreamStatus } from "../../../services/upstream-status"
import { getInflightSnapshot, getInflightTotal } from "@teros/core"

export interface AgentUsageHealthDeps {
  buffer: UsageEventBuffer
  reconciler: AgentUsageReconciler
  rollup: AgentUsageRollupJob
}

/**
 * Server-side ceiling on every admin-api agent-usage query (A6.4/TER-675). An
 * unindexed/pathological cross-tenant scan can't pin the single-process event
 * loop indefinitely — Mongo aborts it at 5 s and the handler surfaces the error
 * instead of hanging every WS user. Crosses backlog TER-67.
 */
const ADMIN_MAX_TIME_MS = 5000

/** Fields `buildModelHealthFromSessions` actually reads — the live-fold projection. */
const LIVE_FOLD_PROJECTION = {
  provider: 1,
  modelId: 1,
  actualModel: 1,
  actualProvider: 1,
  latencyMs: 1,
  ttftMs: 1,
  status: 1,
  errorKind: 1,
  errorSubReason: 1,
  stopReason: 1,
  outputTokens: 1,
  usagePartial: 1,
  fallbackUsed: 1,
  toolCallCount: 1,
  toolErrorCount: 1,
} as const

/**
 * Cache key for tokens-per-hour: every param that changes the aggregation, with
 * `to` floored to the minute so K admins whose `to = now` differ by seconds
 * collapse to one entry within the same minute (A4.5). `timeZone` is NOT in the
 * key — buckets are computed in UTC, only echoed for client-side rendering.
 */
function tokensPerHourCacheKey(query: AgentUsageQuery): string {
  return JSON.stringify({
    from: query.from.getTime(),
    to: floorToMinute(query.to.getTime()),
    groupBy: query.groupBy,
    timeMetric: query.timeMetric,
    collapseGroups: query.collapseGroups === true,
    userId: query.userId ?? null,
    agentId: query.agentId ?? null,
    workspaceId: query.workspaceId ?? null,
    provider: query.provider ?? null,
  })
}

export function createAgentUsageTokensPerHourHandler(db: Db) {
  // 60s server-side cache: the dashboard auto-refreshes at 60s and K admins fire
  // the same aggregation each tick (A4.5). Only the heavy `buckets` are cached;
  // `filters` is echoed per-request so each admin sees their own range back.
  const cache = new TtlCache<object[]>(60_000)
  return async function agentUsageTokensPerHour(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    // Admin view permite filtros vacíos (= "ver todo cross-tenant"). Coherente
    // con list-sessions y tool-executions-list que también usan `true`. Sólo
    // los handlers de workspace.* y user-api.* (cuando existan) forzarán scope.
    const query = parseQuery(rawData, { allowEmptyFilters: true })
    // 60s cache over the merged (rollup + live) result — the `to` is floored to
    // the minute in the key so K admins collapse to one aggregation (A4.5). The
    // maxTimeMS ceiling (A6.4) and the in-progress-hour live fold (TER-645/#2)
    // both live inside the cache-miss branch.
    const key = tokensPerHourCacheKey(query)
    let merged = cache.get(key) as TokensBucketRow[] | undefined
    if (!merged) {
      const pipeline = buildTokensPerHourPipeline(query)
      const collection = query.timeMetric === "userActive" ? "agent_usage_rollups_user_hourly" : "agent_usage_rollups_hourly"
      const buckets = (await db
        .collection(collection)
        .aggregate(pipeline, { maxTimeMS: ADMIN_MAX_TIME_MS })
        .toArray()) as unknown as TokensBucketRow[]

      let live: TokensBucketRow[] = []
      if (query.timeMetric === "agentActive") {
        const window = await fetchLiveWindowSessions(db, query)
        if (window) live = buildLiveTokensBuckets(window.sessions, query.groupBy, new Date())
      }
      merged = live.length ? mergeTokensBucketRows(buckets, live) : buckets
      cache.set(key, merged)
    }

    return { filters: query, buckets: merged, bucketTimeZone: query.timeZone, source: "rollup" as const }
  }
}

export function createAgentUsageListSessionsHandler(db: Db) {
  return async function agentUsageListSessions(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    const query = parseQuery(rawData, { allowEmptyFilters: true })
    const { filter, limit, skip } = buildSessionsListPipeline(query)
    const cursor = db
      .collection<AgentUsageSession>("agent_usage_sessions")
      .find(filter)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .maxTimeMS(ADMIN_MAX_TIME_MS)
    const items = await cursor.toArray()
    const result = query.format === "otel" ? items.map(toOtelGenAI) : items
    return { items: result, limit, skip }
  }
}

export function createAgentUsageToolExecutionsListHandler(db: Db) {
  return async function agentUsageToolExecutionsList(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    const query = parseQuery(rawData, { allowEmptyFilters: true })
    const { filter, limit, skip } = buildToolExecutionsListPipeline(query)
    const cursor = db
      .collection<ToolExecution>("tool_executions")
      .find(filter)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .maxTimeMS(ADMIN_MAX_TIME_MS)
    const items = await cursor.toArray()
    return { items, limit, skip }
  }
}

/**
 * The errorKind buckets that represent an UPSTREAM provider failure (Fireworks/
 * Together) — the ones mapped from the adapter's `errorClass`. `network_error`,
 * `tool_error`, etc. are Teros-side/user-side and excluded from the feed.
 */
const UPSTREAM_ERROR_KINDS = [
  "rate_limited",
  "overloaded",
  "server_error",
  "spend_gate",
  "auth_error",
  "model_unavailable",
] as const

/**
 * admin-api.agent-usage-upstream-errors (TER-700).
 *
 * Ops-facing feed of the most recent upstream provider errors — the surface that
 * carries the precise cause the USER never sees: `errorSubReason` (capacity vs
 * billing vs missing model) + the literal, PII-scrubbed `upstreamMessage`. Reads
 * errored sessions directly (not the rollup) so the literal text survives; the
 * aggregate `subReasonCounts` drives the KPI split, this drives the feed.
 */
export function createAgentUsageUpstreamErrorsHandler(db: Db) {
  return async function agentUsageUpstreamErrors(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    const query = parseQuery(rawData, { allowEmptyFilters: true })
    const limit = Math.min(typeof query.limit === "number" ? query.limit : 50, 200)

    const filter: Record<string, unknown> = {
      ...EXCLUDE_DEMO_SEED,
      status: "errored",
      errorKind: { $in: UPSTREAM_ERROR_KINDS },
      endedAt: { $gte: query.from, $lt: query.to },
    }
    if (query.userId) filter.userId = query.userId
    if (query.agentId) filter.agentId = query.agentId
    if (query.workspaceId) filter.workspaceId = query.workspaceId
    if (query.provider) filter.provider = query.provider

    const rows = await db
      .collection<AgentUsageSession>("agent_usage_sessions")
      .find(filter, {
        projection: {
          _id: 0,
          endedAt: 1,
          provider: 1,
          actualProvider: 1,
          modelId: 1,
          actualModel: 1,
          errorKind: 1,
          errorSubReason: 1,
          upstreamMessage: 1,
        },
      })
      .sort({ endedAt: -1 })
      .limit(limit)
      .maxTimeMS(ADMIN_MAX_TIME_MS)
      .toArray()

    const items = rows.map((s) => ({
      time: s.endedAt,
      provider: s.actualProvider ?? s.provider,
      model: s.actualModel ?? s.modelId,
      errorKind: s.errorKind,
      errorSubReason: s.errorSubReason,
      upstreamMessage: s.upstreamMessage,
    }))
    return { items, limit }
  }
}

/**
 * admin-api.agent-usage-model-health (TER-616 / F1).
 *
 * Per-`actualProvider×modelId` health for the model-observability window: p50/
 * p95/p99 latency + TTFT, error-rate by kind, success-rate and throughput,
 * distinguishing the real upstream (Fireworks vs Together) behind the logical
 * `provider` (C1).
 *
 * Merges the additive `modelHealth` histograms in Mongo (TER-668/A4.3): the
 * `$group` collapses the N range rollups into ONE `ModelHealthEntry` per model
 * BEFORE anything crosses to Node — the old path read every rollup unbounded and
 * merged in JS (~820 MB/request at scale → event-loop block/OOM). The tiny merged
 * result is combined with the live in-progress hour and summarized by the same
 * `aggregateModelHealth`, so percentiles are byte-identical to the JS path (proven
 * by the equivalence test). Percentiles are still derived only after the merge,
 * never averaged across hours. The `provider` filter scopes by the LOGICAL
 * provider; the response splits it by upstream.
 */
export function createAgentUsageModelHealthHandler(db: Db) {
  return async function agentUsageModelHealth(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    const query = parseQuery(rawData, { allowEmptyFilters: true })

    const mergedEntries = await db
      .collection<AgentUsageRollupHourly>("agent_usage_rollups_hourly")
      .aggregate<ModelHealthEntry>(buildModelHealthMergePipeline(buildModelHealthMatch(query)), {
        maxTimeMS: ADMIN_MAX_TIME_MS,
      })
      .toArray()
    const rollupSlice: Pick<AgentUsageRollupHourly, "modelHealth"> = {
      modelHealth: Object.fromEntries(
        mergedEntries.map((e) => [`${e.actualProvider}::${e.modelId}`, e]),
      ),
    }

    // Fold in the in-progress hour live (TER-645/#2) — it has no rollup yet, so
    // without this the user sees "no activity" while generating turns right now.
    // The Mongo-merged rollups + the live hour are both tiny, so this final
    // combine is cheap.
    const live = await loadLiveHourModelHealth(db, query)
    const slices: Pick<AgentUsageRollupHourly, "modelHealth">[] = live
      ? [rollupSlice, { modelHealth: live.modelHealth }]
      : [rollupSlice]

    const models = aggregateModelHealth(slices)

    // Throughput (F1.1): turns/min over the queried window. Derived here because
    // the pure aggregator doesn't know the range. `periodMinutes` is also
    // returned so the window can compute the request-weighted global rate from a
    // single source of truth rather than re-deriving it from the ISO strings.
    const periodMinutes = (query.to.getTime() - query.from.getTime()) / 60_000
    applyThroughputToSummaries(models, periodMinutes)

    // Enrich with the query-time thumbs tally (R4.4). The feedback arrives too
    // late for the hourly rollup, so it is joined here. Best-effort: a failure
    // (or a missing collection) leaves the models thumbs-less rather than
    // failing the whole query.
    try {
      applyThumbsToSummaries(models, await aggregateThumbs(db, query))
    } catch (err) {
      console.warn("[agent-usage-model-health] thumbs aggregation failed:", err)
    }

    // Upstream incident badge (R9). Best-effort + cached; `getUpstreamStatus`
    // never rejects, but the try keeps the query resilient regardless.
    let upstreamStatus: Awaited<ReturnType<typeof getUpstreamStatus>> | undefined
    try {
      upstreamStatus = await getUpstreamStatus()
    } catch {
      upstreamStatus = undefined
    }

    return { filters: query, models, periodMinutes, upstreamStatus, source: "rollup" as const }
  }
}

/**
 * Shared `$match` for the model-health queries: the hour range + the LOGICAL
 * group-key filters. Extracted so the point-in-time and the time-series handlers
 * scope IDENTICALLY — a divergence here would silently show one of them a
 * different (or broader) slice than the other.
 */
function buildModelHealthMatch(query: AgentUsageQuery): Record<string, unknown> {
  const match: Record<string, unknown> = {
    hourBucket: { $gte: query.from, $lt: query.to },
    ...EXCLUDE_DEMO_SEED,
  }
  if (query.userId) match["groupKey.userId"] = query.userId
  if (query.agentId) match["groupKey.agentId"] = query.agentId
  if (query.workspaceId) match["groupKey.workspaceId"] = query.workspaceId
  if (query.provider) match["groupKey.provider"] = query.provider
  return match
}

/**
 * Aggregate the IN-PROGRESS hour LIVE from `agent_usage_sessions` (TER-645/#2).
 *
 * The rollup job only writes CLOSED hours, so the current hour has no rollup —
 * the dashboard would read "no activity" while the user is generating turns
 * right now. We fold the sessions whose `startedAt ∈ [currentHour, to)` (scoped
 * exactly like the rollup match) into a synthetic `modelHealth` block. No
 * double-counting by construction: the current hour is never in the rollups (the
 * job only closes hours `< now`). Returns `null` when the range ends before the
 * current hour or no live sessions landed.
 */
async function loadLiveHourModelHealth(
  db: Db,
  query: AgentUsageQuery,
): Promise<{ hourBucket: Date; modelHealth: ReturnType<typeof buildModelHealthFromSessions> } | null> {
  const window = await fetchLiveWindowSessions(db, query)
  if (!window) return null
  return { hourBucket: window.hourBucket, modelHealth: buildModelHealthFromSessions(window.sessions) }
}

/**
 * Fetch the sessions of the IN-PROGRESS hour, scoped exactly like the rollup
 * match. Shared by the model-health AND tokens-per-hour live folds so the two
 * can never scope differently. Returns `null` when the range ends before the
 * current hour or no live sessions landed. No double-counting by construction:
 * the current hour is never in the rollups (the job only closes hours `< now`).
 */
async function fetchLiveWindowSessions(
  db: Db,
  query: AgentUsageQuery,
): Promise<{ hourBucket: Date; sessions: AgentUsageSession[] } | null> {
  const now = new Date()
  const currentHour = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()),
  )
  // Clip to the queried range: never aggregate sessions the user didn't ask for,
  // and skip entirely if the range ends before the current hour.
  const liveFrom = currentHour > query.from ? currentHour : query.from
  if (liveFrom >= query.to) return null

  const filter: Record<string, unknown> = {
    startedAt: { $gte: liveFrom, $lt: query.to },
    ...EXCLUDE_DEMO_SEED,
  }
  if (query.userId) filter.userId = query.userId
  if (query.agentId) filter.agentId = query.agentId
  if (query.workspaceId) filter.workspaceId = query.workspaceId
  if (query.provider) filter.provider = query.provider

  const sessions = await db
    .collection<AgentUsageSession>("agent_usage_sessions")
    .find(filter, { projection: LIVE_FOLD_PROJECTION })
    .maxTimeMS(ADMIN_MAX_TIME_MS)
    .toArray()
  if (sessions.length === 0) return null
  return { hourBucket: currentHour, sessions }
}

/**
 * admin-api.agent-usage-model-health-timeseries (F1.2).
 *
 * Same scope as `-model-health`, but returns one health snapshot PER HOUR
 * instead of one merged figure for the whole range — so the window can plot how
 * volume/health moved over time. Reads the additive `modelHealth` blocks and
 * aggregates each hour on its own (`aggregateModelHealthByHour`). The bucket is
 * UTC; `bucketTimeZone` is echoed so the frontend renders local times without
 * re-bucketing (same contract as `-tokens-per-hour`).
 */
export function createAgentUsageModelHealthTimeseriesHandler(db: Db) {
  return async function agentUsageModelHealthTimeseries(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    const query = parseQuery(rawData, { allowEmptyFilters: true })

    // Same server-side merge as -model-health but keyed by (hour, model) so each
    // hour stays its own point in the series (TER-668/A4.3).
    const mergedByHour = await db
      .collection<AgentUsageRollupHourly>("agent_usage_rollups_hourly")
      .aggregate<ModelHealthEntry & { hourBucket: Date }>(
        buildModelHealthMergePipeline(buildModelHealthMatch(query), { byHour: true }),
        { maxTimeMS: ADMIN_MAX_TIME_MS },
      )
      .toArray()
    const byHour = new Map<number, Record<string, ModelHealthEntry>>()
    for (const e of mergedByHour) {
      const t = e.hourBucket.getTime()
      const m = byHour.get(t) ?? {}
      m[`${e.actualProvider}::${e.modelId}`] = e
      byHour.set(t, m)
    }
    const slices: Pick<AgentUsageRollupHourly, "hourBucket" | "modelHealth">[] = [
      ...byHour.entries(),
    ].map(([t, modelHealth]) => ({ hourBucket: new Date(t), modelHealth }))

    // In-progress hour as its own (latest) bucket, live (TER-645/#2).
    const live = await loadLiveHourModelHealth(db, query)
    if (live) slices.push({ hourBucket: live.hourBucket, modelHealth: live.modelHealth })

    // Honor the query's groupBy (P5, 2026-07-07 audit): 'day' merges the
    // additive per-hour histograms before deriving percentiles, so 7d/30d
    // charts get exact daily figures instead of 720 sub-pixel hourly bars.
    const series = aggregateModelHealthByHour(slices, query.groupBy)
    return { filters: query, series, bucketTimeZone: query.timeZone, source: "rollup" as const }
  }
}

/**
 * admin-api.agent-usage-in-flight (F1.3).
 *
 * Live count of LLM streams currently in flight, per real upstream — read from
 * the in-memory process gauge (`@teros/core` inc/dec in the adapter's
 * `finally`), NOT from `sessions.status='running'` (a crashed turn would leave
 * that flag set forever and the gauge would only ever climb — MAYOR-3). It is
 * therefore a point-in-time snapshot of THIS backend instance; the frontend
 * polls it. `capturedAt` lets the UI show how fresh the reading is.
 */
export function createAgentUsageInFlightHandler(db: Db) {
  return async function agentUsageInFlight(ctx: WsHandlerContext, _rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    return {
      inflight: getInflightSnapshot(),
      total: getInflightTotal(),
      capturedAt: new Date().toISOString(),
    }
  }
}

/**
 * admin-api.agent-usage-session-detail (F2).
 *
 * Full drill-down of ONE turn: the session + its LLM calls + tool executions +
 * the message text behind each call + 👍/👎 + direct subagents, woven into a
 * chronological trace (`assembleSessionTrace`). This is what lets a turn be
 * inspected inside Teros instead of going to Latitude. Read-only, admin-gated.
 *
 * `messageId` joins `llm_usage` → `messages.info.id` (the logical id; the text
 * lives in `messages.parts[]`). Returns NOT_FOUND so the window can show a
 * dedicated empty state rather than an opaque error.
 *
 * When wired (`signalIndex`), the trace is decorated with Latitude's "known
 * signal" badge (F4·C1 — the return path). Best-effort and disposable: a miss,
 * an unwired index, or a projection hiccup all degrade to no badge, never to an
 * error (soberanía — Latitude down → product identical).
 */
export function createAgentUsageSessionDetailHandler(
  db: Db,
  signalIndex?: LatitudeSignalIndex | null,
) {
  return async function agentUsageSessionDetail(ctx: WsHandlerContext, rawData: unknown) {
    // Role, not just admin-vs-not: the conversation plaintext is super-only
    // (TER-671/A6.3). `getSystemRole` returns null for non-admins → treated as
    // forbidden, same as requireSystemAdmin.
    const role = await getSystemRole(db, ctx.userId)
    if (!role) {
      throw new HandlerError("FORBIDDEN", "Admin privileges required")
    }
    const redactText = role !== "super"

    const data = (rawData ?? {}) as Record<string, unknown>
    // sessionUsageId flows into a Mongo $match — coerce to a plain non-empty
    // string so an object can't smuggle in a query operator (NoSQL injection).
    const sessionUsageId = typeof data.sessionUsageId === "string" ? data.sessionUsageId.trim() : ""
    if (!sessionUsageId) {
      throw new HandlerError("INVALID_INPUT", "sessionUsageId is required")
    }

    const session = await db
      .collection<AgentUsageSession>("agent_usage_sessions")
      .findOne({ sessionUsageId }, { maxTimeMS: ADMIN_MAX_TIME_MS })
    if (!session) {
      throw new HandlerError("NOT_FOUND", `session ${sessionUsageId} not found`)
    }

    const [toolExecutions, llmUsages, descendants] = await Promise.all([
      db.collection<ToolExecution>("tool_executions").find({ sessionUsageId }).maxTimeMS(ADMIN_MAX_TIME_MS).toArray(),
      db.collection<LLMUsage>("llm_usage").find({ sessionUsageId }).maxTimeMS(ADMIN_MAX_TIME_MS).toArray(),
      db
        .collection<AgentUsageSession>("agent_usage_sessions")
        .find({ parentSessionUsageId: sessionUsageId })
        .maxTimeMS(ADMIN_MAX_TIME_MS)
        .toArray(),
    ])

    // Pull the assistant message text + feedback behind the LLM calls. The text
    // lives in `channel_messages` joined by `messageId` (NOT the empty/legacy
    // `messages` collection; verified by smoke). Skip the round-trip when there
    // are no messageIds.
    const messageIds = [...new Set(llmUsages.map((u) => u.messageId).filter(Boolean))]
    const [channelMessages, feedback] = await Promise.all([
      messageIds.length
        ? db
            .collection<TraceChannelMessage>("channel_messages")
            .find(
              { messageId: { $in: messageIds } },
              { projection: { messageId: 1, role: 1, content: 1, timestamp: 1 } },
            )
            .toArray()
        : Promise.resolve([] as TraceChannelMessage[]),
      messageIds.length
        ? db
            .collection<MessageFeedback>("message_feedback")
            .find({ messageId: { $in: messageIds } })
            .toArray()
        : Promise.resolve([] as MessageFeedback[]),
    ])

    // Resolve display names in the backend (2026-07-07 audit, P6 — repo
    // pattern: handlers return data with resolved names, the UI composes the
    // phrase). Best-effort: a missing/deleted entity just leaves the raw id.
    const agentIds = [...new Set([session.agentId, ...descendants.map((d) => d.agentId)])].filter(Boolean)
    const [agentDocs, userDoc, workspaceDoc] = await Promise.all([
      agentIds.length
        ? db
            .collection<{ agentId: string; name?: string; fullName?: string }>("agents")
            .find({ agentId: { $in: agentIds } }, { projection: { agentId: 1, name: 1, fullName: 1 } })
            .toArray()
        : Promise.resolve([] as { agentId: string; name?: string; fullName?: string }[]),
      session.userId
        ? db.collection("users").findOne({ userId: session.userId }, { projection: { profile: 1 } })
        : Promise.resolve(null),
      session.workspaceId
        ? db
            .collection("workspaces")
            .findOne({ workspaceId: session.workspaceId }, { projection: { name: 1 } })
        : Promise.resolve(null),
    ])
    const agentNameById = new Map<string, string>()
    for (const a of agentDocs) {
      const name = a.fullName || a.name
      if (name) agentNameById.set(a.agentId, name)
    }

    // Ledger-first (TER-671): record the access BEFORE returning the trace. A
    // write failure propagates so a private conversation is never read without
    // leaving an audit record ("no audit, no access").
    await recordSessionDetailAccess(db, {
      adminUserId: ctx.userId,
      role,
      sessionUsageId,
      textIncluded: !redactText,
    })

    const trace = assembleSessionTrace({
      session,
      toolExecutions,
      llmUsages,
      channelMessages,
      feedback,
      descendants,
      names: {
        agentNameById,
        userName:
          (userDoc as { profile?: { displayName?: string; email?: string } } | null)?.profile
            ?.displayName ||
          (userDoc as { profile?: { email?: string } } | null)?.profile?.email ||
          undefined,
        workspaceName: (workspaceDoc as { name?: string } | null)?.name || undefined,
      },
      redactText,
    })

    // Decorate with Latitude's clustered-failure badge, if any. The join key is
    // F3a's trace-wide `traceIdFor(rootSessionUsageId)` — the SAME 32-hex id the
    // export stamped and Latitude echoes back as a sampleTraceId (every session
    // in a delegation tree shares one root → one trace). Never let the disposable
    // projection break the core trace read.
    let latitudeSignal: LatitudeSignalBadge | null = null
    if (signalIndex) {
      try {
        const traceId = traceIdFor(session.rootSessionUsageId ?? sessionUsageId)
        latitudeSignal = await signalIndex.lookupByTraceIds([traceId])
      } catch {
        latitudeSignal = null
      }
    }

    return { ...trace, latitudeSignal }
  }
}

/**
 * Tally 👍/👎 per `actualProvider::modelId` over the range (TER-616/R4.4).
 *
 * `message_feedback` carries only the messageId, so we join `llm_usage` by
 * messageId to recover the upstream + model that produced the rated message,
 * then scope by the TURN's owner/agent/workspace (consistent with the rollup
 * query). The range filters the feedback's `createdAt` (thumbs given in the
 * window), since feedback lags the turn. Keyed exactly like the rollup so
 * `applyThumbsToSummaries` can merge by string equality.
 */
async function aggregateThumbs(db: Db, query: AgentUsageQuery): Promise<ThumbsByKey> {
  const usageScope: Record<string, unknown> = {}
  if (query.userId) usageScope["usage.userId"] = query.userId
  if (query.agentId) usageScope["usage.agentId"] = query.agentId
  if (query.workspaceId) usageScope["usage.workspaceId"] = query.workspaceId
  if (query.provider) usageScope["usage.provider"] = query.provider

  const pipeline: object[] = [
    { $match: { createdAt: { $gte: query.from, $lt: query.to } } },
    {
      $lookup: {
        from: "llm_usage",
        localField: "messageId",
        foreignField: "messageId",
        as: "usage",
      },
    },
    { $unwind: "$usage" },
    ...(Object.keys(usageScope).length ? [{ $match: usageScope }] : []),
    {
      $group: {
        _id: {
          ap: { $ifNull: ["$usage.actualProvider", "$usage.provider"] },
          m: { $ifNull: ["$usage.actualModel", "$usage.modelId"] },
        },
        up: { $sum: { $cond: [{ $eq: ["$rating", "up"] }, 1, 0] } },
        down: { $sum: { $cond: [{ $eq: ["$rating", "down"] }, 1, 0] } },
      },
    },
  ]

  const rows = await db
    .collection("message_feedback")
    .aggregate<{ _id: { ap: string; m: string }; up: number; down: number }>(pipeline, {
      maxTimeMS: ADMIN_MAX_TIME_MS,
    })
    .toArray()

  const out: ThumbsByKey = {}
  for (const r of rows) {
    if (!r._id?.ap || !r._id?.m) continue
    out[`${r._id.ap}::${r._id.m}`] = { up: r.up, down: r.down }
  }
  return out
}

/**
 * Cascading directory for the AgentUsageWindow filters. Returns ONLY the
 * users/agents/workspaces that are **accessible / coherent** with the
 * provided partial filters:
 *
 *   - Sin filtros → TODO el universo (super admin ve todo).
 *   - userId set → workspaces de los que es owner o member + agents en esos
 *     workspaces + agents globales (workspaceId:null) + el propio user.
 *   - workspaceId set → agents del workspace (+ globales) + members + owner.
 *   - agentId set → workspace del agent (si tiene) + users de ese workspace.
 *   - Múltiples filtros → intersección.
 *
 * Modelo de membership (verificado en workspace-service.ts:149):
 *   workspaces de un user = `{$or: [{ownerId}, {'members.userId'}]}`.
 *   members de un workspace = `ownerId` + `members[].userId`.
 *
 * Agents con `workspaceId:null` se consideran globales (Iria, Alice — los
 * cores system-wide). Siempre incluidos cuando el filtro lo permite.
 */
export function createAgentUsageListAccessibleEntitiesHandler(db: Db) {
  return async function agentUsageListAccessibleEntities(
    ctx: WsHandlerContext,
    rawData: unknown,
  ) {
    await requireSystemAdmin(db, ctx.userId)
    // Coerce raw ids to strings — parseQuery does this for every OTHER admin-api
    // handler; this one bypassed it, so `{ $ne: null }` widened the per-user
    // workspace scoping (A6.2 deep audit).
    const raw = (rawData ?? {}) as Record<string, unknown>
    const data = {
      userId: coerceIdFilter(raw.userId),
      agentId: coerceIdFilter(raw.agentId),
      workspaceId: coerceIdFilter(raw.workspaceId),
    }

    const usersCol = db.collection("users")
    const agentsCol = db.collection("agents")
    const workspacesCol = db.collection("workspaces")

    // Paso 1: resolver el set de workspaceIds compatible con los filtros.
    // null = no restricción (super admin sin filtros → todos los workspaces).
    let allowedWorkspaceIds: Set<string> | null = null
    const intersectIds = (next: string[]) => {
      const setNext = new Set(next)
      if (allowedWorkspaceIds === null) {
        allowedWorkspaceIds = setNext
      } else {
        allowedWorkspaceIds = new Set([...allowedWorkspaceIds].filter((id) => setNext.has(id)))
      }
    }

    if (data.workspaceId) {
      intersectIds([data.workspaceId])
    }
    if (data.userId) {
      const wsDocs = await workspacesCol
        .find(
          { $or: [{ ownerId: data.userId }, { "members.userId": data.userId }] },
          { projection: { workspaceId: 1 } },
        )
        .toArray()
      intersectIds(wsDocs.map((w: any) => w.workspaceId))
    }
    if (data.agentId) {
      const a: any = await agentsCol.findOne(
        { agentId: data.agentId },
        { projection: { workspaceId: 1 } },
      )
      // Si el agent es global (workspaceId null) no restringe; si tiene
      // workspace, restringe al suyo.
      if (a?.workspaceId) intersectIds([a.workspaceId])
    }

    // Paso 2: construir users/agents/workspaces resultantes.
    const wsFilter = allowedWorkspaceIds
      ? { workspaceId: { $in: [...allowedWorkspaceIds] } }
      : {}

    // Agents = los del workspace permitido + los globales (workspaceId null).
    const agentFilter = allowedWorkspaceIds
      ? {
          $or: [
            { workspaceId: { $in: [...allowedWorkspaceIds] } },
            { workspaceId: null },
            { workspaceId: { $exists: false } },
          ],
        }
      : {}

    const [agentDocs, workspaceDocs] = await Promise.all([
      agentsCol
        .find(agentFilter, {
          projection: { agentId: 1, name: 1, fullName: 1, workspaceId: 1 },
        })
        .toArray(),
      workspacesCol
        .find(wsFilter, { projection: { workspaceId: 1, name: 1, ownerId: 1, members: 1 } })
        .toArray(),
    ])

    // Si hay restricción de workspace, users = owners + members de esos
    // workspaces. Si no, users = todos.
    let userDocs: any[]
    if (allowedWorkspaceIds) {
      const userIdSet = new Set<string>()
      for (const w of workspaceDocs as any[]) {
        if (w.ownerId) userIdSet.add(w.ownerId)
        for (const m of w.members || []) {
          if (m?.userId) userIdSet.add(m.userId)
        }
      }
      userDocs =
        userIdSet.size > 0
          ? await usersCol
              .find(
                { userId: { $in: [...userIdSet] } },
                { projection: { userId: 1, profile: 1 } },
              )
              .toArray()
          : []
    } else {
      userDocs = await usersCol
        .find({}, { projection: { userId: 1, profile: 1 } })
        .toArray()
    }

    // Per-user effective agent-hours limit (TER-628): the dashboard's quota must
    // be each user's REAL plan limit, not a hardcoded 100. 0 = unmetered / no
    // active sub (the frontend falls back to a display default).
    const dirUserIds = (userDocs as any[]).map((u) => u.userId)
    const activeSubs = dirUserIds.length
      ? await getBillingSubscriptionsCollection(db)
          .find({ userId: { $in: dirUserIds }, status: "active" })
          .toArray()
      : []
    const dirPlanIds = [...new Set(activeSubs.map((s) => s.planId))]
    const dirPlans = dirPlanIds.length
      ? await getBillingPlansCollection(db)
          .find({ _id: { $in: dirPlanIds } })
          .toArray()
      : []
    const dirPlanById = new Map(dirPlans.map((p) => [p._id, p]))
    const limitByUser = new Map<string, number>()
    for (const s of activeSubs) {
      const plan = dirPlanById.get(s.planId)
      limitByUser.set(s.userId, plan ? getEffectiveLimit(s, plan) : 0)
    }

    return {
      users: (userDocs as any[]).map((u) => ({
        userId: u.userId,
        name: u.profile?.displayName || u.profile?.email || u.userId,
        agentHoursLimit: limitByUser.get(u.userId) ?? 0,
      })),
      agents: (agentDocs as any[]).map((a) => ({
        agentId: a.agentId,
        name: a.fullName || a.name || a.agentId,
      })),
      workspaces: (workspaceDocs as any[]).map((w) => ({
        workspaceId: w.workspaceId,
        name: w.name || w.workspaceId,
      })),
    }
  }
}

export function createAgentUsageHealthHandler(db: Db, deps: AgentUsageHealthDeps) {
  return async function agentUsageHealth(ctx: WsHandlerContext, _rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)
    const [buffer, reconcile, rollup] = await Promise.all([
      deps.buffer.getMetrics(),
      Promise.resolve(deps.reconciler.getMetrics()),
      Promise.resolve(deps.rollup.getMetrics()),
    ])
    return { buffer, reconcile, rollup }
  }
}

// Re-export for symmetry with createUsageSummaryHandler / friends.
export { HandlerError }
