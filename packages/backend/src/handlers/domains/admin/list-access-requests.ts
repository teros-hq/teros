/**
 * admin.list-access-requests — list billing access requests for the admin queue
 * (decision #10). Returns DATA (requests + resolved user/plan names + the
 * requester's live billing context), never UI strings. Admin/super only.
 *
 * Filters by status (default 'pending'); newest first, capped.
 *
 * Each row carries the requester's CURRENT subscription context so the admin can
 * judge an approval without opening another window: their active plan, hours
 * used / effective limit (incl. active boosts), % consumed, and — for a boost —
 * the market value of granting it (requestedHours × boostHourPrice). The grant
 * itself is free (it creates a boost, it does not charge); estimatedCost is the
 * what-it-would-cost-to-buy figure, surfaced only when a boost price is set.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import {
  getActiveBoostHours,
  getActiveSubscription,
  getBillingAccessRequestsCollection,
  getBillingPlansCollection,
  getEffectiveLimit,
  type BillingSubscription,
} from '../../../models/billing.js'

interface ListAccessRequestsData {
  status?: 'pending' | 'approved' | 'denied'
  limit?: number
}

/** Per-hour boost price config (same source as billing.purchase-boost). */
interface BoostPricingConfig {
  boostHourPrice: number | null
  boostCurrency: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function createListAccessRequestsHandler(
  userService: UserService,
  db: Db,
  pricing: BoostPricingConfig = { boostHourPrice: null, boostCurrency: 'EUR' },
) {
  return async function listAccessRequests(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const data = (rawData ?? {}) as ListAccessRequestsData
    const status = data.status ?? 'pending'
    if (status !== 'pending' && status !== 'approved' && status !== 'denied') {
      throw new HandlerError('INVALID_INPUT', "status must be 'pending', 'approved' or 'denied'")
    }
    const limit = Math.min(Math.max(1, Math.floor(data.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)

    const requests = await getBillingAccessRequestsCollection(db)
      .find({ status })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()

    const now = new Date()

    // Resolve each requester's CURRENT active subscription once (deduped by user).
    const userIds = [...new Set(requests.map((r) => r.userId))]
    const subByUser = new Map<string, BillingSubscription | null>()
    await Promise.all(
      userIds.map(async (uid) => {
        subByUser.set(uid, await getActiveSubscription(db, uid))
      }),
    )

    // Resolve plan display names for BOTH the requested plan (upgrades) and each
    // requester's current plan, in one deduped query.
    const planIds = [
      ...new Set(
        [
          ...requests.map((r) => r.requestedPlanId),
          ...[...subByUser.values()].map((s) => s?.planId ?? null),
        ].filter((p): p is string => !!p),
      ),
    ]
    const plans = planIds.length
      ? await getBillingPlansCollection(db).find({ _id: { $in: planIds } }).toArray()
      : []
    const planById = new Map(plans.map((p) => [p._id, p]))

    const { boostHourPrice, boostCurrency } = pricing

    const items = await Promise.all(
      requests.map(async (r) => {
        const user = await userService.getByUserId(r.userId)
        const sub = subByUser.get(r.userId) ?? null
        const currentPlan = sub ? planById.get(sub.planId) ?? null : null
        const requestedPlan = r.requestedPlanId ? planById.get(r.requestedPlanId) ?? null : null

        // Live billing context of the requester (null when no active sub).
        let currentPlanId: string | null = null
        let currentPlanName: string | null = null
        let agentHoursUsed: number | null = null
        let agentHoursLimit: number | null = null
        let usagePct: number | null = null
        if (sub) {
          const boostHours = await getActiveBoostHours(db, sub._id, now)
          const effectiveLimit = currentPlan
            ? getEffectiveLimit(sub, currentPlan, boostHours)
            : (sub.customAgentHoursLimit ?? 0) + boostHours
          currentPlanId = sub.planId
          currentPlanName = currentPlan?.displayName ?? currentPlan?.name ?? null
          agentHoursUsed = sub.agentHoursUsed ?? 0
          agentHoursLimit = effectiveLimit
          // Unmetered plans (limit 0 / contact-sales) have no meaningful %.
          usagePct = effectiveLimit > 0 ? Math.round((agentHoursUsed / effectiveLimit) * 100) : null
        }

        // What granting the requested hours would be worth at the boost price
        // (informational — the grant does not charge). Boost requests only, and
        // only when a price is configured.
        const estimatedCost =
          r.type === 'boost' &&
          typeof r.requestedHours === 'number' &&
          typeof boostHourPrice === 'number' &&
          boostHourPrice > 0
            ? r.requestedHours * boostHourPrice
            : null

        return {
          _id: r._id,
          userId: r.userId,
          userName: user?.profile?.displayName ?? null,
          userEmail: user?.profile?.email ?? null,
          type: r.type,
          requestedHours: r.requestedHours,
          requestedPlanId: r.requestedPlanId,
          requestedPlanName: requestedPlan?.displayName ?? requestedPlan?.name ?? null,
          reason: r.reason,
          status: r.status,
          resolvedBy: r.resolvedBy,
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
          resolutionNote: r.resolutionNote,
          boostId: r.boostId,
          createdAt: r.createdAt.toISOString(),
          // Requester's live billing context (decision A1).
          currentPlanId,
          currentPlanName,
          agentHoursUsed,
          agentHoursLimit,
          usagePct,
          estimatedCost,
          estimatedCostCurrency: boostCurrency,
        }
      }),
    )

    return { requests: items, status, count: items.length }
  }
}
