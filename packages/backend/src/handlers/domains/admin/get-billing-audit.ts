/**
 * admin.get-billing-audit
 *
 * Explains how a subscription's agentHoursUsed was formed, so the team can audit
 * an invoice or triage a billing incident. Returns DATA (ids + resolved names +
 * numbers), never UI strings — the frontend composes the view.
 *
 * Payload:
 *   - subscription:  the sub + effective limit + resolved plan/user names.
 *   - consumption:   a LIVE recompute of expected (rollups in period, up to the
 *                    billed cursor) vs actual (agentHoursUsed) + drift — the same
 *                    check the daily reconciliation cron runs, on demand.
 *   - ledgerEntries: the current period's append-only ledger commits (the
 *                    breakdown), oldest→newest, capped at `limit`.
 *   - snapshots:     recent closed-period snapshots (consumption at each close).
 *   - invoices:      recent invoices for the subscription.
 *
 * Admin/super only.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import {
  getActiveBoostHours,
  getActiveSubscription,
  getBillingHourBoostsCollection,
  getBillingHourLedgerCollection,
  getBillingInvoicesCollection,
  getBillingPeriodSnapshotsCollection,
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
  getEffectiveLimit,
  type BillingSubscription,
} from '../../../models/billing.js'

const HOUR_MS = 3_600_000
const DEFAULT_LEDGER_LIMIT = 200
const MAX_LEDGER_LIMIT = 1000
const HISTORY_LIMIT = 12

interface GetBillingAuditData {
  /** Resolve by subscription _id, or by the user's active sub when userId is given. */
  subscriptionId?: string
  userId?: string
  /** Max current-period ledger entries to return (default 200, max 1000). */
  limit?: number
}

export function createGetBillingAuditHandler(userService: UserService, db: Db) {
  return async function getBillingAudit(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = (rawData ?? {}) as GetBillingAuditData
    if (!data.subscriptionId && !data.userId) {
      throw new HandlerError('MISSING_FIELDS', 'subscriptionId or userId is required')
    }
    const limit = Math.min(
      Math.max(1, Math.floor(data.limit ?? DEFAULT_LEDGER_LIMIT)),
      MAX_LEDGER_LIMIT,
    )

    const subsCol = getBillingSubscriptionsCollection(db)
    const sub: BillingSubscription | null = data.subscriptionId
      ? await subsCol.findOne({ _id: data.subscriptionId })
      : await getActiveSubscription(db, data.userId as string)
    if (!sub) {
      throw new HandlerError('NOT_FOUND', 'Subscription not found')
    }

    const plan = await getBillingPlansCollection(db).findOne({ _id: sub.planId })
    // Effective limit reflects active boosts (decision #10) so a boosted user's
    // consumption is not mis-read as overage in the audit.
    const boostHours = await getActiveBoostHours(db, sub._id, new Date())
    const effectiveLimit = plan
      ? getEffectiveLimit(sub, plan, boostHours)
      : (sub.customAgentHoursLimit ?? 0) + boostHours
    const user = await userService.getByUserId(sub.userId)

    // Active boosts on the current period, for the audit breakdown.
    const activeBoosts = await getBillingHourBoostsCollection(db)
      .find({ subscriptionId: sub._id, status: 'active' })
      .sort({ createdAt: -1 })
      .toArray()

    // ── Live consumption recompute (same check as the reconciliation cron) ────
    const periodStart = sub.currentPeriodStart ?? new Date(0)
    const cutoff = sub.lastBilledHourBucket ?? null
    let expectedHours = 0
    if (cutoff) {
      const agg = (await db
        .collection('agent_usage_rollups_user_hourly')
        .aggregate([
          {
            $match: {
              'groupKey.userId': sub.userId,
              hourBucket: { $gt: periodStart, $lte: cutoff },
            },
          },
          { $group: { _id: null, totalMs: { $sum: '$userActiveMs' } } },
        ])
        .toArray()) as Array<{ totalMs: number }>
      expectedHours = (agg[0]?.totalMs ?? 0) / HOUR_MS
    }
    const actualHours = sub.agentHoursUsed ?? 0

    // ── Current-period ledger breakdown ──────────────────────────────────────
    const ledgerCol = getBillingHourLedgerCollection(db)
    const ledgerFilter = { subscriptionId: sub._id, hourBucket: { $gt: periodStart } }
    const ledgerCount = await ledgerCol.countDocuments(ledgerFilter)
    const ledgerDocs = await ledgerCol
      .find(ledgerFilter)
      .sort({ hourBucket: 1 })
      .limit(limit)
      .toArray()

    // ── History: recent snapshots + invoices ─────────────────────────────────
    const snapshots = await getBillingPeriodSnapshotsCollection(db)
      .find({ subscriptionId: sub._id })
      .sort({ periodStart: -1 })
      .limit(HISTORY_LIMIT)
      .toArray()
    const invoices = await getBillingInvoicesCollection(db)
      .find({ subscriptionId: sub._id })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .toArray()

    return {
      subscription: {
        _id: sub._id,
        userId: sub.userId,
        userName: user?.profile?.displayName ?? null,
        userEmail: user?.profile?.email ?? null,
        planId: sub.planId,
        planName: plan?.displayName ?? null,
        status: sub.status,
        agentHoursUsed: actualHours,
        agentHoursLimit: effectiveLimit,
        boostHours,
        overageHours: sub.overageHours ?? 0,
        currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        lastBilledHourBucket: sub.lastBilledHourBucket?.toISOString() ?? null,
      },
      activeBoosts: activeBoosts.map((b) => {
        // Origin discriminator (TER-686). Prefer the explicit `source`; fall back
        // to the legacy heuristic (accessRequestId non-null → access_request,
        // null → purchase) for rows written before the field existed. A direct
        // admin grant (source 'admin_grant', accessRequestId null) is NOT a
        // purchase — the old code mislabelled it as one.
        const source = b.source ?? (b.accessRequestId === null ? 'purchase' : 'access_request')
        return {
          _id: b._id,
          hours: b.hours,
          periodStart: b.periodStart.toISOString(),
          periodEnd: b.periodEnd.toISOString(),
          grantedBy: b.grantedBy,
          accessRequestId: b.accessRequestId,
          source,
          note: b.note ?? null,
          purchaseId: source === 'purchase' ? b._id : null,
          createdAt: b.createdAt.toISOString(),
        }
      }),
      consumption: {
        expectedHours,
        actualHours,
        driftHours: Math.abs(actualHours - expectedHours),
      },
      ledgerEntries: ledgerDocs.map((e) => ({
        hourBucket: e.hourBucket.toISOString(),
        fromHourBucket: e.fromHourBucket?.toISOString() ?? null,
        hoursAdded: e.hoursAdded,
        cumulative: e.cumulative,
        rollupCount: e.rollupCount,
        trackerRunId: e.trackerRunId,
        createdAt: e.createdAt.toISOString(),
      })),
      ledgerTotalCount: ledgerCount,
      ledgerTruncated: ledgerCount > ledgerDocs.length,
      snapshots: snapshots.map((s) => ({
        periodStart: s.periodStart.toISOString(),
        periodEnd: s.periodEnd.toISOString(),
        agentHoursUsed: s.agentHoursUsed,
        agentHoursLimit: s.agentHoursLimit,
        overageHours: s.overageHours,
        invoiceId: s.invoiceId,
        createdAt: s.createdAt.toISOString(),
      })),
      invoices: invoices.map((i) => ({
        _id: i._id,
        periodStart: i.periodStart.toISOString(),
        periodEnd: i.periodEnd.toISOString(),
        amount: i.amount,
        currency: i.currency,
        status: i.status,
        paymentMethod: i.paymentMethod,
        createdAt: i.createdAt.toISOString(),
      })),
    }
  }
}
