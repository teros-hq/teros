/**
 * Shared shaping for the user-facing billing reads.
 *
 * Returns DATA (ids + resolved names + numbers), never UI strings — the frontend
 * composes copy. Used by billing.get-subscription and billing.change-plan so the
 * subscription shape is identical across both.
 */

import type { Db } from 'mongodb'
import {
  getActiveBoostHours,
  getBillingPlansCollection,
  getEffectiveLimit,
  type BillingSubscription,
} from '../../../models/billing.js'

export interface SubscriptionView {
  planId: string
  planName: string
  /** Effective monthly price (sub override wins over the plan list price). */
  price: number
  currency: string
  /** Effective hour limit for the period, including active boosts. */
  agentHoursLimit: number
  agentHoursUsed: number
  boostHours: number
  terosModel: boolean
  status: BillingSubscription['status']
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  scheduledPlanChange: { planId: string; planName: string; scheduledAt: string } | null
  teamId: string | null
}

export async function shapeSubscriptionView(
  db: Db,
  sub: BillingSubscription,
): Promise<SubscriptionView> {
  const plansCol = getBillingPlansCollection(db)
  const plan = await plansCol.findOne({ _id: sub.planId })

  // Only metered Teros plans carry boosts; skip the query otherwise (matches the
  // gate's getSubscriptionFeatures short-circuit).
  const baseLimit = plan ? getEffectiveLimit(sub, plan) : 0
  const boostHours =
    plan?.features.terosModel && baseLimit > 0
      ? await getActiveBoostHours(db, sub._id, new Date())
      : 0

  let scheduledPlanChange: SubscriptionView['scheduledPlanChange'] = null
  if (sub.scheduledPlanChange) {
    const scheduled = await plansCol.findOne({ _id: sub.scheduledPlanChange.planId })
    scheduledPlanChange = {
      planId: sub.scheduledPlanChange.planId,
      planName: scheduled?.displayName ?? sub.scheduledPlanChange.planId,
      scheduledAt: sub.scheduledPlanChange.scheduledAt.toISOString(),
    }
  }

  return {
    planId: sub.planId,
    planName: plan?.displayName ?? sub.planId,
    price: sub.customPrice ?? plan?.price ?? 0,
    currency: plan?.currency ?? 'EUR',
    agentHoursLimit: plan ? getEffectiveLimit(sub, plan, boostHours) : 0,
    agentHoursUsed: sub.agentHoursUsed,
    boostHours,
    terosModel: plan?.features.terosModel ?? false,
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
    scheduledPlanChange,
    teamId: sub.teamId ?? null,
  }
}
