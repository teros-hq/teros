/**
 * user-api.my-usage-* — Self-service agent usage queries.
 *
 * Auth: only `ctx.userId` (no role check). The handler forces
 * `userId = ctx.userId` so a user can never query someone else's data.
 *
 * Default `triggerKind='user_message'` to hide autorun / scheduled / event
 * activity that the user didn't directly trigger (decision #8).
 *
 * Design doc: docs/usage-instrumentation.md §10
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import {
  buildSessionsListPipeline,
  buildTokensPerHourPipeline,
  parseQuery,
} from "../../../services/agent-usage-query-helper"
import { isNonBillableSession } from "../../../services/agent-usage-rollup-job"
import { EXCLUDE_DEMO_SEED } from "../../../services/agent-usage-demo-filter"
import { getActiveSubscription } from "../../../models/billing"
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

/**
 * user-api.my-usage-channels-summary — batch per-channel agent-hours for the
 * CURRENT BILLING PERIOD (WS2). One call answers the whole conversations list;
 * the UI surfaces (chat header chip, conversations row, task card, task detail)
 * all read from this endpoint via a shared caching hook.
 *
 * Semantics — MUST stay aligned with what the quota actually discounts:
 *   - workMs per channel = SUM of `durationMs` of that channel's BILLABLE
 *     sessions (decision #29: sum, never union — parallel agents each burn
 *     quota). NEVER union of intervals, NEVER raw durationMs without filters.
 *   - Billable = NOT `isNonBillableSession` (TER-650: `reconciled_timeout`
 *     zombies + failed sessions with `totalTokens === 0`), `startedAt !== null`
 *     AND `endedAt !== null` (an open/queued session has no final duration
 *     yet), not a demo seed.
 *   - Scope = the user's CURRENT billing period (`currentPeriodStart` of their
 *     active subscription) so the per-channel numbers line up with the quota
 *     that resets each period. With sum semantics, the total across channels
 *     equals the user's period usage (each session belongs to exactly one
 *     channel) — verified by tests.
 *   - Known accepted lag: the tracker bills CLOSED hour buckets, so this can
 *     lead `agentHoursUsed` by up to ~1h; it self-corrects.
 *
 * Auth: `userId` is ALWAYS forced to `ctx.userId` — a user can never query
 * someone else's usage, and `channelIds` only narrows which of THEIR OWN
 * channels come back.
 *
 * Input: `{ channelIds: string[] }` (empty/missing → `{}`).
 * Output: `{ [channelId]: { workMs: number, sessions: number } }` — channels
 * with no billable sessions in the period are simply absent from the map.
 */
export function createMyUsageChannelsSummaryHandler(db: Db) {
  return async function myUsageChannelsSummary(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as Record<string, unknown>
    const rawIds = Array.isArray(data.channelIds) ? data.channelIds : []
    // Sanitize: keep non-empty strings only, dedupe, cap the batch so a bad
    // client can't build an unbounded $in.
    const channelIds = [
      ...new Set(
        rawIds.filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ].slice(0, 500)

    // No active subscription → no billing period → nothing billable to report.
    const sub = await getActiveSubscription(db, ctx.userId)
    if (!sub || channelIds.length === 0) return { channels: {} }

    // One pass over the user's sessions of the requested channels since the
    // period start. The find() narrows to plausible candidates (the user's own
    // channels, execution-anchored, closed); the billable/not-billable decision
    // is made in JS with the EXPORTED isNonBillableSession — the same function
    // the rollup job uses — so this endpoint can never drift from billing
    // semantics (a duplicated $nor pipeline would).
    const cursor = db
      .collection<AgentUsageSession>("agent_usage_sessions")
      .find(
        {
          userId: ctx.userId,
          channelId: { $in: channelIds },
          startedAt: { $gte: sub.currentPeriodStart, $ne: null },
          endedAt: { $ne: null },
          ...EXCLUDE_DEMO_SEED,
        },
        {
          // Only what the filter + the sum need — keeps the pass cheap even for
          // heavy users (thousands of turns per period).
          projection: {
            channelId: 1,
            durationMs: 1,
            status: 1,
            errorKind: 1,
            totalTokens: 1,
          },
        },
      )

    const channels: Record<string, { workMs: number; sessions: number }> = {}
    try {
      for await (const session of cursor) {
        // TER-650 anti-phantom guard — identical to the rollup job's.
        if (isNonBillableSession(session)) continue
        const entry = channels[session.channelId] ?? { workMs: 0, sessions: 0 }
        entry.workMs += session.durationMs ?? 0
        entry.sessions += 1
        channels[session.channelId] = entry
      }
    } finally {
      await cursor.close()
    }

    return { channels, periodStart: sub.currentPeriodStart }
  }
}
